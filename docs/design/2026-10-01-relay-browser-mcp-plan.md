# A browser on the relay computer through /mcp: implementation plan

Spec: [2026-10-01-relay-browser-mcp.md](2026-10-01-relay-browser-mcp.md). Branch `feat/relay-browser-mcp` from `main` `56a375e`, spec commit `819bb44`. Tasks run in order, each red first, each its own commit.

**Goal:** an MCP client signed in with OAuth drives a browser of its own on the computer of a relay joined to the server: tabs, search, snapshot, clicks, screenshots, through `/mcp`.

**Architecture:** the relay hosts `@playwright/mcp` in its process and opens a websocket to the server; every request from the server and every answer passes an allowlist in the relay. A hub preloaded in the web app process holds one socket per account and forwards one call at a time; the `/mcp` route adds the browser tools of the user's connected relays to the read tools, for OAuth tokens of `@better-auth/mcp` only.

**Tech stack:** `@playwright/mcp` 0.0.83 (its own Playwright 1.64 alpha), `ws` 8 hub, undici `WebSocket` on the relay, better-auth 1.7.7 with `jwt()` and `@better-auth/mcp` 1.7.7, `@modelcontextprotocol/server` 2.1.0 (`fromJsonSchema`), vitest, better-sqlite3.

## Changes to the spec from the spikes (2026-10-01)

