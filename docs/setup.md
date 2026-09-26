# Setup

## Requirements

- Linux server, x86_64 or ARM64, with Docker and the Compose plugin. At least 2 GB of free RAM with one Teams account; every further account adds a Chromium with its desktop stream.
- A DNS name pointing to the server, and TCP ports 80 and 443 reachable from the Internet (certificate and phones).
- Teams accounts that work in a desktop browser.
- Phones: iOS 16.4 or later, or Android.

## 1. Configuration

```bash
git clone <repository> /opt/teamsrelay && cd /opt/teamsrelay
cp .env.example .env && chmod 600 .env
openssl rand -hex 32          # value for BETTER_AUTH_SECRET
```

Required in `.env`: `DOMAIN`, `BETTER_AUTH_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`. Every variable: [configuration.md](configuration.md).

`/opt/teamsrelay` is the path used by the deploy pipeline ([operations.md](operations.md)).

## 2. Push keys

```bash
docker run --rm -v "$PWD:/w" -w /w python:3.14-slim \
  sh -c "pip install -q cryptography && python tools/gen_vapid.py vapid"
```

Creates `vapid/private_key.pem` and `vapid/appkey.txt`. Generate them once: new keys force every device to enable notifications again.

## 3. Start

```bash
docker compose --profile accounts create --build   # every container, slots included, created stopped
docker compose up -d                                # web app, socket proxy, Caddy
docker compose logs -f webapp
```

The slot containers must exist: the web app can only start and stop them. On the first start the web app creates the administrator from `ADMIN_EMAIL` and `ADMIN_PASSWORD`; without them it exits with that message. At every later start it keeps that administrator in line with `.env`.

## 4. Users

1. Open `https://<DOMAIN>` and sign in as the administrator.
2. Account menu (top left) → **Users** → **New user**: create a user for every person, with a password of at least 10 characters. There is no public sign-up.
3. Each user changes their password in **Settings**. The administrator of `.env` changes `ADMIN_PASSWORD` in `.env` and restarts the web app (`docker compose up -d`).

An administrator manages users and can free a slot. The chats and the desktop of a slot are visible only to its owner.

## 5. Teams accounts

1. Account menu → **Add a Teams account**. The first free slot starts its browser, which takes up to two minutes.
2. **Sign in to Microsoft** (button of the banner, or account menu): the remote desktop of the slot opens on the Microsoft login. On a PC it opens in a new tab, on a phone or tablet in the **Desktop** view. Sign in with password and MFA.
3. Set the language of Teams web to **English**: the agent reads some English texts.
4. Back in the app, the chat list appears and the status pill turns green within a minute.

A slot is free again when its owner removes the account. `SLOT_COUNT` and `ACCOUNTS_PER_USER` set the limits.

## 6. Phone

TeamsRelay is a PWA: installed from the browser, it opens like an app, with icon and notifications.

- **iPhone**: open `https://<DOMAIN>` in Safari, sign in, Share → **Add to Home Screen**. Open TeamsRelay from the Home Screen icon, tap **Enable notifications**, allow. Push notifications reach only the installed app.
- **Android**: open the site in Chrome, menu → **Install app**, then **Enable notifications**.
- **PC**: any current browser, chats on the left and the open conversation on the right. The remote desktop opens in a browser tab.

The status panel shows how many devices of the user receive notifications. A device receives the notifications of every Teams account of its user.

## Upgrading from the single-user release

Releases up to commit `7b26cb4` had one login (`UI_USER`, `UI_PASS`) and no users. Before deploying a multi-user release, add to `.env` on the server:

- `BETTER_AUTH_SECRET` (at least 32 characters). An existing `SESSION_SECRET` of 32 characters or more is accepted instead.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD`.

On the first start the administrator receives the existing Teams accounts (their browser sessions stay signed in) and the devices already registered for notifications. Keep `UI_USER` and `UI_PASS` in `.env` until the new release is confirmed: an automatic rollback starts the previous release, which needs them.

## Local development

The whole stack runs with Docker Desktop, on `http://localhost:8090`, bound to `127.0.0.1`.

```bash
docker compose --env-file compose.local.env -f docker-compose.yml -f compose.local.yml --profile accounts create --build
docker compose --env-file compose.local.env -f docker-compose.yml -f compose.local.yml up -d
```

- Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` of `compose.local.env`, local test values.
- Caddy serves plain HTTP: `localhost` is a secure context, so the service worker and Web Push work without a certificate.
- Named volumes (`tr_data`, `tr_config`...) replace `data/` and `config/`: on the Windows filesystem SQLite locking and the symlinks of the Chromium profile are unreliable.
- Sample chats without a signed-in Teams: `docker compose cp app/scripts/seed-slot.mjs webapp:/app/seed-slot.mjs`, then `docker compose exec webapp node /app/seed-slot.mjs /data 1` (slot 1 must belong to your user).

Web app code: `app/` (Next.js). Checks, from `app/`:

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
```

`npm test` includes the agent page scripts run against a static copy of the Teams chat list, in the local Google Chrome. Agent tests: `python -m unittest -v test_agent` from `agent/` with the packages of `agent/requirements.txt`.

After a change, rebuild the image of the web app (`docker compose ... up -d --build webapp`). `agent/agent.py` is mounted in the agent containers: `docker compose ... restart agent-1` is enough.

Stop everything with `docker compose -f docker-compose.yml -f compose.local.yml down`; `down -v` also deletes the volumes, Teams sessions included.
