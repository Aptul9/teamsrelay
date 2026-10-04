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
