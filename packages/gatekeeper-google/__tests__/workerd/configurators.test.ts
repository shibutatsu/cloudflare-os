import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessTokenRequest } from "../../src/auth-retry";
import {
  calendarPickerRank, hasCalendarPrivateAccessRole, hasCalendarWriteRole,
} from "../../src/calendar-api";
import {
  BigQueryConfiguratorUI, CalendarConfiguratorUI, DriveConfiguratorUI,
} from "../../src/google-configurators";
import type { GoogleAccessToken } from "../../src/google-api";
import { FOLDER_MIME_TYPE as FOLDER, SHORTCUT_MIME_TYPE as SHORTCUT } from "../../src/drive-api";

const token = (value: string): GoogleAccessToken => ({
  token: value,
  expires: new Date(Date.now() + 3600_000),
});

afterEach(() => vi.unstubAllGlobals());

describe("Google resource configurators", () => {
  it("resolves the primary Calendar alias to its stable ID", async () => {
    let getToken = vi.fn(async () => token("access-token"));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "person@example.com",
      summary: "Primary calendar",
      primary: true,
    })));

    await expect(new CalendarConfiguratorUI(getToken).getPrimaryCalendarId())
      .resolves.toBe("person@example.com");
  });

  describe("Drive picker", () => {
    const picker = () => new DriveConfiguratorUI(async () => token("access-token"));

    /** Answers each Drive request from `routes` by path, recording every URL asked for. */
    const stubDrive = (routes: Record<string, unknown>) => {
      const calls: URL[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        calls.push(url);
        const path = url.pathname.replace(/^\/drive\/v3/, "");
        return path in routes
          ? Response.json(routes[path])
          : Response.json({ error: { code: 404, message: "File not found" } }, { status: 404 });
      }));
      return calls;
    };

    // My Drive's root can be bound only by its real ID: the folder scope refuses the `root` alias.
    it("opens on the account's groupings, with My Drive by its real ID", async () => {
      stubDrive({ "/files/root": { id: "0AMyRoot", name: "My Drive" } });

      await expect(picker().listDriveNodes("drive", "", null)).resolves.toEqual({
        nodes: [
          { id: "folder:0AMyRoot", title: "My Drive", kind: "folder", listable: true },
          { id: "shared-drives", title: "Shared drives", kind: "group" },
          { id: "shared-with-me", title: "Shared with me", kind: "group" },
        ],
      });
    });

    it("lists a folder's children folders first, a shortcut standing for its target", async () => {
      const calls = stubDrive({
        "/files": {
          nextPageToken: "page-3",
          files: [
            { id: "sub", name: "Plans", mimeType: FOLDER, capabilities: { canListChildren: true } },
            { id: "locked", name: "Archive", mimeType: FOLDER, capabilities: { canListChildren: false } },
            {
              id: "doc", name: "Notes", mimeType: "application/vnd.google-apps.document",
              modifiedTime: "2026-10-01T10:00:00Z",
            },
            {
              id: "link", name: "Team folder", mimeType: SHORTCUT,
              shortcutDetails: { targetId: "team", targetMimeType: FOLDER },
            },
            { id: "dangling", name: "Gone", mimeType: SHORTCUT, shortcutDetails: {} },
          ],
        },
      });

      await expect(picker().listDriveNodes("folder:F1", "", "page-2")).resolves.toEqual({
        nodes: [
          { id: "folder:sub", title: "Plans", kind: "folder", listable: true },
          { id: "folder:locked", title: "Archive", kind: "folder", listable: false },
          {
            id: "file:doc", title: "Notes", kind: "file", mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-10-01T10:00:00Z",
          },
          { id: "folder:team", title: "Team folder", kind: "folder", listable: true },
        ],
        nextCursor: "page-3",
      });
      expect(calls[0].searchParams.get("q")).toBe("trashed = false and 'F1' in parents");
      expect(calls[0].searchParams.get("corpora")).toBe("allDrives");
      expect(calls[0].searchParams.get("orderBy")).toBe("folder,name");
      expect(calls[0].searchParams.get("pageToken")).toBe("page-2");
    });

    it("lists the shared drives and what is shared with this account", async () => {
      const calls = stubDrive({
        "/drives": { drives: [{ id: "0ADrive", name: "Engineering" }] },
        "/files": { files: [{ id: "s1", name: "Budget", mimeType: "application/pdf" }] },
      });
      const browser = picker();

      await expect(browser.listDriveNodes("shared-drives", "", null)).resolves.toEqual({
        nodes: [{ id: "folder:0ADrive", title: "Engineering", kind: "sharedDrive" }],
      });
      await expect(browser.listDriveNodes("shared-with-me", "", null)).resolves.toEqual({
        nodes: [{ id: "file:s1", title: "Budget", kind: "file", mimeType: "application/pdf" }],
      });
      expect(calls[1].searchParams.get("q")).toBe("trashed = false and sharedWithMe = true");
    });

    // Search spans every corpus wherever the picker is open, so each result says whose it is.
    it("searches every drive by name, saying where each result lives", async () => {
      const calls = stubDrive({
        "/files": {
          files: [
            { id: "mine", name: "Team plans", mimeType: FOLDER, capabilities: { canListChildren: true } },
            { id: "theirs", name: "Team budget", owners: [{ displayName: "Ada" }] },
            { id: "in-drive", name: "Team drive notes", driveId: "drive-1" },
          ],
        },
      });

      const { nodes } = await picker().listDriveNodes("folder:F1", "Team", null);

      expect(nodes.map(node => [node.id, node.detail])).toEqual([
        ["folder:mine", "My Drive"],
        ["file:theirs", "Ada"],
        ["file:in-drive", "In a shared drive"],
      ]);
      expect(calls[0].searchParams.get("corpora")).toBe("allDrives");
      expect(calls[0].searchParams.get("q")).toBe("trashed = false and name contains 'Team'");
    });

    // Duplicate names are ordinary, and a shared file can be named to look like one of the user's
    // own, so without a differentiator the user cannot see which capability they are granting. A
    // unique name needs none.
    it("tells apart nodes whose names look the same", async () => {
      const long = "x".repeat(240);
      const names = ["Budget", "Budget\u200e", "budget\u200b", "Budget plan", `${long}A`, `${long}B`];
      stubDrive({
        "/files": {
          files: [
            ...names.map((name, index) => ({ id: `id${index}`, name })),
            { id: "1AbCdEfGhIjKlMnOpQrStUv_platform", name: "Engineering", driveId: "d1" },
          ],
        },
      });

      const { nodes } = await picker().listDriveNodes("drive", "Budget", null);

      expect(nodes.map(node => node.detail)).toEqual([
        "My Drive · id0", "My Drive · id1", "My Drive · id2", "My Drive", "My Drive · id4",
        "My Drive · id5", "In a shared drive",
      ]);
    });

    it("finds a pre-filled file with the folders it lives in", async () => {
      stubDrive({
        "/files/F9": { id: "F9", name: "Q3.pdf", mimeType: "application/pdf", parents: ["A"] },
        "/files/A": { id: "A", name: "Reports", mimeType: FOLDER, parents: ["0AMyRoot"] },
        "/files/0AMyRoot": { id: "0AMyRoot", name: "My Drive", mimeType: FOLDER },
        "/files/root": { id: "0AMyRoot", name: "My Drive", mimeType: FOLDER },
      });

      await expect(picker().getDriveNode("file:F9")).resolves.toEqual({
        id: "file:F9", title: "Q3.pdf", kind: "file", mimeType: "application/pdf",
        path: [{ id: "folder:0AMyRoot", title: "My Drive" }, { id: "folder:A", title: "Reports" }],
      });
    });

    it("places a pre-filled folder in its shared drive", async () => {
      stubDrive({
        "/files/D2": {
          id: "D2", name: "Specs", mimeType: FOLDER, driveId: "0ADrive", parents: ["0ADrive"],
          capabilities: { canListChildren: true },
        },
        "/files/0ADrive": { id: "0ADrive", name: "Engineering", mimeType: FOLDER, driveId: "0ADrive" },
      });

      await expect(picker().getDriveNode("folder:D2")).resolves.toMatchObject({
        id: "folder:D2",
        path: [{ id: "shared-drives", title: "Shared drives" }, { id: "folder:0ADrive", title: "Engineering" }],
      });
    });

    // A partial path would show the node somewhere it is not.
    it("leaves out the path of a file shared from a folder this account cannot see", async () => {
      stubDrive({ "/files/S1": { id: "S1", name: "Shared", mimeType: "text/plain", parents: ["hidden"] } });

      const node = await picker().getDriveNode("file:S1");

      expect(node).toMatchObject({ id: "file:S1" });
      expect(node).not.toHaveProperty("path");
    });

    it("finds nothing for an id naming the wrong kind of node, or one this account cannot see", async () => {
      stubDrive({ "/files/D1": { id: "D1", name: "A folder", mimeType: FOLDER } });
      const browser = picker();

      await expect(browser.getDriveNode("file:D1")).resolves.toBeNull();
      await expect(browser.getDriveNode("folder:missing")).resolves.toBeNull();
      await expect(browser.getDriveNode("shared-drives")).resolves.toBeNull();
    });
  });

  it("offers every calendar the account can write, including limited writers", async () => {
    let getToken = vi.fn(async () => token("access-token"));
    let requestUrl: URL | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requestUrl = new URL(input instanceof Request ? input.url : input);
      return Response.json({ items: [] });
    }));

    await new CalendarConfiguratorUI(getToken).listCalendars("");

    expect(requestUrl?.searchParams.get("minAccessRole")).toBe("writerWithoutPrivateAccess");
  });

  // A limited writer can edit the calendar but not see private events, so it may be chosen as a
  // binding target yet must not be admitted as an observer of one.
  it("separates write access from private-event access only for limited writers", () => {
    const calendar = (accessRole: string) => ({
      id: "shared@example.com", summary: "Shared", accessRole,
    } as Parameters<typeof hasCalendarWriteRole>[0]);

    for (const role of ["owner", "writer"]) {
      expect(hasCalendarWriteRole(calendar(role))).toBe(true);
      expect(hasCalendarPrivateAccessRole(calendar(role))).toBe(true);
    }
    expect(hasCalendarWriteRole(calendar("writerWithoutPrivateAccess"))).toBe(true);
    expect(hasCalendarPrivateAccessRole(calendar("writerWithoutPrivateAccess"))).toBe(false);
    for (const role of ["reader", "freeBusyReader", "none"]) {
      expect(hasCalendarWriteRole(calendar(role))).toBe(false);
      expect(hasCalendarPrivateAccessRole(calendar(role))).toBe(false);
    }
    expect(calendarPickerRank(calendar("writerWithoutPrivateAccess")))
      .toBeLessThan(calendarPickerRank(calendar("reader")));
  });

  it.each([
    ["owner", true],
    ["writer", true],
    ["writerWithoutPrivateAccess", true],
    ["reader", false],
  ] as const)("reports %s access accurately for an exact calendar", async (accessRole, expected) => {
    let getToken = vi.fn(async () => token("access-token"));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "shared@example.com",
      summary: "Shared calendar",
      accessRole,
    })));

    await expect(new CalendarConfiguratorUI(getToken).canWriteCalendar("shared@example.com"))
      .resolves.toBe(expected);
  });

  it("treats inaccessible exact calendars as unavailable", async () => {
    let getToken = vi.fn(async () => token("access-token"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    await expect(new CalendarConfiguratorUI(getToken).canWriteCalendar("private@example.com"))
      .resolves.toBe(false);
  });

  it("surfaces transient exact-calendar failures", async () => {
    let getToken = vi.fn(async () => token("access-token"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 500 })));

    await expect(new CalendarConfiguratorUI(getToken).canWriteCalendar("shared@example.com"))
      .rejects.toThrow("Google Calendar API request failed: 500");
  });

  it("does not mistake a quota 403 for missing Calendar access", async () => {
    let getToken = vi.fn(async () => token("access-token"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limit", { status: 403 })));

    await expect(new CalendarConfiguratorUI(getToken).canWriteCalendar("shared@example.com"))
      .rejects.toThrow("Google Calendar API request failed: 403");
  });

  it("refreshes a rejected Calendar access token", async () => {
    let getToken = vi.fn(async (opts?: AccessTokenRequest) =>
      token(opts?.forceRefresh ? "fresh" : "stale"));
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      let authorization = new Headers(init?.headers).get("Authorization");
      if (authorization === "Bearer stale") {
        return Response.json({ error: { code: 401 } }, { status: 401 });
      }
      return Response.json({
        items: [{ id: "person@example.com", summary: "Primary calendar", primary: true }],
      });
    }));

    await expect(new CalendarConfiguratorUI(getToken).listCalendars(""))
      .resolves.toEqual([{
        value: "person@example.com",
        title: "Primary calendar",
        subtitle: "Primary calendar",
        meta: undefined,
      }]);
    expect(getToken.mock.calls).toEqual([
      [undefined],
      [{ forceRefresh: true, staleToken: "stale" }],
    ]);
  });

  it("reloads a widened BigQuery access token after a scope 403", async () => {
    let getToken = vi.fn(async (opts?: AccessTokenRequest) =>
      token(opts?.reloadStored ? "widened" : "narrow"));
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      let authorization = new Headers(init?.headers).get("Authorization");
      if (authorization === "Bearer narrow") {
        return Response.json({ error: { code: 403 } }, { status: 403 });
      }
      return Response.json({
        projects: [{
          id: "project-1",
          friendlyName: "Project One",
          projectReference: { projectId: "project-1" },
        }],
      });
    }));

    await expect(new BigQueryConfiguratorUI(getToken).listProjects(""))
      .resolves.toEqual([{
        value: "project-1",
        title: "project-1",
        subtitle: "Project One",
      }]);
    expect(getToken.mock.calls).toEqual([
      [undefined],
      [{ reloadStored: true }],
    ]);
  });
});
