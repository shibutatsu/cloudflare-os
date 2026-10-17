import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

const ISSUER = "https://auth.openai.com";
const API = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const random = () => randomBytes(32).toString("base64url");
const Tokens = z.object({
  accessToken: z.string(), refreshToken: z.string(), idToken: z.string(),
  expiresAt: z.number(), scopes: z.array(z.string()),
});
const Account = z.object({
  id: z.string(), clientId: z.string(), subject: z.string(), email: z.string(),
  proxyKey: z.string(), tokens: Tokens.optional(),
});
const State = z.object({ hostId: z.string(), accounts: z.array(Account), pendingClientId: z.string().optional() });
class InvalidGrantError extends Error {}
type Account = z.infer<typeof Account>;
const TokenResponse = z.object({
  access_token: z.string().min(1), refresh_token: z.string().optional(),
  id_token: z.string().optional(), expires_in: z.number().positive(),
  token_type: z.string().refine(v => v.toLowerCase() === "bearer"), scope: z.string().optional(),
});
type Attempt = {
  state: string; nonce: string; verifier: string; expiresAt: number;
  accountId?: string; clientId?: string; status: "pending" | "exchanging" | "complete" | "error";
  error?: string;
};

/** Enforce the documented ChatGPT HTTP request subset without changing API-key requests. */
export function planPayload(input: unknown): Record<string, unknown> {
  const body = z.record(z.string(), z.unknown()).parse(input);
  if (typeof body.model !== "string" || !Array.isArray(body.input)) {
    throw new Error("Model and message history are required.");
  }
  const result: Record<string, unknown> = { ...body, store: false, stream: true };
  for (const key of ["background", "conversation", "max_output_tokens", "max_tool_calls",
    "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention",
    "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user",
    "previous_response_id"]) delete (result as Record<string, unknown>)[key];
  body.input = body.input.map(item => {
    if (item && typeof item === "object" && "role" in item && item.role === "system") {
      return { ...item, role: "developer" };
    }
    return item;
  });
  result.input = body.input;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.map(tool => z.record(z.string(), z.unknown()).parse(tool));
    if (tools.some(tool => tool.type !== "function" && tool.type !== "custom")) {
      throw new Error("This tool is unavailable with the ChatGPT plan.");
    }
    result.tools = tools.length ? [{ type: "namespace", name: "cloudflare_os", tools }] : [];
  }
  return result;
}

