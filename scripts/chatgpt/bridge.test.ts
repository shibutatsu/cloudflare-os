import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createChatGptBridge, planPayload } from "./bridge.ts";

let directory: string;
let bridge: Awaited<ReturnType<typeof createChatGptBridge>>;
let issuer: string;
let nonce = "";
let tokenMode = "valid";
let streamMode = "complete";
let refreshCount = 0;
let revokeFails = false;
let capturedPayload: Record<string, unknown>;
let capturedGrant: URLSearchParams;
const key = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(key.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
const provider = createServer((req, res) => {
  void (async () => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts).toString();
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/.well-known/jwks.json") return res.end(JSON.stringify({ keys: [jwk] }));
    if (req.url === "/.well-known/openid-configuration") {
      return res.end(JSON.stringify({ revocation_endpoint: `${issuer}/revoke` }));
    }
    if (req.url === "/revoke") { res.statusCode = revokeFails ? 503 : 200; return res.end(); }
    if (req.url === "/api/accounts/oauth/token") {
      capturedGrant = new URLSearchParams(body);
      if (tokenMode === "invalid_grant") { res.statusCode = 400; return res.end(JSON.stringify({ error: "invalid_grant" })); }
      if (capturedGrant.get("grant_type") === "refresh_token") refreshCount++;
      const clientId = capturedGrant.get("client_id")!;
      let jwt = await new SignJWT({ nonce: tokenMode === "nonce" ? "wrong" : nonce, email: "example@example.test" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setSubject(tokenMode === "identity" ? "wrong-subject" : "test-user")
        .setIssuer(tokenMode === "issuer" ? "https://wrong.test" : issuer)
        .setAudience(tokenMode === "audience" ? "wrong-client" : clientId)
        .setIssuedAt().setExpirationTime(tokenMode === "expired" ? "-1h" : "1h").sign(key.privateKey);
      if (tokenMode === "signature") jwt = jwt.slice(0, -10) + "badbadbadb";
      return res.end(JSON.stringify({ access_token: "test-access", refresh_token: "test-refresh",
        id_token: jwt, token_type: "Bearer", expires_in: 3600,
        scope: tokenMode === "scope" ? "openid" : "openid chatgpt.tokens.use.direct" }));
    }
    if (req.headers.authorization !== "Bearer test-access") { res.statusCode = 401; return res.end(); }
    if (req.url === "/v1/models") return res.end(JSON.stringify({ models: [
      { slug: "test-model", display_name: "Test model", visibility: "list" },
      { slug: "hidden-model", display_name: "Hidden", visibility: "hidden" },
    ] }));
    if (req.url === "/v1/responses") {
      capturedPayload = JSON.parse(body);
      if (streamMode === "parameter") {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { code: "invalid_parameter", param: "prompt_cache_options", message: "private provider prose" } }));
      }
      res.setHeader("Content-Type", "text/event-stream");
      if (streamMode === "interrupted") return res.end('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
      if (streamMode === "limit") return res.end('data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n');
      if (streamMode === "incomplete") return res.end('data: {"type":"response.incomplete","response":{}}\n\n');
      return res.end('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    }
    res.statusCode = 404;
    res.end();
  })().catch(() => { res.statusCode = 500; res.end(); });
});

const headers = { Origin: "http://localhost:8787", "X-Cloudflare-OS": "1", "Content-Type": "application/json" };
const call = async (path: string, body?: object) => fetch(`${bridge.origin}/${path}`, {
  headers, method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
});
const login = async (accountId?: string) => {
  const response = await call("login", accountId ? { accountId } : {});
  const result = await response.json() as { url: string; attemptId: string };
  nonce = new URL(result.url).searchParams.get("nonce")!;
  return result;
};
const callback = (attemptId: string, clientId = "oaiapp_test") => fetch(
  `${bridge.origin}/auth/callback?${new URLSearchParams({ state: attemptId, code: "test-code", client_id: clientId })}`);
let accountId: string;
let proxyKey: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "cloudflare-os-chatgpt-"));
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("No address");
  issuer = `http://127.0.0.1:${address.port}`;
  bridge = await createChatGptBridge({ directory, port: 0, issuer, api: `${issuer}/v1` });
});
after(async () => {
  bridge.server.closeAllConnections();
  await new Promise<void>(resolve => bridge.server.close(() => resolve()));
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

test("management API rejects foreign/missing origins, simple requests, and DNS rebinding", async () => {
  for (const h of [{ Origin: "https://evil.test" }, {}, { Origin: headers.Origin }]) {
    assert.equal((await fetch(`${bridge.origin}/status`, { headers: h })).status, 403);
  }
  const rebound = await new Promise<number | undefined>(resolve => {
    httpRequest(`${bridge.origin}/status`, { headers: { ...headers, Host: "evil.test" } }, res => {
      res.resume(); resolve(res.statusCode);
    }).end();
  });
  assert.equal(rebound, 403);
  const status = await call("status");
  assert.equal(status.headers.get("access-control-allow-origin"), headers.Origin);
  assert.deepEqual(await status.json(), { accounts: [] });
});
test("state mismatch and cancellation never exchange an authorization code", async () => {
  const attempt = await login();
  assert.equal((await callback("wrong-state")).status, 400);
  assert.equal((await call("login", {})).status, 400);
  await call("attempt", { attemptId: attempt.attemptId, cancel: true });
  assert.equal((await callback(attempt.attemptId)).status, 400);
  assert.equal(capturedGrant, undefined);
});
for (const invalid of ["nonce", "issuer", "audience", "expired", "signature", "scope"]) {
  test(`rejects ${invalid} validation failure before storing credentials`, async () => {
    tokenMode = invalid;
    const attempt = await login();
    assert.equal((await callback(attempt.attemptId)).status, 400);
    assert.deepEqual(await (await call("status")).json(), { accounts: [] });
  });
}
test("PKCE registration stores validated identity with owner-only file permissions", async () => {
  tokenMode = "valid";
  const attempt = await login();
  const auth = new URL(attempt.url);
  assert.equal(auth.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal((await callback(attempt.attemptId)).status, 200);
  assert.equal(capturedGrant.get("client_id"), "oaiapp_test");
  assert.equal(capturedGrant.get("redirect_uri"), auth.searchParams.get("redirect_uri"));
  assert.ok(capturedGrant.get("code_verifier"));
  assert.equal((await callback(attempt.attemptId)).status, 400);
  const status = await (await call("status")).json() as { accounts: { id: string }[] };
  accountId = status.accounts[0].id;
  assert.equal(JSON.stringify(status).includes("test-access"), false);
  assert.equal((await stat(join(directory, "credentials.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});
test("account-specific model catalog excludes hidden models; unknown model cannot connect", async () => {
  const result = await (await call("models", { accountId })).json();
  assert.deepEqual(result, { models: [{ slug: "test-model", display_name: "Test model", visibility: "list" }] });
  assert.equal((await call("connection", { accountId, model: "hidden-model" })).status, 400);
  const conn = await (await call("connection", { accountId, model: "test-model" })).json() as { config: { apiToken: string; billingMode: string } };
  proxyKey = conn.config.apiToken;
  assert.notEqual(proxyKey, "test-access");
  assert.equal(conn.config.billingMode, "chatgpt-plan");
});
test("plan request preserves full history, groups tools, and omits unsupported fields", async () => {
  const payload = { model: "test-model", input: [{ role: "system", content: "system" }, { role: "user", content: "hi" }],
    tools: [{ type: "function", name: "executeCode", parameters: { type: "object" } }],
    max_output_tokens: 100, store: true, stream: false, temperature: 1, previous_response_id: "old",
    prompt_cache_options: { mode: "explicit" } };
  const response = await fetch(`${bridge.origin}/v1/responses`, { method: "POST",
    headers: { Authorization: `Bearer ${proxyKey}` }, body: JSON.stringify(payload) });
  assert.match(await response.text(), /response.completed/);
  assert.deepEqual(capturedPayload, { model: "test-model", input: [{ role: "developer", content: "system" }, { role: "user", content: "hi" }],
    store: false, stream: true, tools: [{ type: "namespace", name: "cloudflare_os", description: "Cloudflare OS local tools.", tools: payload.tools }] });
  assert.throws(() => planPayload({ model: "m", input: [], tools: [{ type: "tool_search" }] }));
});
for (const mode of ["interrupted", "limit", "incomplete"]) {
  test(`${mode} response cannot be reported as successful completion`, async () => {
    streamMode = mode;
    const response = await fetch(`${bridge.origin}/v1/responses`, { method: "POST",
      headers: { Authorization: `Bearer ${proxyKey}` }, body: JSON.stringify({ model: "test-model", input: [] }) });
    const text = await response.text();
    assert.match(text, /"type":"error"/);
    assert.doesNotMatch(text, /response.completed/);
    if (mode === "limit") assert.match(text, /Manage usage/);
  });
}
test("restart preserves identity and serializes concurrent token refresh", async () => {
  bridge.server.closeAllConnections();
  await new Promise<void>(resolve => bridge.server.close(() => resolve()));
  const file = join(directory, "credentials.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.accounts[0].tokens.expiresAt = 0;
  await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  bridge = await createChatGptBridge({ directory, port: 0, issuer, api: `${issuer}/v1` });
  const responses = await Promise.all([1, 2, 3].map(() => call("models", { accountId })));
  assert.ok(responses.every(r => r.ok));
  assert.equal(refreshCount, 1);
  const attempt = await login(accountId);
  assert.equal(new URL(attempt.url).searchParams.get("client_id"), "oaiapp_test");
  assert.equal(new URL(attempt.url).searchParams.get("ext_agent_host_id"), saved.hostId);
  tokenMode = "identity";
  assert.equal((await callback(attempt.attemptId)).status, 400);
  tokenMode = "valid";
});
test("logout clears tokens, refuses inference, and retains registration on revocation failure", async () => {
  revokeFails = true;
  assert.deepEqual(await (await call("logout", { accountId })).json(), { revoked: false });
  const result = await fetch(`${bridge.origin}/v1/responses`, { method: "POST",
    headers: { Authorization: `Bearer ${proxyKey}` }, body: '{}' });
  assert.equal(result.status, 401);
  const saved = JSON.parse(await readFile(join(directory, "credentials.json"), "utf8"));
  assert.equal(saved.accounts[0].tokens, undefined);
  const attempt = await login(accountId);
  assert.equal(new URL(attempt.url).searchParams.get("client_id"), "oaiapp_test");
  assert.equal(new URL(attempt.url).searchParams.has("id_token_hint"), false);
  assert.equal((await callback(attempt.attemptId)).status, 200);
});

 test("expired first code retains the issued registration for a fresh authorization", async () => {
  tokenMode = "invalid_grant";
  const first = await login();
  assert.equal((await callback(first.attemptId, "oaiapp_retry")).status, 400);
  const retry = await login();
  assert.equal(new URL(retry.url).searchParams.get("client_id"), "oaiapp_retry");
  tokenMode = "valid";
  assert.equal((await callback(retry.attemptId, "oaiapp_retry")).status, 200);
  const saved = JSON.parse(await readFile(join(directory, "credentials.json"), "utf8"));
  assert.equal(saved.pendingClientId, undefined);
});

test("HTTP rejection exposes only structured code and field, never provider prose", async () => {
  streamMode = "parameter";
  const response = await fetch(`${bridge.origin}/v1/responses`, { method: "POST",
    headers: { Authorization: `Bearer ${proxyKey}` }, body: JSON.stringify({ model: "test-model", input: [] }) });
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.match(text, /invalid_parameter \/ prompt_cache_options/);
  assert.doesNotMatch(text, /private provider prose/);
});

test("plan payload removes API cache breakpoints without altering prompt text or the caller's input", () => {
  const input = [{ role: "system", content: [{ type: "input_text", text: "literal prompt_cache_breakpoint", prompt_cache_breakpoint: { mode: "explicit" } }] }];
  const payload = planPayload({ model: "m", input, prompt_cache_options: { mode: "explicit" } });
  assert.deepEqual(payload.input, [{ role: "developer", content: [{ type: "input_text", text: "literal prompt_cache_breakpoint" }] }]);
  assert.equal(payload.prompt_cache_options, undefined);
  assert.ok(input[0].content[0].prompt_cache_breakpoint);
});
