# A browser on the relay computer, driven by an AI client through the server

Date: 2026-10-01. Relay joined to the server: [2026-09-27-relay-joins-server.md](2026-09-27-relay-joins-server.md), MCP server: [2026-09-26-mcp-server.md](2026-09-26-mcp-server.md), websocket of the call sound: [2026-09-29-call-audio-in-app.md](2026-09-29-call-audio-in-app.md).

**Goal:** an MCP client (Claude Code, opencode, a claude.ai connector) opens tabs, searches and reads pages in a browser on the computer of a relay joined to the server, through the `/mcp` endpoint of the server. The relay keeps opening every connection; nothing listens on its computer.

## What exists

- The relay dials out only: sync every second (`src/local/server-link.ts`), commands by a 25 s long poll (`COMMANDS_WAIT_MS`), the call sound over a websocket to the hub preloaded in the web app process (`src/server/call-audio-hub.ts`, `GET /api/call/audio` says who may open which side).
- The relay browser is one Playwright persistent context on the relay profile, headful (`src/local/browser.ts`). The agent drives the first Teams tab (`pickTeamsPage`) and leaves other tabs alone while one exists.
- The Teams page reads as visible and focused through an init script (`page-state.ts`), but the relay launches its browser without `--disable-background-timer-throttling`: a second tab in the front of the same window throttles the timers of the Teams tab.
- `/mcp` serves five read tools to one bearer, `MCP_TOKEN`, acting as the administrator of `.env` ([mcp.md](../mcp.md)). No OAuth: claude.ai connectors cannot use it.
- `@playwright/mcp` 0.0.83 (Microsoft) exports `createConnection(config, contextGetter?)`, an MCP server object over any transport, on top of `playwright-core/lib/coreBundle`. Each release pins a Playwright alpha (0.0.83: `1.64.0-alpha-1790635538000`); the relay runs `playwright-core` 1.63.0. Its HTTP mode (`--port`) has no authentication, and its README calls it "not a security boundary". Its core tools include `browser_run_code_unsafe` ("RCE-equivalent": JavaScript in the process that hosts it), `browser_evaluate`, `browser_file_upload` and `browser_drop` (files of the local disk); the `storage` capability reads and writes cookies.
- better-auth 1.7.6 carries no OAuth server. `@better-auth/mcp` 1.7.7 (peer `better-auth ^1.7.7`) makes the web app an OAuth 2.1 authorization server for MCP clients: PKCE, RFC 8414 and RFC 9728 metadata, optional dynamic client registration, routes guarded by `requireMcpAuth` (access token checked against the JWKS, no database call).

## Decision

2026-10-01, owner:

- The AI client is an MCP client of the server's `/mcp`; no model runs on the server.
- The browser tools are those of `@playwright/mcp`, hosted inside the relay process. Its MCP messages travel over a websocket the relay opens to the server. The server checks who calls and which account, and forwards.
- The browser is a second browser on a profile of its own (`STATE_DIR/ai-profile`), launched by Playwright MCP with its own Playwright: never the Teams browser, never the Teams profile. The two Playwright versions stay apart, the Teams tab is never put behind another tab, and a page the AI reads never runs next to the Teams session. Sites that need a sign-in get it once in that profile, by hand, on the relay computer.
- Browser tools take OAuth access tokens only (`@better-auth/mcp`). The people who use it sign in with the administrator of `.env`; each client still gets a token of its own, revoked alone, and named in the log of actions. `MCP_TOKEN` keeps the five read tools and drives no browser.
- Off unless the relay computer turns it on: `RELAY_BROWSER=1` in `relay.env`.

## Shape

```
MCP client (Claude Code, opencode, claude.ai)
   | HTTPS /mcp, OAuth access token
web app: /mcp route, browser_* tools with `account`
   | globalThis hub, same process
browser hub (preloaded before Next, like the call-audio hub)
   | websocket /api/relay/browser/socket, opened by the relay with its token
relay: allowlist, then createConnection() of @playwright/mcp
   | Playwright of @playwright/mcp
AI browser: own profile, own window, headful
```

## Relay

