# MCP server

AI clients that speak the Model Context Protocol (Claude Code, opencode, claude.ai connectors) read the Teams chats TeamsRelay holds through `/mcp`: accounts, chat list, messages, Activity feed. No tool sends, replies, reacts, edits or deletes in Teams; the AI proposes text and you send it. A client signed in with OAuth also drives a browser of its own on the computer of each relay of yours that turns it on (below). Designs: [2026-09-26-mcp-server.md](design/2026-09-26-mcp-server.md), [2026-10-01-relay-browser-mcp.md](design/2026-10-01-relay-browser-mcp.md).

## Two ways in

| | OAuth sign-in | `MCP_TOKEN` |
|---|---|---|
| Who | any user of the web app, with its own password, one token per client | the administrator of `.env` (`ADMIN_EMAIL`) |
| Tools | the five read tools, plus the browser tools of the user's relays | the five read tools |
| Turned on by | on by default when the address of the app is HTTPS (or plain HTTP on `localhost`) | `MCP_TOKEN` in `.env` |
| Revoked by | Settings, AI clients, Revoke | a new value of `MCP_TOKEN` |

A request from a web page (`Origin` header) is refused with 403 either way; no session cookie counts on `/mcp`.

## OAuth sign-in

The web app is an OAuth 2.1 authorization server for MCP clients (`@better-auth/mcp`): the client finds it from `/mcp` itself (a 401 names `/.well-known/oauth-protected-resource/mcp`, which names the server, whose metadata is at `/.well-known/oauth-authorization-server/api/auth`), registers itself (dynamic client registration), and opens the browser on the sign-in page of the app. After the sign-in a consent screen names the client and the user, with Allow and Deny. The client gets an access token for one hour and a refresh token.

Claude Code:

```bash
claude mcp add --transport http teamsrelay https://teams.example.com/mcp
```

Then `/mcp` in Claude Code, pick `teamsrelay`, Authenticate: the browser opens on the sign-in page of TeamsRelay.

claude.ai: Settings, Connectors, Add custom connector, URL `https://teams.example.com/mcp`.

Every client a user allowed is listed in Settings, AI clients, with the date; Revoke deletes its consent and its tokens, and its next request is refused even with an access token that has not expired yet. The client gets in again only through the sign-in and Allow.

OAuth is off when the address of the app (`DOMAIN` or `APP_URL`) is plain HTTP on a host other than `localhost`: an OAuth resource must be HTTPS. `/mcp` then takes `MCP_TOKEN` only, and answers 404 without it.

## MCP_TOKEN

1. Put a token of at least 32 characters in `.env`: `MCP_TOKEN=` followed by the output of `openssl rand -hex 32`.
2. `docker compose up -d webapp`. The log says `MCP endpoint on: /mcp`.

The token acts as the administrator of `.env` (`ADMIN_EMAIL`) and reads the Teams accounts that user owns. Without `ADMIN_EMAIL`, or with a shorter token, the web app does not start. It never drives a browser.

To change the token, set a new value and run `docker compose up -d webapp` again: the old one stops working at once.

On the local stack `compose.local.env` holds no token, so it never ends up in git: set it in the shell that starts the stack (Compose takes it over the env file).

```powershell
$env:MCP_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
docker compose --env-file compose.local.env -f docker-compose.yml -f compose.local.yml up -d webapp
```

Clients with a header instead of OAuth, address `https://<DOMAIN>/mcp` (local stack: `http://localhost:8090/mcp`), transport Streamable HTTP, header `Authorization: Bearer <MCP_TOKEN>`.

Claude Code:

```bash
claude mcp add --transport http teamsrelay https://teams.example.com/mcp --header "Authorization: Bearer <MCP_TOKEN>"
```

opencode, in `opencode.json`, with the token in the environment variable `TEAMSRELAY_MCP_TOKEN`:

```json
{
  "mcp": {
    "teamsrelay": {
      "type": "remote",
      "url": "https://teams.example.com/mcp",
      "headers": { "Authorization": "Bearer {env:TEAMSRELAY_MCP_TOKEN}" },
      "oauth": false
    }
  }
}
```

The server serves protocol revision `2026-07-28` and the 2025 revisions from the same endpoint.

## Read tools

`account` is the slot number `list_accounts` gives; without it, the first account.

