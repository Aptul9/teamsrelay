// OAuth for MCP clients (@better-auth/mcp), end to end on a temporary app.db: the web app's auth handler, its
// /.well-known route and its /mcp route on an HTTP server of this process (the token is checked against the JWKS read
// from the web app's own port), and a client scripted as Claude Code does it: registration, authorization with PKCE,
// sign-in, consent, token, then /mcp. A client revoked from Settings gets nothing more with the token it holds.
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getMigrations } from "better-auth/db/migration";
import { toNodeHandler } from "better-auth/node";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as wellKnown from "@/app/.well-known/[...path]/route";
import { POST } from "@/app/mcp/route";
import { appDb, migrateAppSchema } from "@/lib/appdb";
import { auth, authOptions } from "@/lib/auth";
import { clientsOf, consentGiven, revokeClient } from "@/lib/mcp/oauth";
import { syncEnvAdmin } from "@/server/env-admin";
import { tempDir } from "./helpers";

const EMAIL = "admin@teamsrelay.test";
const PASSWORD = "local-admin-password-123";
const REDIRECT = "http://127.0.0.1:43210/callback";
let server: http.Server;
let base: string;
let userId: string;

// Node request to the Fetch handler of a route, and back
function adapt(handler: (req: Request) => Promise<Response>) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await handler(new Request(base + req.url, { method: req.method, headers, body: body && req.method !== "GET" ? new Uint8Array(body) : undefined }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  };
}

beforeAll(async () => {
  const dir = tempDir();
  server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://localhost:${port}`;
  Object.assign(process.env, {
    APP_DB: path.join(dir, "app.db"),
    APP_URL: base,
    PORT: String(port),
    BETTER_AUTH_SECRET: "test-secret-for-the-oauth-flow-0123456789abcdef",
    ADMIN_EMAIL: EMAIL,
    ADMIN_PASSWORD: PASSWORD,
  });
  delete process.env.MCP_TOKEN;
  const { runMigrations } = await getMigrations(authOptions());
  await runMigrations();
  migrateAppSchema(appDb());
  await syncEnvAdmin();
  userId = appDb().prepare('SELECT id FROM "user" WHERE email=?').pluck().get(EMAIL) as string;
  const authNode = toNodeHandler(auth());
  const wk = adapt((req) => wellKnown.GET(req));
  const mcp = adapt(async (req) => POST(req, undefined));
  server.on("request", (req, res) => {
    const p = new URL(req.url ?? "/", base).pathname;
    if (p.startsWith("/api/auth/")) return void authNode(req, res);
    if (p.startsWith("/.well-known/")) return void wk(req, res);
    if (p === "/mcp") return void mcp(req, res);
    res.writeHead(404).end();
  });
});

afterAll(() => {
  server?.close();
});

const json = async (r: Response) => JSON.parse(await r.text()) as Record<string, unknown>;

async function register(body: Record<string, unknown>) {
  const r = await fetch(`${base}/api/auth/oauth2/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await json(r) };
}

// The whole authorization of a client registered as MCP SDK 1.x registers (no application_type): the token response
async function authorize(o: { accept?: boolean; resource?: boolean } = {}) {
  const reg = await register({ client_name: "Claude Code (test)", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  expect(reg.status).toBe(201);
  const clientId = String(reg.body.client_id);
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s1", scope: "openid offline_access" });
  if (o.resource !== false) q.set("resource", `${base}/mcp`);
  const a = await json(await fetch(`${base}/api/auth/oauth2/authorize?${q}`));
  const login = new URL(String(a.url), base);
  expect(login.pathname).toBe("/login");
  const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, oauth_query: login.search.slice(1) }),
  });
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const consentPage = new URL(String((await json(signIn)).url), base);
  expect(consentPage.pathname).toBe("/consent");
  const consent = await json(
    await fetch(`${base}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie },
      body: JSON.stringify({ accept: o.accept ?? true, oauth_query: consentPage.search.slice(1) }),
    }),
  );
  const back = new URL(String(consent.url));
  if (o.accept === false) return { clientId, back, token: "" };
  const t = await fetch(`${base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, ...(o.resource !== false ? { resource: `${base}/mcp` } : {}) }),
  });
  const token = String((await json(t)).access_token);
  return { clientId, back, token };
}

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
const mcpPost = (headers: Record<string, string>) =>
  fetch(`${base}/mcp`, { method: "POST", body: initialize, headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers } });

async function tools(token: string) {
  const client = new Client({ name: "vitest", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name).sort();
}

describe("discovery", () => {
  it("names the resource and its authorization server", async () => {
    const r = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [`${base}/api/auth`] });
  });

  it("serves the metadata of the authorization server where an MCP client looks for it", async () => {
    const m = await json(await fetch(`${base}/.well-known/oauth-authorization-server/api/auth`));
    expect(m).toMatchObject({
      issuer: `${base}/api/auth`,
      authorization_endpoint: `${base}/api/auth/oauth2/authorize`,
      token_endpoint: `${base}/api/auth/oauth2/token`,
      registration_endpoint: `${base}/api/auth/oauth2/register`,
      code_challenge_methods_supported: expect.arrayContaining(["S256"]),
    });
  });

  it("points a request with no token to that metadata: 401", async () => {
    const r = await mcpPost({});
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  });
});

describe("registration", () => {
  it("takes a client with a loopback redirect and no application_type as a native one", async () => {
    const r = await register({ client_name: "SDK 1.x", redirect_uris: ["http://localhost:5555/callback"], token_endpoint_auth_method: "none" });
    expect(r.status).toBe(201);
    expect(r.body.application_type).toBe("native");
  });

  it("leaves a web client with an https redirect as it is", async () => {
    const r = await register({ client_name: "claude.ai", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" });
    expect(r.status).toBe(201);
    expect(r.body.application_type).toBe("web");
  });
});

describe("authorization", () => {
  it("signs in, asks the consent, and gives a token of the user and the client that /mcp takes", async () => {
    const { clientId, back, token } = await authorize();
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("s1");
    expect(decodeJwt(token)).toMatchObject({ sub: userId, client_id: clientId, aud: expect.arrayContaining([`${base}/mcp`]) });
    expect(consentGiven(userId, clientId)).toBe(true);
    expect(await tools(token)).toEqual(["list_accounts", "list_activity", "list_chats", "read_chat", "refresh_chat"]);
    expect(clientsOf(userId).map((c) => c.clientId)).toContain(clientId);
  });

  it("sends the client back with access_denied on Deny", async () => {
    const { back } = await authorize({ accept: false });
    expect(back.searchParams.get("error")).toBe("access_denied");
  });

  it("refuses a token not made for /mcp", async () => {
    const { token } = await authorize({ resource: false });
    expect((await mcpPost({ Authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it("refuses a token from a web page: 403", async () => {
    const { token } = await authorize();
    expect((await mcpPost({ Authorization: `Bearer ${token}`, Origin: "https://example.com" })).status).toBe(403);
  });

  it("refuses the token of a client the user revoked, at once", async () => {
    const { clientId, token } = await authorize();
    expect((await mcpPost({ Authorization: `Bearer ${token}` })).status).toBe(200);
    revokeClient(userId, clientId);
    expect(consentGiven(userId, clientId)).toBe(false);
    expect(clientsOf(userId).map((c) => c.clientId)).not.toContain(clientId);
    const r = await mcpPost({ Authorization: `Bearer ${token}` });
    expect(r.status).toBe(401);
    expect(appDb().prepare("SELECT COUNT(*) FROM oauthRefreshToken WHERE clientId=? AND userId=?").pluck().get(clientId, userId)).toBe(0);
  });
});