1. With `RELAY_BROWSER=1` and a server joined, the relay opens `wss://<server>/api/relay/browser/socket` with its token, and opens it again after a drop, waiting longer each time up to 30 s, as the sync does. Without the variable it opens nothing, and the server lists no browser tool for the account.
2. On the first message it creates the Playwright MCP server: `createConnection({ capabilities: ["core", "core-navigation", "core-tabs", "core-input"], allowUnrestrictedFileAccess: false, outputDir: <STATE_DIR>/ai-output, outputMaxSize: 20 MB, imageResponses: "allow", snapshot: { mode: "none" } }, contextGetter)`, connected to a transport in the relay process: the relay is its MCP client and opens the session itself, without the `roots` capability. The context getter launches the browser at the first tool call, `launchPersistentContext(<STATE_DIR>/ai-profile, { channel: <BROWSER_CHANNEL>, headless: false })` with the Playwright that `@playwright/mcp` brings, so that the relay holds the browser and can close it. The websocket carries JSON-RPC `tools/list` and `tools/call` requests from the server and their answers.
3. Every message from the server passes the allowlist before Playwright MCP sees it; every answer passes it on the way back. The relay is the side that runs the tools, so the allowlist there holds even against a server that forwards anything:
   - `tools/list` answers only the allowed tools, without the `filename` argument (a file on the relay disk is of no use to a remote client).
   - `tools/call` of any other tool, or with `filename`, answers an error and runs nothing. Any other method (`initialize`, `ping`...) answers a JSON-RPC error.
   - `browser_navigate` and `browser_tabs` with a `url` take `http:` and `https:` URLs only, and no loopback host (`localhost`, `*.localhost`, `127.0.0.0/8`, `0.0.0.0/8`, `[::1]`, IPv4-mapped loopback).
   - An answer larger than 32 MB becomes a tool error instead.
4. Allowed: `browser_navigate`, `browser_navigate_back`, `browser_tabs`, `browser_snapshot`, `browser_find`, `browser_take_screenshot`, `browser_click`, `browser_hover`, `browser_drag`, `browser_type`, `browser_press_key`, `browser_fill_form`, `browser_select_option`, `browser_handle_dialog`, `browser_wait_for`, `browser_resize`, `browser_close`, `browser_console_messages`. Left out: `browser_run_code_unsafe`, `browser_evaluate`, `browser_file_upload`, `browser_drop`, `browser_network_requests`, `browser_network_request` (headers carry cookies and tokens of the AI profile), `browser_emulate_media`, and every tool of the capabilities not listed in 2.
5. After 15 minutes with no tool call (`RELAY_BROWSER_IDLE`) the relay closes its browser context, then the Playwright MCP server (closing the server alone leaves the browser running), and empties `ai-output`; the next call creates both again. The profile stays on disk.
6. `@playwright/mcp` is pinned to an exact version in `package.json` and stays external to `dist/relay.cjs`, like `playwright-core`: `npm ci` on the relay computer installs its own Playwright next to the relay's.

## Server

1. The browser hub is preloaded with the call-audio hub. It takes one relay socket per account (a newer one replaces the older), after `GET /api/relay/browser` answers that the token is the relay of that account. It keeps the last `tools/list` of each relay, and sends one call at a time per account, each with a 90 s limit.
2. The `/mcp` route reaches the hub through `globalThis`: Turbopack copies module state per chunk.
3. For an OAuth token, the tools of `/mcp` are the five read tools plus, while at least one account the user owns has its relay connected with the browser on, each allowed tool of that relay with one more argument, `account` (slot number). A client that listed its tools before the relay connected sees the browser tools after it lists them again.
4. A browser tool exists only for an OAuth token (`MCP_TOKEN` gets an unknown tool). A call checks, in this order: the user owns slot N ("Account not found", nothing written), the account is a relay account, it is not stopped, the owner did not switch its browser off in Settings, its relay is connected with the browser on (tool error naming the account, written with its outcome). Then the hub forwards it without `account`, and the answer goes back as it came, images included.
5. Each call is written to `browser_actions` in `app.db`: time, user, OAuth client, slot, tool, host of the URL for `browser_navigate` and `browser_tabs`, outcome. The account settings show the last 50, and a switch that stops the browser tools of that account (`teams_accounts.browser_off`).

## Authentication

