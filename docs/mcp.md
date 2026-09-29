# MCP server

AI clients that speak the Model Context Protocol (Claude Code, opencode, any client that can send a header) read the Teams chats TeamsRelay holds through `/mcp`: accounts, chat list, messages, Activity feed. Read only: no tool sends, replies, reacts, edits or deletes; the AI proposes text and you send it. Design: [2026-09-26-mcp-server.md](design/2026-09-26-mcp-server.md).

## Turn it on

1. Put a token of at least 32 characters in `.env`: `MCP_TOKEN=` followed by the output of `openssl rand -hex 32`.
2. `docker compose up -d webapp`. The log says `MCP endpoint on: /mcp`.

The token acts as the administrator of `.env` (`ADMIN_EMAIL`) and reads the Teams accounts that user owns. Without `ADMIN_EMAIL`, or with a shorter token, the web app does not start. With `MCP_TOKEN` empty, `/mcp` answers 404.

To change the token, set a new value and run `docker compose up -d webapp` again: the old one stops working at once.

On the local stack `compose.local.env` holds no token, so it never ends up in git: set it in the shell that starts the stack (Compose takes it over the env file).

```powershell
$env:MCP_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
docker compose --env-file compose.local.env -f docker-compose.yml -f compose.local.yml up -d webapp
```

## Clients

Address: `https://<DOMAIN>/mcp` (local stack: `http://localhost:8090/mcp`), transport Streamable HTTP, header `Authorization: Bearer <MCP_TOKEN>`.

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

The server serves protocol revision `2026-07-28` and the 2025 revisions from the same endpoint. There is no OAuth: clients that only connect through OAuth (claude.ai connectors) cannot use it.

## Tools

`account` is the slot number `list_accounts` gives; without it, the first account.

| Tool | Input | Answer | Effect on Teams |
|---|---|---|---|
| `list_accounts` | none | slot, name, email, organization, Teams state, stopped, unread chats | none |
| `list_chats` | `account?`, `unread_only?` | name, preview, time label, unread, mention, muted, `presence` of the person of a 1:1 chat when the last list read showed one (`available`, `busy`, `dnd`, `away`, `offline`, `ooo`), `open` for the chat open in Teams now | none |
| `read_chat` | `account?`, `chat` | the saved messages: id, time (UTC, from the Teams message id), author, mine, text, quote, reactions, number of images, file names, edited, deleted; `live` when the chat is open in Teams and the messages are current | none |
| `refresh_chat` | `account?`, `chat` | as `read_chat`, after opening the chat in Teams | the chat turns read in Teams, senders may see their messages as seen, Teams keeps it open for at least 90 s |
| `list_activity` | `account?`, `unread_only?` | Activity feed as last read: kind, actor, title, preview, time label, chat, unread | none |

`refresh_chat` is the only tool not marked read-only, so a client can ask before running it. It waits up to 30 s for the agent and answers with an error when the account is stopped, Teams is not signed in, the chat is not in the list or Teams did not open it.

## Limits

- `read_chat` gives what TeamsRelay saved: the last 40 messages of each chat opened at least once, from the app or through `refresh_chat`. A chat never opened has none.
- The messages of a chat that is not open are as old as the last time it was open: `live` false. The chat list and the Activity feed are current within seconds and minutes.
- `refresh_chat` uses the one Teams tab of the account: while the app shows another chat of the same account, that chat stops updating until it is opened again in the app.
- Chats are named as in the Teams list, with the limits of [limitations.md](limitations.md): same display name, group chats listed as "Name, +2".
- Messages are written by other people. A model reading them can be steered by what they say (prompt injection): the server has no tool that writes, but a client with other tools (shell, web, email) can still act on what it read.