| Tool | Input | Answer | Effect on Teams |
|---|---|---|---|
| `list_accounts` | none | slot, name, email, organization, Teams state, stopped, unread chats | none |
| `list_chats` | `account?`, `unread_only?` | name, preview, time label, unread, mention, muted, `presence` of the person of a 1:1 chat when the last list read showed one (`available`, `busy`, `dnd`, `away`, `offline`, `ooo`), `open` for the chat open in Teams now | none |
| `read_chat` | `account?`, `chat` | the saved messages: id, time (UTC, from the Teams message id), author, mine, text, quote, reactions, number of images, file names, edited, deleted; `live` when the chat is open in Teams and the messages are current | none |
| `refresh_chat` | `account?`, `chat` | as `read_chat`, after opening the chat in Teams | the chat turns read in Teams, senders may see their messages as seen, Teams keeps it open for at least 90 s |
| `list_activity` | `account?`, `unread_only?` | Activity feed as last read: kind, actor, title, preview, time label, chat, unread | none |

`refresh_chat` is the only read tool not marked read-only, so a client can ask before running it. It waits up to 30 s for the agent and answers with an error when the account is stopped, Teams is not signed in, the chat is not in the list or Teams did not open it.

## Browser tools

For an OAuth client, while at least one account of the user on another computer has its relay connected with `RELAY_BROWSER=1` ([setup.md](setup.md), Local relay), `/mcp` also lists the tools of Playwright MCP (`@playwright/mcp`) that the relay lets through, each with one more argument, `account` (required: the slot of that account). A client that listed its tools before the relay connected sees them once it lists them again.

| Tool | What it does |
|---|---|
| `browser_navigate`, `browser_navigate_back` | open a page (`http:` or `https:` only, never this computer: `localhost`, `127.0.0.0/8`, `[::1]`), go back |
| `browser_tabs` | list, open (same address rule), select, close tabs |
| `browser_snapshot`, `browser_find` | the page as an accessibility tree with element references; find text in it |
| `browser_take_screenshot` | a screenshot, as an image in the answer |
| `browser_click`, `browser_hover`, `browser_drag`, `browser_type`, `browser_press_key`, `browser_fill_form`, `browser_select_option`, `browser_handle_dialog` | act on the elements of the snapshot |
| `browser_wait_for`, `browser_resize`, `browser_close`, `browser_console_messages` | wait for text or time, size of the window, close the browser, messages of the page console |

Not offered, and refused by the relay even when asked by name: `browser_run_code_unsafe` and `browser_evaluate` (code in the relay or in the page), `browser_file_upload` and `browser_drop` (files of the relay computer), `browser_network_requests` and `browser_network_request` (headers with the cookies of the profile), `browser_emulate_media`, and the `filename` argument of any tool.

The browser is a second Google Chrome or Microsoft Edge (`BROWSER_CHANNEL`) on a profile of its own, `<STATE_DIR>/ai-profile`, in a window of its own: never the Teams window or the Teams profile. It opens at the first call and closes after 15 minutes without a call (`RELAY_BROWSER_IDLE`); the profile stays, so a site signed in once by hand in that window stays signed in. Actions answer without the page: ask `browser_snapshot` to read it. Calls of one account run one at a time and stop after 90 s.

Each call is written to the log of the account (time, client, tool, host of the page opened, outcome); Settings, AI clients shows the last 50 per account, and a switch that takes the browser of that account away from every client until it is turned on again.

## Limits

- `read_chat` gives what TeamsRelay saved: the last 40 messages of each chat opened at least once, from the app or through `refresh_chat`. A chat never opened has none.
- The messages of a chat that is not open are as old as the last time it was open: `live` false. The chat list and the Activity feed are current within seconds and minutes.
- `refresh_chat` uses the one Teams tab of the account: while the app shows another chat of the same account, that chat stops updating until it is opened again in the app.
- Chats are named as in the Teams list, with the limits of [limitations.md](limitations.md): same display name, group chats listed as "Name, +2".
- Messages and pages are written by other people. A model reading them can be steered by what they say (prompt injection): the browser tools act only inside the AI browser, but a client with other tools (shell, email) can still act on what it read. See [security.md](security.md).
- Two clients of the same user share the tabs of one relay browser.
