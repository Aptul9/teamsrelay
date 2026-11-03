# TeamsRelay

Self-hosted bridge that mirrors Microsoft Teams chats to a phone web app with push notifications, for your own accounts. Not affiliated with Microsoft.

## Requirements

- Server: Linux with Docker Compose, a DNS name, ports 80 and 443.
- Local relay: Node 24+ and Chrome or Edge.

## Server (Docker Compose)

```bash
cp .env.example .env            # DOMAIN, BETTER_AUTH_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
docker run --rm -v "$PWD:/w" -w /w node:24-slim node app/scripts/gen-vapid.mjs vapid
docker compose up -d --build
```

Then open `https://<DOMAIN>` and sign in as `ADMIN_EMAIL`.

## MCP for AI clients

`https://<DOMAIN>/mcp` (Streamable HTTP) gives an AI client the Teams accounts of a user. Two ways in:

- `Authorization: Bearer <MCP_TOKEN>` from `.env`: acts as `ADMIN_EMAIL`.
- OAuth: the client signs in to the app and asks the consent; revoke it in Settings, AI clients. It also gets the browser of the user's relays.

```bash
claude mcp add --scope user --transport http teamsrelay https://<DOMAIN>/mcp --header "Authorization: Bearer <MCP_TOKEN>"
```

| Tool | What it does |
|---|---|
| `list_accounts` | Accounts of the user: slot, name, Teams state, unread chats |
| `list_chats` | Chat list as Teams shows it |
| `read_chat` | Saved messages of a chat: id, author, text, quote, reactions, images, files |
| `refresh_chat` | Opens the chat in Teams, then reads it (marks it read) |
| `list_activity` | Activity feed |
| `send_message` | Text, reply with quote (`reply_to`), people tagged (`mentions`), image in base64 with caption |
| `react_message` | `like`, `heart`, `laugh`, `surprised`, `cry`, `angry`, or an emoji already under the message; your own is taken away |
| `edit_message`, `delete_message`, `undo_delete` | On your own messages |
| `get_attachment` | Images of a message inline, text files as text, other files up to 8 MB as resources; SharePoint files downloaded with the Teams session |

`chat` is the name as `list_chats` gives it, `message_id` the id of `read_chat`, `account` the slot (default: the first). The write tools queue the same command as the app and wait up to 45 s for Teams to show it. Accounts without a browser cannot download SharePoint files.

## Local relay (one account, no server)

```bash
cd app && npm ci
npm run relay:setup             # writes relay.env and the API token
npm run relay:login             # sign in once
npm run relay                   # start
```

## Fleet (optional, multi-host)

```bash
cd app
npm run fleet:agent             # agent, from fleet.config.json
npm run fleet -- status all     # control hosts in fleet.hosts.json: exec | update | status
```

Each host's cmdapi tunnel claims the first free VM port from `vmPort` up to `vmPort + vmPortSpan - 1` (default 6). A host that wakes from sleep is back at once, on the next port, while the VM still holds its old session. `fleet` finds the host by trying that pool with the host's token (`span` in `fleet.hosts.json`), so keep the hosts' ports at least a span apart. The ssh component keeps one fixed port.

The agent logs one line per tunnel event, for example `fleet: tunnel cmdapi connected vm=oracle-vm port=8767`. Watch it with `npm run fleet:agent` in a terminal, or `npx pm2 logs teamsrelay-fleet` when pm2 runs it.

The VM needs `ClientAliveInterval 30` and `ClientAliveCountMax 3` in sshd, so a dead session clears in two to three minutes instead of two hours.

A host picks up a new agent with `npm run build:fleet-agent` and `npx pm2 restart teamsrelay-fleet`, run on the host: `fleet update` rebuilds and restarts the relay only.

## Development

```bash
cd app && npm ci
npm run dev                     # next dev on :8090
npm test
npm run typecheck
npm run lint
npm run build
```

Config: `.env.example` (server), `app/relay.env.example` (local relay), `app/fleet.config.example.json` and `app/fleet.hosts.example.json` (fleet).