- **Relay to Playwright MCP.** The relay is the MCP client of the Playwright MCP server, in process, and initializes the session itself without the `roots` capability (Playwright MCP would ask the client for its roots and take the first one as its working directory). The websocket carries JSON-RPC `tools/list` and `tools/call` requests from the hub and their answers; any other method is refused by the allowlist. The `/mcp` route is stateless and has no session to forward.
- **The relay launches the AI browser.** `createConnection` without a context leaves the browser running when its server closes. The relay passes a context getter that launches a persistent context on `<STATE_DIR>/ai-profile` with the Playwright that `@playwright/mcp` brings (its nested `playwright-core`, never the relay's 1.63), so it can close it after the idle time and at stop. That launch also skips Playwright MCP's `browser.bind()` (a named pipe and an entry in the Playwright server registry).
- **Files on the relay disk.** Actions answer without a page snapshot (`snapshot: { mode: "none" }`): otherwise Playwright MCP writes each snapshot to a file and answers its path. `browser_take_screenshot` still saves every screenshot as a PNG in `<STATE_DIR>/ai-output`, whatever the arguments; the folder is capped at 20 MB (`outputMaxSize`) and emptied when the browser closes. No tool takes a path from the client (`filename` refused).
- **Sizes.** A viewport screenshot of a Wikipedia page answers 358 KB, a full-page one 3.9 MB, a snapshot 178 KB. The socket takes messages up to 32 MB; the relay answers a larger result with a tool error instead of sending it.
- **Registration.** `@better-auth/oauth-provider` registers a client without `application_type` as a web client, and a web client may not use an `http://localhost` redirect: MCP SDK 1.x clients send none. A before-hook on `/oauth2/register` sets `native` when every redirect URI is plain HTTP on `localhost`, `127.0.0.1` or `[::1]`.
- **Discovery.** The issuer is `<APP_URL>/api/auth`, so the authorization server metadata is at `/.well-known/oauth-authorization-server/api/auth` and the protected resource metadata at `/.well-known/oauth-protected-resource/mcp`; a route of the web app answers `/.well-known/*` through better-auth.
- **Revocation.** Access tokens are JWTs checked against the JWKS, valid until they expire (1 h). A client is revoked from Settings: its consent, access and refresh tokens of that user are deleted, and `/mcp` refuses any token whose user has no consent row for its client. The JWKS is read over loopback from the web app's own port, never through the public address.

## Global constraints

- No port opens on the relay computer. The allowlist runs in the relay. The Teams browser and its profile are never touched by these tools.
- Browser tools for OAuth tokens only, one token per client. `MCP_TOKEN` keeps the five read tools.
- `RELAY_BROWSER` off by default; only `RELAY_BROWSER=1` in `relay.env` turns it on.
- Allowed tools: `browser_navigate`, `browser_navigate_back`, `browser_tabs`, `browser_snapshot`, `browser_find`, `browser_take_screenshot`, `browser_click`, `browser_hover`, `browser_drag`, `browser_type`, `browser_press_key`, `browser_fill_form`, `browser_select_option`, `browser_handle_dialog`, `browser_wait_for`, `browser_resize`, `browser_close`, `browser_console_messages`. Everything else refused, including `browser_run_code_unsafe` and `browser_evaluate`.
- URLs given to `browser_navigate` and to `browser_tabs` `new`: `http:` and `https:` only, no `localhost`, `*.localhost`, `127.0.0.0/8`, `0.0.0.0`, `[::1]` or IPv4-mapped loopback.
- Exact versions in `package.json`; better-auth and `@better-auth/*` move together. Windows installs with `npm ci --ignore-scripts`.
- `@playwright/mcp` external to `dist/relay.cjs`, like `playwright-core` and `better-sqlite3`; `node dist/relay.cjs --check` stays ok.
- One preload bundle for both hubs: `dist/call-audio.cjs`, so the image command and the deploy do not change.
- Conventional Commits, no AI trailer; PR body empty.

---

### Task 1: relay allowlist

**Files:** `app/src/local/browser-allowlist.ts` (new); test `app/test/local/browser-allowlist.test.ts` (new).

**Produces:** `BROWSER_TOOLS: readonly string[]`; `type RpcRequest = { jsonrpc: "2.0"; id: number | string; method: string; params?: Record<string, unknown> }`; `screenRequest(msg: unknown): { ok: true; request: RpcRequest } | { ok: false; reply: object | null }` (`reply` null for a message with no id); `screenTools(result: unknown): { tools: object[] }`; `refusedUrl(url: unknown): string | null` (the reason, null when allowed).

- [ ] Tests (table): every allowed tool passes `tools/call` with plain arguments; each left-out tool of the 0.0.83 list (`browser_run_code_unsafe`, `browser_evaluate`, `browser_file_upload`, `browser_drop`, `browser_network_requests`, `browser_network_request`, `browser_emulate_media`, an unknown name) refused with a tool error naming it; `filename` on any tool refused; `browser_navigate` and `browser_tabs` `new` refuse `file:`, `chrome:`, `about:`, `javascript:`, `data:`, `localhost`, `foo.localhost`, `127.0.0.1`, `127.1`, `0x7f.1`, `0.0.0.0`, `[::1]`, `[::ffff:127.0.0.1]`, a URL that does not parse; accept `https://www.wikipedia.org/`; `initialize`, `ping`, `resources/list` and a notification refused (JSON-RPC error, or nothing to answer); a message that is not an object refused; `screenTools` keeps the allowed tools only and removes `filename` from `properties` and `required`.
- [ ] Run `npx vitest run test/local/browser-allowlist.test.ts`: fails.
- [ ] Implement; passes. Commit `feat(relay): allowlist of the browser tools`.

### Task 2: Playwright MCP host and the relay socket

**Files:** `app/src/local/browser-host.ts` (new), `app/src/local/browser-link.ts` (new), `app/src/local/config.ts` (`RELAY_BROWSER`, `RELAY_BROWSER_IDLE`), `app/src/local/main.ts`, `app/src/shared/relay-sync.ts` (`RELAY_BROWSER_PATH`), `app/package.json` (`build:relay` gets `--external:@playwright/mcp`), `app/relay.env.example`; tests `app/test/local/browser-host.test.ts`, `app/test/local/browser-link.test.ts`, `app/test/local/config.test.ts` (new cases).

**Consumes:** `screenRequest`, `screenTools` (task 1).

**Produces:** `RELAY_BROWSER_PATH = "/api/relay/browser/socket"`; `MAX_BROWSER_MESSAGE = 32 * 1024 * 1024`; `Config.browser: { profileDir: string; outputDir: string; idleMs: number } | null` (null unless `RELAY_BROWSER=1` and a server joined); `class BrowserHost { constructor(o: { profileDir; outputDir; channel; idleMs; load?: () => Promise<McpModule> }); request(method: "tools/list" | "tools/call", params): Promise<unknown>; get open(): boolean; close(): Promise<void> }`; `class BrowserLink { constructor(o: { url; token; host: Pick<BrowserHost, "request" | "close">; open?: (url, token) => LinkSocket }); start(): void; stop(): Promise<void> }`.

- [ ] Tests, host (fake Playwright MCP module with a fake `createConnection` and context getter): `initialize` sent once without `roots`, `notifications/initialized` after it; `tools/list` and `tools/call` forwarded, answers matched by id; no browser until the first `tools/call`; after `idleMs` with no call the context closes, the server closes and the output folder is emptied; the next call launches again; `close()` closes both; a call in progress keeps the browser open past the idle time.
- [ ] Tests, link (fake socket): opens `ws(s)://<server>/api/relay/browser/socket` with `Authorization: Bearer <token>`; a refused request answers the allowlist reply and never reaches the host (`browser_run_code_unsafe`, `browser_evaluate`, `filename`, `initialize`); an allowed one goes to the host and its answer comes back with the same id; `tools/list` answer passes `screenTools`; an answer over 32 MB becomes a tool error; calls run one at a time in arrival order; a dropped socket opens again after 1 s, then 2, 4... up to 30 s, back to 1 s after an open; `stop()` closes the socket and the host and opens nothing more.
- [ ] Tests, config: `RELAY_BROWSER` unset or `0` gives `browser: null`; `1` with a server gives the folders under `STATE_DIR` and `idleMs` 900 000; `RELAY_BROWSER_IDLE=5` gives 5000; `1` without `SERVER_URL` is a config error naming both.
- [ ] Run the three test files: fail.
- [ ] Implement; main starts the link when `config.browser` is set and stops it in `close`; `--check` loads `@playwright/mcp`. Pass. `npm run build:relay && node dist/relay.cjs --check`. Commit `feat(relay): a browser of its own for MCP clients, over a socket to the server`.

### Task 3: browser hub and GET /api/relay/browser

**Files:** `app/src/server/browser-hub.ts` (new), `app/src/server/call-audio-preload.ts` (attaches both hubs), `app/src/app/api/relay/browser/route.ts` (new), `app/src/lib/browser-hub.ts` (new: the `globalThis` handle as the routes see it); tests `app/test/browser-hub.test.ts` (new), `app/test/relay-browser-route.test.ts` (new).

**Consumes:** `RELAY_BROWSER_PATH`, `MAX_BROWSER_MESSAGE` (task 2), `requireRelay` (`src/lib/relay.ts`).

**Produces:** `attachBrowserHub(server, o?: { check?: (req) => Promise<number | null>; callTimeoutMs?: number }): { close(): void }`; on `globalThis.__teamsRelayBrowserHub`: `type BrowserHub = { tools(slot: number): BrowserTool[] | null; call(slot: number, name: string, args: Record<string, unknown>): Promise<ToolResult> }`; `browserHub(): BrowserHub | null` in `src/lib/browser-hub.ts`; `GET /api/relay/browser` answers `{ slot }` for a relay token, 401 otherwise, 403 with an `Origin`.

- [ ] Tests, hub (real `ws` server on loopback, fake check): an upgrade the check refuses gets 403 and no socket; the hub asks `tools/list` at once and `tools(slot)` gives it; a newer socket of the same slot replaces the older (the older closed, its pending call answered as an error); calls of one slot run one at a time; a call with no answer within the limit (100 ms in the test) answers a tool error and the next call goes; `tools(slot)` null once the socket closes; a call with no socket answers a tool error naming the account; the handle is on `globalThis`.
- [ ] Tests, route: relay token gives its slot; no token, a wrong one, a container account: 401; `Origin`: 403.
- [ ] Run both: fail. Implement; pass. `npm run build:hub`. Commit `feat(web): hub of the relay browsers`.

### Task 4: OAuth for MCP clients

**Files:** `app/package.json` (`better-auth` 1.7.7, `@better-auth/mcp` 1.7.7: done in the spike install), `app/src/lib/auth.ts` (`jwt()`, `mcp()`, register hook), `app/src/lib/mcp/oauth.ts` (new: `MCP_RESOURCE`, `oauthClaims`, `consentGiven`, `revokeClient`, `clientsOf`), `app/src/app/.well-known/[...path]/route.ts` (new), `app/src/app/consent/page.tsx` (new), `app/src/components/OAuthConsent.tsx` (new), `app/src/components/LoginForm.tsx` (follows the redirect of a sign-in with `oauth_query`), `app/src/lib/auth-client.ts` (`oauthProviderClient()`), `app/src/app/mcp/route.ts` (OAuth path); tests `app/test/mcp-oauth.test.ts` (new), `app/test/consent-page.test.ts` (new, Chrome), `app/test/mcp-route.test.ts`.

**Produces:** `MCP_RESOURCE = <APP_URL>/mcp`; `consentGiven(userId, clientId): boolean`; `revokeClient(userId, clientId): void`; `clientsOf(userId): { clientId; name; since }[]`; `/mcp` handler takes `MCP_TOKEN` as before or an OAuth token and builds `mcpServer(userId, { clientId })`.

- [ ] Tests, flow (better-auth on a temporary `app.db`, its handler on a loopback port as the web app serves it): registration without `application_type` with `http://127.0.0.1:<port>/callback` gets 201 as `native`; with an `https://` redirect stays web; `/.well-known/oauth-protected-resource/mcp` names `<APP_URL>/mcp` and `<APP_URL>/api/auth`; `/.well-known/oauth-authorization-server/api/auth` names the endpoints; authorize without a session sends to `/login` with a signed query; sign-in with that `oauth_query` sends to `/consent`; consent `accept: true` gives a code; token with PKCE and `resource` is a JWT with `sub`, `client_id`; `/mcp` with it lists the five read tools; without a token 401 with `resource_metadata`; after `revokeClient` the same token gets 401; `accept: false` gives `error=access_denied` to the redirect; a token of another resource (no `resource`) refused.
- [ ] Tests, consent page (Chrome): names the client and the account signing in; Allow posts `accept: true` with the page query; Deny `accept: false`; a query without `sig` shows an error and no buttons.
- [ ] Tests, `/mcp`: `MCP_TOKEN` path unchanged (existing file passes); with `MCP_TOKEN` unset an OAuth token still works and no token gets 401, not 404; an OAuth token with an `Origin` header gets 403.
- [ ] Run: fail. Implement; pass. Commit `feat(web): OAuth sign-in for MCP clients`.

### Task 5: browser tools on /mcp

**Files:** `app/src/lib/appdb.ts` (`browser_actions` table, `teams_accounts.browser_off`, `logBrowserAction`, `browserActionsOf`, `setBrowserOff`), `app/src/lib/mcp/browser.ts` (new), `app/src/lib/mcp/server.ts` (`mcpServer(userId, o?: { clientId?: string })` registers browser tools for OAuth), `app/src/app/mcp/route.ts`; tests `app/test/mcp-browser.test.ts` (new), `app/test/appdb.test.ts`.

**Consumes:** `browserHub()` (task 3), `oauth` claims (task 4).

**Produces:** `browserAccounts(userId): number[]`; `callBrowserTool(o: { userId; clientId; slot: unknown; name; args }): Promise<ToolResult>`; table `browser_actions(id INTEGER PRIMARY KEY, ts INTEGER, user_id TEXT, client_id TEXT, slot INTEGER, tool TEXT, host TEXT, outcome TEXT)`; column `browser_off INTEGER NOT NULL DEFAULT 0`.

- [ ] Tests (fake hub on `globalThis`, MCP client over the route): OAuth token, owner with a connected relay: tools are the five plus the relay's tools, each with `account` required and the slots named in its description; `MCP_TOKEN`: five tools only, `browser_navigate` by name answers unknown tool; no relay connected: five tools; call on a slot of another user: error "Account not found" and no row; slot not a relay account, relay offline, `browser_off`, account stopped: tool error naming the account, row with the outcome; allowed call: forwarded without `account`, answer as it came (image content kept), row with tool, host of the URL for `browser_navigate` and `browser_tabs`, outcome `ok` or `error`; `browserActionsOf` gives the last 50, newest first.
- [ ] Run: fail. Implement; pass. Commit `feat(web): browser tools of the relay on /mcp`.

### Task 6: settings of the browser and of the MCP clients

**Files:** `app/src/app/api/accounts/[slot]/browser/route.ts` (new: `GET` actions and switch, `PATCH {off}`), `app/src/app/api/oauth/clients/route.ts` (new: `GET`), `app/src/app/api/oauth/clients/[id]/route.ts` (new: `DELETE`), `app/src/components/Settings.tsx` (per relay account: switch and last 50 actions; card "AI clients" with Revoke); tests `app/test/browser-settings-routes.test.ts` (new), `app/test/browser-settings.test.ts` (new, Chrome page).

- [ ] Tests: owner reads the switch and the actions, another user 404; `PATCH {off: true}` sets `browser_off`, `false` clears it, anything else 400; clients list names and dates, Revoke deletes consent and tokens of that user only; page shows the actions as time, client, tool, host, outcome, the switch calls the route, Revoke asks first.
- [ ] Run: fail. Implement; pass. Commit `feat(web): browser actions, stop switch and AI clients in Settings`.

### Task 7: Caddy

**Files:** `caddy/Caddyfile`; test `app/test/compose-image.test.ts` (Caddyfile reaches the web app for `/.well-known/*`).

- [ ] `/.well-known/*` already falls to `handle { reverse_proxy webapp:8090 }`: test that no handle before it catches it. `caddy validate` in a throwaway `caddy:2` container when Docker is up. Commit `chore(caddy): OAuth discovery reaches the web app` only if the file changes.

### Task 8: docs and checks

**Files:** `docs/mcp.md`, `docs/security.md`, `docs/setup.md`, `docs/configuration.md`, `docs/limitations.md`, `docs/api.md`, the spec (changes above), `app/relay.env.example`.

- [ ] Docs. Full suite, eslint, tsc, build, `dist/relay.cjs --check`, `dist/agent.cjs --check`. Live E2E (scripted OAuth client, B's relay with `RELAY_BROWSER=1`). Commit `docs: browser of the relay through /mcp`. Push, PR.