1. `@better-auth/mcp` added to the better-auth instance, better-auth raised to 1.7.7; its tables come from the migrations run at boot (`getMigrations`).
2. Dynamic client registration on: Claude Code and claude.ai register themselves. A registered client gets nothing without a signed-in user. A registration with only loopback HTTP redirects and no `application_type` is taken as native (MCP SDK 1.x sends none, and better-auth refuses a web client with an `http://localhost` redirect).
3. Authorization sends the browser to the existing sign-in page of the app, then to one consent screen naming the client, with Allow and Deny.
4. `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server/api/auth` (the issuer is `<APP_URL>/api/auth`) reach the web app through Caddy, whose catch-all already sends them there; a route of the web app answers `/.well-known/*` through better-auth.
5. `/mcp` takes either `MCP_TOKEN` (read tools only, as today) or an OAuth access token checked by `requireMcpAuth` against the JWKS read from the web app's own port. Access tokens are JWTs valid one hour: revocation is a consent check on every request (Settings, AI clients, Revoke deletes consent and tokens; a banned or deleted user is refused too). Requests with an `Origin` header keep answering 403. OAuth is off when `APP_URL` is plain HTTP on a host other than loopback (an OAuth resource must be HTTPS).

## Security

- Whoever holds an OAuth token of the owner of an account, or controls the server, drives a browser on the relay computer: navigation, clicks and typing inside whatever the AI profile is signed in to, from the network of that computer. Nothing more reaches that computer: no code runs in the relay, no tool reads a file of its disk or takes a path from the client, and the Teams browser and profile are out of reach. Playwright MCP saves each screenshot as a PNG in `<STATE_DIR>/ai-output` on its own (capped, emptied when the browser closes).
- `RELAY_BROWSER` sits on the relay computer: neither the server nor a token turns it on.
- Pages are written by other people and can steer the model that reads them (prompt injection), as chat messages already can ([mcp.md](../mcp.md)). The allowlist bounds what a steered model can do through these tools; a client with other tools (shell, email) can still act on what it read.
- The loopback check reads the URL a tool gets, nothing else: a link in a page, or a name that resolves to a loopback address, still reaches it. The relay API on the same computer answers only with its token.
- Driving a browser from a computer of a client environment (a VDI, a managed laptop) falls under that environment's rules: the owner decides per relay, with `RELAY_BROWSER`.

## Changes after the spikes

2026-10-01, before the build, from the spikes recorded in the plan ([2026-10-01-relay-browser-mcp-plan.md](2026-10-01-relay-browser-mcp-plan.md)): the relay opens the MCP session itself and launches the AI browser with the Playwright of `@playwright/mcp` (Relay 2, 5); action answers carry no snapshot; registration defaults to native for loopback redirects; discovery paths and per-request revocation (Authentication 2, 4, 5); the check order of Server 4 names the stopped account and the switch. The intent is unchanged: no port on the relay computer, the allowlist in the relay, the Teams browser and profile untouched, OAuth tokens only for the browser, `MCP_TOKEN` read only, `RELAY_BROWSER` off by default.

## Not done

- The Teams tab, through these tools: Teams stays with the agent and the TeamsRelay tools.
- Accounts of the browsers container: their browsers are on the server, not on another computer.
- API keys for clients that cannot do OAuth.
- An AI loop running on the server.
- Several sessions on one relay: two clients of the same owner share the tabs, one call at a time.

## Tests

- Relay allowlist: `tools/list` reduced and without `filename`; each left-out tool, `filename`, a `file:`, a `chrome:` and a `localhost` URL refused with nothing run, including when sent straight down the socket.
- Relay link: socket opened only with `RELAY_BROWSER=1`, again after a drop, Playwright MCP closed after the idle time and created again at the next call.
- Hub: relay side only with the relay token of the account, newer socket replaces the older, one call at a time per account, the 90 s limit.
- `/mcp` route: browser tools listed only for an OAuth token and an owned account with a connected relay; each refusal of step 4 of Server; `MCP_TOKEN` gets the five read tools only; `browser_actions` row written for each call.
- OAuth: registration, sign-in with the administrator of `.env`, consent, token accepted on `/mcp`, revoked token refused.
- Live, local stack with the relay of this computer, `RELAY_BROWSER=1`, Claude Code over OAuth: a search, snapshot, click, a second tab, screenshot; the Teams tab keeps its chat-list reads meanwhile; `browser_run_code_unsafe` absent from the list and refused when called by name.
