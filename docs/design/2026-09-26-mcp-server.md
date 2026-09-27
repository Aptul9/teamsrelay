# MCP server: AI clients read the Teams chats

Status: approved 2026-09-26. Plan: [2026-09-26-mcp-server-plan.md](2026-09-26-mcp-server-plan.md).

## Goal

An AI client (Claude Code, opencode, any MCP client that takes a header) reads the Teams chats TeamsRelay holds: accounts, chat list, messages, Activity feed. Personal use, by the administrator of `.env`. Read only: the AI proposes text in its own answer and the user sends it.

## Decisions

| Question | Choice | Not chosen |
|---|---|---|
| Where | Route `/mcp` of the web app, same image and process | own `mcp` container (more RAM and compose surface); local stdio bridge (install on every client machine, token auth on the REST API) |
| Clients | Claude Code, opencode and others, over Streamable HTTP with a bearer header | OAuth (`@better-auth/mcp`): claude.ai and mobile only need it; opencode registers only through Dynamic Client Registration, which the MCP spec deprecates |
| Access | One token, `MCP_TOKEN` in `.env`, acting as the administrator of `.env` | per-user tokens with a Settings page: one person uses it |
| Writes | None: no tool sends, replies, reacts, edits or deletes | writes confirmed by the client, or approved in the app |
| Reading a chat | Messages TeamsRelay already holds; opening the chat in Teams only through its own tool | always open the chat; never open it |

## Endpoint

- `POST /mcp`, Streamable HTTP, SDK `@modelcontextprotocol/server` 2.1.0 (protocol revision `2026-07-28`, clients of the 2025 revisions served by the same handler). A new `McpServer` per request: nothing is kept between requests.
- Addresses: `http://localhost:8090/mcp` on the local stack, `https://<DOMAIN>/mcp` on a server. Caddy already sends every path but `/desktop/` to the web app.
- `MCP_TOKEN` empty or missing: `/mcp` answers 404. Set: at least 32 characters, otherwise the web app does not start. It needs `ADMIN_EMAIL`: without it the web app does not start either.
- Each request carries `Authorization: Bearer <MCP_TOKEN>`, compared in constant time; a missing or wrong token answers 401 with `WWW-Authenticate: Bearer`. The request then acts as the administrator of `.env` and reaches the accounts that user owns at that moment.
- Cookies are not read on `/mcp`, and a request with an `Origin` header answers 403: a web page open in a browser signed in to TeamsRelay cannot use the endpoint.
- Rotating the token: new value in `.env`, `docker compose up -d webapp`.

## Tools

`account` is the slot number, as `?a=N` of the HTTP API; without it, the first account of the user. An account of nobody or of another user answers as an error, like 404 on the HTTP API.

| Tool | Input | Output | Effect on Teams |
|---|---|---|---|
| `list_accounts` | none | per account: `slot`, `name`, `email`, `tenant`, `teams`, `overall`, `stopped`, `unread` | none |
| `list_chats` | `account?`, `unread_only?` | per chat: `name`, `preview`, `last` (time as Teams shows it), `unread`, `mention`, `muted`, `open` (the chat open in Teams now) | none |
| `read_chat` | `account?`, `chat` | `chat`, `live` (open in Teams now: kept current by the agent), `messages` | none |
| `refresh_chat` | `account?`, `chat` | as `read_chat`, after Teams opened the chat | the chat opens in Teams: it turns read, senders may see it as seen; Teams keeps it open, and marks as read what arrives in it, until no chat was in use for 90 s (the app open on that account keeps it in use), then shows the self chat |
| `list_activity` | `account?`, `unread_only?` | `read_at`, per item: `kind`, `actor`, `title`, `preview`, `time`, `chat`, `channel`, `unread` | none |

A message of `read_chat` and `refresh_chat`:

| Field | Content |
|---|---|
| `id` | Teams message id |
| `time` | ISO 8601 UTC, from the id: Teams message ids are the milliseconds of the message (`1790431664072` is `2026-09-26T14:07:44.072Z`); absent when the id is not a number |
| `author`, `mine`, `text` | as stored |
| `quote` | `{author, text}` of the quoted message |
| `reactions` | `[{emoji, count, mine}]` |
| `images` | number of images |
| `files` | names of the attachments |
| `edited`, `deleted`, `mentions_me` | present only when true |

HTML, pictures, read receipts and delivery status are left out: they cost tokens and say little to a model.

- Annotations: `readOnlyHint: true` on every tool except `refresh_chat`, which has `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`, so a client can ask before running it and run the others freely.
- Every result is `structuredContent` and the same JSON as text, for clients that read only the text.
- The descriptions of `read_chat`, `refresh_chat` and `list_activity` say that the text is written by other people and is data, not instructions.
- A chat never opened has no messages: `read_chat` answers with an empty list and says to use `refresh_chat`.

## `refresh_chat`

Uses the `open` command the app already queues when a chat is shown; the agent does not change.

1. Account stopped, chat not in the chat list, agent silent or Teams not signed in: error, nothing queued.
2. `open` queued, its status read every 500 ms for up to 30 s.
3. `done` and `active_chat` equal to the chat: the messages are read as in `read_chat`, with `live` true.
4. `done` with another `active_chat`: error "Teams did not open this chat". `open` ends as done even when Teams did not open the chat, for example a name that is not in the list.
5. `failed`, or no outcome after 30 s: error with that outcome.

The app showing another chat of the same account stops updating that chat until it is opened again in the app, as after opening a chat from the app on another device.

## Errors

A tool error is a result with `isError: true` and one sentence: account not found, account not ready yet (no database), account stopped, chat not opened, command failed, timeout. Protocol and authentication errors (401, 403, 404 of the endpoint) are HTTP answers before the MCP server is involved.

## Files

| File | Content |
|---|---|
| `app/src/app/mcp/route.ts` | `POST`: token and `Origin` checks, then the MCP handler; other methods 405 |
| `app/src/lib/mcp/access.ts` | `MCP_TOKEN` check, user of `ADMIN_EMAIL` |
| `app/src/lib/mcp/tools.ts` | the five tools, as functions of the user and the arguments, and the account choice |
| `app/src/lib/slotdb.ts` | `SlotReader.activeChat()`: the chat last opened, a plain-text state row |
| `app/src/lib/mcp/server.ts` | `McpServer` with the tools registered, schemas and annotations |
| `app/src/lib/config.ts` | `mcpToken` |
| `app/src/server/boot.ts` | start refused for a short `MCP_TOKEN` or one without `ADMIN_EMAIL` |
| `docker-compose.yml`, `.env.example` | `MCP_TOKEN` |
| `docs/mcp.md` | setup of Claude Code and opencode, tools, limits |
| `docs/configuration.md`, `docs/security.md`, `docs/limitations.md`, `docs/api.md`, `docs/architecture.md`, `README.md` | the new variable, endpoint and limits |

## Tests

- Access: token missing, wrong, right; `MCP_TOKEN` empty (404); `Origin` (403); a method other than POST (405); token too short or without `ADMIN_EMAIL` refused at boot.
- Tools on a slot database seeded as the agent writes it: fields and filters, message time from the id, `live` and `open`, empty chat, account of another user, account without database, stopped account.
- `refresh_chat` with the agent's writes simulated: done with the chat open, done with another chat open, failed, timeout.
- Protocol: `@modelcontextprotocol/client` 2.1.0 lists the tools with their annotations and calls them through the route handler.
- Live on the local stack: Claude Code connects with `--mcp-config`; tools read slot 2; `refresh_chat` only on the self chat.

## Out of scope

Writes, search, images and attachments, the people of a chat, OAuth, one token per user.