/** A loopback-only, single-OS-user bridge. Overrides are dependency injection for isolated tests. */
export async function createChatGptBridge(options: {
  directory: string; port?: number; origins?: string[];
  issuer?: string; api?: string;
}) {
  const issuer = options.issuer ?? ISSUER;
  const api = options.api ?? API;
  const port = options.port ?? 1455;
  const origins = new Set(options.origins ?? ["http://localhost:8787", "http://127.0.0.1:8787",
    "http://localhost:3000", "http://127.0.0.1:3000"]);
  let ready = false;
  let callback = "";
  const server = createServer((req, res) => {
    if (!ready) { res.writeHead(503); res.end(); return; }
    void handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 502, { error: { message: "ChatGPT connection failed. Retry or sign in again." } });
      else res.destroy();
    });
  });
  // Claim the port before touching credentials, preventing simultaneous bridge processes.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback address.");
  const boundPort = address.port;
  callback = `http://127.0.0.1:${boundPort}/auth/callback`;
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await chmod(options.directory, 0o700);
  const file = join(options.directory, "credentials.json");
  let state: z.infer<typeof State>;
  try { state = State.parse(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      server.close();
      // oxlint-disable-next-line preserve-caught-error -- Parse errors may include credential contents.
      throw new Error("ChatGPT credential storage could not be read.");
    }
    state = { hostId: `urn:uuid:${randomUUID()}`, accounts: [] };
  }
  const save = async () => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, file);
  };
  await save();
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => {});
    return next;
  };
  const attempts = new Map<string, Attempt>();
  const active = new Map<string, Set<AbortController>>();
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const request = async (url: string, init?: RequestInit) => fetch(url, {
    ...init, signal: init?.signal ?? AbortSignal.timeout(30_000), redirect: "error",
  });
  const exchange = async (params: Record<string, string>) => {
    const response = await request(`${issuer}/api/accounts/oauth/token`, {
      method: "POST", body: new URLSearchParams({ ...params, resource: api }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string };
      if (error.error === "invalid_grant") throw new InvalidGrantError("ChatGPT authorization expired. Sign in again.");
      throw new Error(response.status < 500
      ? "ChatGPT authorization expired. Sign in again." : "ChatGPT is unavailable. Retry.");
    }
    return TokenResponse.parse(await response.json());
  };
  const credentials = async (account: Account) => exclusive(async () => {
    if (!account.tokens) throw new Error("ChatGPT is signed out. Sign in again.");
    if (account.tokens.expiresAt <= Date.now() + 60_000) {
      const response = await exchange({ grant_type: "refresh_token", client_id: account.clientId,
        refresh_token: account.tokens.refreshToken });
      const scopes = response.scope?.split(" ") ?? account.tokens.scopes;
      if (!scopes.includes("chatgpt.tokens.use.direct")) throw new Error("ChatGPT plan access is not enabled.");
      account.tokens = { accessToken: response.access_token,
        refreshToken: response.refresh_token ?? account.tokens.refreshToken,
        idToken: response.id_token ?? account.tokens.idToken,
        expiresAt: Date.now() + response.expires_in * 1000, scopes };
      await save();
    }
    return account.tokens.accessToken;
  });
  const getAccount = (id: unknown) => {
    const account = state.accounts.find(a => a.id === id);
    if (!account) throw new Error("Select a ChatGPT account.");
    return account;
  };
  const models = async (account: Account) => {
    const token = await credentials(account);
    const response = await request(`${api}/models`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`ChatGPT models unavailable (${response.status}). Retry or sign in again.`);
    const catalog = z.object({ models: z.array(z.object({
      slug: z.string(), display_name: z.string(), visibility: z.string(),
    })) }).parse(await response.json());
    return catalog.models.filter(m => m.visibility === "list");
  };
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const body = async (req: IncomingMessage) => {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of req) {
      size += part.length;
      if (size > 20 * 1024 * 1024) throw new Error("Request exceeds 20 MB.");
      parts.push(part);
    }
    return JSON.parse(Buffer.concat(parts).toString() || "{}");
  };
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (req.headers.host !== new URL(callback).host) return json(res, 403, { error: "Invalid host." });
    const url = new URL(req.url ?? "/", callback);
    if (url.pathname === "/auth/callback" && req.method === "GET") {
      const attempt = attempts.get(url.searchParams.get("state") ?? "");
      if (!attempt || attempt.expiresAt < Date.now() || attempt.status !== "pending") {
        return json(res, 400, { error: "Invalid or expired sign-in. Retry." });
      }
      attempt.status = "exchanging";
      let succeeded = false;
      try {
        await exclusive(async () => {
          if (url.searchParams.has("iss") && url.searchParams.get("iss") !== issuer) throw new Error("Invalid callback issuer.");
          if (url.searchParams.has("error")) throw new Error("ChatGPT sign-in cancelled.");
          const previous = attempt.accountId ? getAccount(attempt.accountId) : undefined;
          const clientId = url.searchParams.get("client_id") ?? attempt.clientId;
          if (!clientId || clientId === "dynamic_agent_client" ||
              (attempt.clientId && attempt.clientId !== clientId)) throw new Error("Invalid ChatGPT registration.");
          const code = url.searchParams.get("code");
          if (!code) throw new Error("Missing authorization code. Retry.");
          const response = await exchange({ grant_type: "authorization_code", client_id: clientId,
            code, code_verifier: attempt.verifier, redirect_uri: callback }).catch(async error => {
              if (!previous && error instanceof InvalidGrantError) {
                state.pendingClientId = clientId;
                await save();
              }
              throw error;
            });
          if (!response.id_token || !response.refresh_token) throw new Error("Incomplete ChatGPT authorization.");
          const { payload } = await jwtVerify(response.id_token, jwks, {
            issuer, audience: clientId, requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5,
          });
          if (payload.nonce !== attempt.nonce || !payload.sub ||
              (previous && previous.subject !== payload.sub)) throw new Error("ChatGPT account validation failed.");
          const scopes = response.scope?.split(" ") ?? [];
          if (!scopes.includes("chatgpt.tokens.use.direct")) throw new Error("ChatGPT plan access is not enabled.");
          const account = previous ?? state.accounts.find(a => a.clientId === clientId && a.subject === payload.sub) ?? {
            id: randomUUID(), clientId, subject: payload.sub,
            email: typeof payload.email === "string" ? payload.email : "ChatGPT account", proxyKey: random(),
          };
          account.tokens = { accessToken: response.access_token, refreshToken: response.refresh_token,
            idToken: response.id_token, expiresAt: Date.now() + response.expires_in * 1000, scopes };
          if (!state.accounts.includes(account)) state.accounts.push(account);
          if (state.pendingClientId === clientId) delete state.pendingClientId;
          await save();
          attempt.accountId = account.id;
          attempt.status = "complete";
        });
        succeeded = true;
      } catch (error) {
        attempt.status = "error";
        attempt.error = error instanceof Error && !(error instanceof z.ZodError)
          ? error.message : "ChatGPT sign-in failed. Retry.";
      }
      // No tokens, query parameters, or provider text are interpolated into the callback page.
      res.writeHead(succeeded ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Cloudflare OS</title><h1>${succeeded ? "ChatGPT connected" : "Sign-in failed"}</h1></html>`);
    }
    if (url.pathname === "/v1/responses" && req.method === "POST") {
      // No ambient browser authority: each saved model holds its account's independent local capability.
      const account = state.accounts.find(a => `Bearer ${a.proxyKey}` === req.headers.authorization);
      if (!account || !account.tokens) return json(res, 401, { error: { message: "ChatGPT is signed out. Sign in again." } });
      const controller = new AbortController();
      const controllers = active.get(account.id) ?? new Set<AbortController>();
      active.set(account.id, controllers);
      controllers.add(controller);
      res.on("close", () => controller.abort());
      try {
        const payload = planPayload(await body(req));
        const token = await credentials(account);
        const response = await request(`${api}/responses`, { method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]),
        });
        if (!response.ok || !response.body) return json(res, response.ok ? 502 : response.status,
          { error: { message: response.status === 429 ? "ChatGPT usage limit reached. Manage usage: https://chatgpt.com/settings/usage"
            : `ChatGPT request failed (${response.status}). Retry or sign in again.` } });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        let pending = "";
        let terminal = false;
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          pending = (pending + decoder.decode(chunk, { stream: true })).replaceAll("\r\n", "\n");
          let index: number;
          while ((index = pending.indexOf("\n\n")) >= 0) {
            const event = pending.slice(0, index);
            pending = pending.slice(index + 2);
            const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
            if (data && data !== "[DONE]") {
              const parsed = JSON.parse(data);
              if (["response.failed", "response.incomplete", "error"].includes(parsed.type)) {
                const code = parsed.response?.error?.code ?? parsed.error?.code ?? parsed.code;
                const limit = ["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"].includes(code);
                res.write(`data: ${JSON.stringify({ type: "error", code: "chatgpt_request_failed", message: limit
                  ? "ChatGPT usage limit reached. Manage usage: https://chatgpt.com/settings/usage"
                  : "ChatGPT response did not complete. Retry." })}\n\n`);
                terminal = true;
                return res.end();
              }
              if (parsed.type === "response.completed") terminal = true;
            }
            res.write(`${event}\n\n`);
          }
          if (pending.length > 8 * 1024 * 1024) throw new Error("Oversized stream event.");
        }
        if (!terminal) res.write(`data: ${JSON.stringify({ type: "error", code: "stream_interrupted", message: "ChatGPT stream interrupted. Retry." })}\n\n`);
        return res.end();
      } finally { controllers.delete(controller); }
    }
    const origin = req.headers.origin;
    if (!origin || !origins.has(origin)) return json(res, 403, { error: "Origin refused." });
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Cloudflare-OS");
      return res.end();
    }
    if (req.headers["x-cloudflare-os"] !== "1") return json(res, 403, { error: "Request refused." });
    try {
      if (url.pathname === "/status" && req.method === "GET") {
        return json(res, 200, { accounts: state.accounts.map(a => ({ id: a.id, email: a.email,
          label: `${a.email} · ${a.id.slice(0, 8)}`, connected: !!a.tokens })) });
      }
      if (url.pathname === "/login" && req.method === "POST") {
        const input = z.object({ accountId: z.string().optional() }).parse(await body(req));
        for (const [key, attempt] of attempts) if (attempt.expiresAt < Date.now()) attempts.delete(key);
        if ([...attempts.values()].some(a => a.status === "pending" || a.status === "exchanging")) {
          throw new Error("Sign-in already in progress. Cancel it first.");
        }
        const account = input.accountId ? getAccount(input.accountId) : undefined;
        const attempt: Attempt = { state: random(), nonce: random(), verifier: random(),
          expiresAt: Date.now() + 10 * 60_000, accountId: account?.id,
          clientId: account?.clientId ?? state.pendingClientId, status: "pending" };
        attempts.set(attempt.state, attempt);
        const auth = new URL(`${issuer}/api/accounts/authorize`);
        auth.search = new URLSearchParams({ client_id: attempt.clientId ?? "dynamic_agent_client",
          ...(account ? {} : { agent_name_hint: "Cloudflare OS" }),
          ...(account?.tokens ? { id_token_hint: account.tokens.idToken } : {}),
          ext_agent_host_id: state.hostId, response_type: "code", redirect_uri: callback,
          scope: SCOPE, resource: api, state: attempt.state, nonce: attempt.nonce,
          code_challenge_method: "S256", code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"),
        }).toString();
        return json(res, 200, { url: auth.toString(), attemptId: attempt.state });
      }
      if (url.pathname === "/attempt" && req.method === "POST") {
        const input = z.object({ attemptId: z.string(), cancel: z.boolean().optional() }).parse(await body(req));
        const attempt = attempts.get(input.attemptId);
        if (!attempt) throw new Error("Sign-in expired. Retry.");
        if ((input.cancel || attempt.expiresAt < Date.now()) && attempt.status === "pending") {
          attempt.status = "error";
          attempt.error = input.cancel ? "Sign-in cancelled." : "Sign-in expired. Retry.";
        }
        return json(res, 200, { status: attempt.status, accountId: attempt.accountId, error: attempt.error });
      }
      if (url.pathname === "/models" && req.method === "POST") {
        const input = z.object({ accountId: z.string() }).parse(await body(req));
        return json(res, 200, { models: await models(getAccount(input.accountId)) });
      }
      if (url.pathname === "/connection" && req.method === "POST") {
        const input = z.object({ accountId: z.string(), model: z.string() }).parse(await body(req));
        const account = getAccount(input.accountId);
        const model = (await models(account)).find(m => m.slug === input.model);
        if (!model) throw new Error("Select an available ChatGPT model.");
        return json(res, 200, {
          profile: { type: "agent", id: `chatgpt:${account.id}:${model.slug}`, name: `ChatGPT · ${model.display_name}` },
          config: { provider: "openai", model: model.slug, apiToken: account.proxyKey,
            apiUrl: `http://127.0.0.1:${boundPort}/v1`, billingMode: "chatgpt-plan" },
        });
      }
      if (url.pathname === "/logout" && req.method === "POST") {
        const input = z.object({ accountId: z.string() }).parse(await body(req));
        const account = getAccount(input.accountId);
        for (const controller of active.get(account.id) ?? []) controller.abort();
        const revoked = await exclusive(async () => {
          let confirmed = !account.tokens;
          if (account.tokens) {
            try {
              const discovery = await request(`${issuer}/.well-known/openid-configuration`);
              const config = z.object({ revocation_endpoint: z.string().url() }).parse(await discovery.json());
              if (new URL(config.revocation_endpoint).origin !== issuer) throw new Error("Invalid revocation endpoint.");
              for (let i = 0; i < 2; i++) {
                const result = await request(config.revocation_endpoint, { method: "POST", body: new URLSearchParams({
                  token: account.tokens.refreshToken, token_type_hint: "refresh_token", client_id: account.clientId,
                }) });
                if (result.ok) { confirmed = true; break; }
                if (result.status < 500) break;
                await new Promise(resolve => setTimeout(resolve, 250));
              }
            } catch { /* Local sign-out still stops requests; the UI reports unconfirmed revocation. */ }
          }
          delete account.tokens;
          await save();
          return confirmed;
        });
        return json(res, 200, { revoked });
      }
      return json(res, 404, { error: "Not found." });
    } catch (error) {
      return json(res, 400, { error: error instanceof z.ZodError ? "Invalid request." :
        error instanceof Error ? error.message : "ChatGPT request failed." });
    }
  }
  ready = true;
  return { server, origin: `http://127.0.0.1:${boundPort}` };
}
