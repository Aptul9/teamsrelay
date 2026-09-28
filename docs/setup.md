# Setup

## Requirements

- Linux server, x86_64 or ARM64, with Docker and the Compose plugin. At least 2 GB of free RAM with one Teams account; every further account adds a Chromium, about 1.5 GB with Teams loaded.
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
docker run --rm -v "$PWD:/w" -w /w node:24-slim node app/scripts/gen-vapid.mjs vapid
```

Creates `vapid/private_key.pem` and `vapid/appkey.txt`. Generate them once: new keys force every device to enable notifications again, so the script never replaces an existing key. Keys made by the Python tool of earlier releases work as they are. The agents stop at start when the private key does not match `appkey.txt`.

## 3. Start

```bash
docker compose up -d --build     # browsers, web app, Caddy
docker compose logs -f webapp
```

The browsers container starts without browsers: its supervisor starts the browser and the agent of an account when the web app asks. On the first start the web app creates the administrator from `ADMIN_EMAIL` and `ADMIN_PASSWORD`; without them it exits with that message. At every later start it keeps that administrator in line with `.env`.

## 4. Users

1. Open `https://<DOMAIN>` and sign in as the administrator.
2. Account menu (top left) → **Users** → **New user**: create a user for every person, with a password of at least 10 characters. There is no public sign-up.
3. Each user changes their password in **Settings**. The administrator of `.env` changes `ADMIN_PASSWORD` in `.env` and restarts the web app (`docker compose up -d`).

An administrator manages users and can free a slot. The chats and the desktop of a slot are visible only to its owner.

## 5. Teams accounts

1. Account menu → **Add a Teams account**. The account gets its browser and agent; Teams takes up to two minutes to load. Until its first sign-in it shows as *New Teams account*, under **Add your first Teams account** (or **Finish adding this Teams account** next to accounts already signed in).
2. **Sign in to Microsoft** (button of the banner, or account menu): the remote desktop opens with the window of the account in front, on the Microsoft login. On a PC it opens in a new tab, on a phone or tablet in the **Desktop** view. Sign in with password and MFA.
3. Set the language of Teams web to **English**: the agent reads some English texts.
4. Back in the app, the chat list appears and the status pill turns green within a minute.

A slot is free again when its owner removes the account. `SLOT_COUNT` and `ACCOUNTS_PER_USER` set the limits.

Each account has one status, chosen in **Settings** → **Teams accounts** (each row shows name, email and organization, as the accounts of one person share the name): **Always on**, **Checked every 1 h**, **2 h** or **4 h**, or **Stopped** (still signed in, nothing is read). An account used now and then does not have to run all the time: set it to **Checked every 1 h**, **2 h** or **4 h** instead of **Always on**. Its browser then runs only while it is checked (a minute or two: start, whole chat list, Activity feed, stop), one account at a time, and saves about 1.3 GB of memory the rest of the time. The account menu shows the status of every account on its right: **Active** (always on), **Stopped**, or when the next check updates it (**Updating in 1 h 20 min**, **Updating now** while it runs), with the last check under the name ("Checked 14:05"); the account page says the same ("Checked 14:05 · next 15:05") and shows the chats and counts of its last check, with a **Check now** button. When a check finds unread chats or notifications that were not there at the previous one, one notification says how many. A check that finds Teams signed out shows **Microsoft sign-in needed**: **Start to sign in** runs a check that waits ten minutes for the sign-in in the remote desktop. The status changes only in Settings; the page of a stopped account also has a **Start** button, which starts it again in the status it had.

The account menu shows under each name its email and organization and, when there is one, what the account is doing (still signed in, last check, sign-in needed); next to it, its unread chats plus the notifications not yet seen on this device; with more than one account, the menu button shows the total of the accounts not on screen. On a phone, where the menu hides while a chat is open, the back arrow of the chat shows the same total. A checked account counts what its last check found. A stopped account counts nothing: it reads nothing new until it is started.

## 6. Phone

TeamsRelay is a PWA: installed from the browser, it opens like an app, with icon and notifications.

- **iPhone**: open `https://<DOMAIN>` in Safari, sign in, Share → **Add to Home Screen**. Open TeamsRelay from the Home Screen icon, tap **Enable notifications**, allow. Push notifications reach only the installed app.
- **Android**: open the site in Chrome, menu → **Install app**, then **Enable notifications**. Or the Android app of `mobile/`, which rings for calls with the phone locked: see [Android app](#android-app).
- **PC**: any current browser, chats on the left and the open conversation on the right. The remote desktop opens in a browser tab. To hear incoming calls, install the app (the **Install** icon at the right of the address bar, Chrome or Edge): the installed app rings without a click, a tab only after a click or a key press in it since it loaded. In Chrome, **Settings** → **Performance** → **Always keep these sites active** → **Add** the address of TeamsRelay, so that Memory Saver never puts it to sleep.

The status panel shows how many devices of the user receive notifications. A device receives the notifications of every Teams account of its user; with more than one account, the title of a notification ends with the organization of its account (its email when Teams shows none), and a tap opens the app on that account.

While TeamsRelay is open, installed or in a tab, even in the background, a new message rings a bell of the app instead of the sound of the device, and its notification comes quiet; with the app closed the device plays its own sound. **Settings** → **Notifications on this device** → **Bell for new messages** turns it off on that device, **Play** tries it. A tab plays sound only after a click or a key press in it since it loaded: until then the device sound stays.

The title of the page counts what waits in every account, as the icon of the installed app does: **(5) TeamsRelay**. A call missed on an account always on arrives as a notification of its own a few seconds after it ends (*Missed call from Anna Rossi*), and counts in red on the **Calls** tab.

An incoming Teams call arrives as a notification that alerts again every 5 s while the call rings and turns quiet when it stops ("Call from Anna Rossi, ended after 9 s"); an iPhone gets one notification when the call starts and one when it ends. Its sound is the one of the device. On Android it can be told apart from other apps: long-press a TeamsRelay notification, open its settings and pick a sound (it applies to messages too). Only accounts whose browser runs can see a call (see [limitations](limitations.md)).

While the app is open, a call also shows a banner on top ("Anna Rossi is calling (Contoso)") and the app rings until the call ends; **Mute** silences that call. The **Calls** tab lists the missed calls Teams shows in its activity feed (a red count for the ones not seen on this device yet) and the calls that rang while the account ran, with how long. An account checked every few hours sends a notification for each missed call its check finds.

## Android app

The Tauri app of `mobile/` shows the web app and gets its notifications through Firebase Cloud Messaging: calls ring with the ringtone of the phone until they end, messages and alerts arrive as in the PWA. It needs a Firebase project of your own; Firebase Cloud Messaging costs nothing and the project stays on the free Spark plan (no billing account).

1. [Firebase console](https://console.firebase.google.com): **Create a project** (Google Analytics is not needed).
2. In the project, **Add app** → **Android**, package name `io.github.aptul9.teamsrelay`, **Register app**, then **Download google-services.json**. The other steps of that page (Gradle, SDK) are not needed.
3. The APK takes the file from a repository secret: GitHub → the repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, name `GOOGLE_SERVICES_JSON`, value the content of the file (or `gh secret set GOOGLE_SERVICES_JSON < google-services.json`). The file carries an API key: it stays out of git.
4. The server sends through a service account of the same project: [Google Cloud console](https://console.cloud.google.com) → the project → **IAM & Admin** → **Service accounts** → **Create service account**, role **Firebase Cloud Messaging API Admin** only; then its **Keys** → **Add key** → **Create new key** → JSON. Save the file as `fcm/service-account.json` next to `docker-compose.yml`, readable by the owner only, and restart the accounts so that their agents read it: `docker compose up -d --force-recreate browsers`. The agent log then shows `fcm=true`. An organization policy (`iam.disableServiceAccountKeyCreation`) can forbid keys: a project of a personal Google account has none.
5. Build the APK: GitHub → **Actions** → **Android app** → **Run workflow**, then download the artifact `teamsrelay-android-debug` of the run and install `app-universal-debug.apk` on the phone (allow the install from that source). It is signed with a debug key made for the run: installing the APK of another run over it needs the app removed first.
6. Open TeamsRelay on the phone, give the address of the server, sign in and allow notifications. The app registers the phone at each start and each return to it; the status panel of the web app counts it with the other devices. To change the server later: long press on the app icon → **Change server**, or **Change server** in the account menu of the app (also under the sign-in form); the previous server forgets the phone.
7. The ringtone and the other sounds are the ones of the channels of the app: Android **Settings** → **Apps** → **TeamsRelay** → **Notifications** (**Calls**, **Calls ended**, **Messages**, **TeamsRelay**).

ntfy can ring as well, without the app: install the ntfy app on the phone and subscribe to a topic of your own (a long random name: anyone who knows the topic of ntfy.sh can read it), set `NTFY_ENABLED=1` and `NTFY_TOPIC=<topic>` in `.env` (`NTFY_URL` for a server of your own), turn on **Keep alerting for highest priority** in the settings of the ntfy app, and restart the accounts (`docker compose up -d browsers`). Messages go there too, and ntfy carries their text in clear.

## Upgrading from the single-user release

Releases up to commit `7b26cb4` had one login (`UI_USER`, `UI_PASS`) and no users. Before deploying a multi-user release, add to `.env` on the server:

- `BETTER_AUTH_SECRET` (at least 32 characters). An existing `SESSION_SECRET` of 32 characters or more is accepted instead.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD`.

On the first start the administrator receives the existing Teams accounts (their browser sessions stay signed in) and the devices already registered for notifications. Keep `UI_USER` and `UI_PASS` in `.env` until the new release is confirmed: an automatic rollback starts the previous release, which needs them.

## Local development

The whole stack runs with Docker Desktop, on `http://localhost:8090`, bound to `127.0.0.1`.

```bash
docker compose --env-file compose.local.env -f docker-compose.yml -f compose.local.yml up -d --build
```

- Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` of `compose.local.env`, local test values.
- Caddy serves plain HTTP: `localhost` is a secure context, so the service worker and Web Push work without a certificate.
- Named volumes replace `data/` and `config/`: `tr_data`, and `tr_profiles` with one directory per account as in `config/`. On the Windows filesystem SQLite locking and the symlinks of the Chromium profile are unreliable.
- Sample chats without a signed-in Teams: `docker compose cp app/scripts/seed-slot.mjs webapp:/app/seed-slot.mjs`, then `docker compose exec webapp node /app/seed-slot.mjs /data 1` (slot 1 must belong to your user).

Code: `app/`, one package for the web app (Next.js), the agent (`src/agent`), the supervisor of the browsers container (`src/supervisor`) and the [local relay](#local-relay) (`src/local`). Checks, from `app/`:

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
```

`npm test` covers the web app and the agent: unit tests, the page scripts in the local Google Chrome on pages captured from Teams, and the agent bundle run as a process against a local Chrome (about two minutes: it waits for the real 60 s exit). The tests of the supervisor that need process groups, user ids and unix sockets run on Linux and macOS only. `npm run build` builds the web app, the agent (`dist/agent.cjs`), the supervisor (`dist/supervisor.cjs`) and the local relay (`dist/relay.cjs`).

After a change, `docker compose ... up -d --build` rebuilds both images and recreates what changed; a new browsers image restarts every account. The code of agent and supervisor is inside the image, nothing is mounted.

Stop everything with `docker compose --env-file compose.local.env -f docker-compose.yml -f compose.local.yml down`; `down -v` also deletes the volumes, Teams sessions included.

### Profiles of an earlier local stack

Local stacks of earlier releases kept one volume per account: `tr_config` for account 1, `tr_config_N` for account N. Copied into `tr_profiles` before the first `up` with this overlay, the accounts stay signed in; an account started before the copy already has a new, signed-out profile there. Volume names start with the Compose project, the name of the checkout directory (`teamsrelay` below): `docker volume ls -q --filter name=tr_config` lists the old ones.

One `-v` per old volume, mounted read only; they stay as they are. The copy stops at an account that already has a directory in `tr_profiles` (`File exists`): with the browsers stopped, delete that directory and copy again.

```bash
docker compose --env-file compose.local.env -f docker-compose.yml -f compose.local.yml stop browsers
docker compose --env-file compose.local.env -f docker-compose.yml -f compose.local.yml up --no-start browsers
docker run --rm --network none --entrypoint sh \
  -v teamsrelay_tr_config:/old/1:ro -v teamsrelay_tr_config_2:/old/2:ro -v teamsrelay_tr_profiles:/profiles \
  teamsrelay -c 'for d in /old/*; do mkdir /profiles/${d##*/} && cp -a $d/. /profiles/${d##*/}/ || exit 1; done'
docker compose --env-file compose.local.env -f docker-compose.yml -f compose.local.yml up -d
```

Once the accounts are green again, delete the old volumes mounted above: `docker volume rm teamsrelay_tr_config teamsrelay_tr_config_2`.

## Local relay

One Teams account on a machine that stays on (workstation, mini-PC), without Docker: a browser window signed in to Teams, one Node process, notifications on the phone. What it is and what it leaves out: [architecture.md](architecture.md#local-relay).

Requirements:

- Node 24 or later (checked on 26), Google Chrome or Microsoft Edge installed.
- A desktop session on the machine: the relay browser is a normal window, where the sign-in happens. The machine must not sleep.
- Teams web allowed for the account in a browser. The relay gives Teams `en-US` as the browser language, whatever the language of the machine.

First run, from `app/`:

```bash
npm ci --ignore-scripts
npm run relay:setup
npm run build:relay
npm run relay:login
```

- `npm ci --ignore-scripts`: better-sqlite3 ships prebuilt binaries; without the flag npm tries to compile it (Visual Studio on Windows).
- `npm run relay:setup` writes `relay.env` from `relay.env.example`, the push keys (`state/vapid`) and the API token (`state/token`), and prints the token. Run it again to see the token; it never replaces what exists.
- `npm run relay:login` opens the relay browser on Teams. Sign in there, MFA included, and answer "Yes" to "Stay signed in?". The window closes once Teams shows the chats.

Running:

```bash
npx pm2 start ecosystem.config.cjs
npx pm2 save
```

The relay opens its browser window on Teams. The window can stay behind other windows, on another virtual desktop or minimized; closing it only makes the relay open it again. Stop: `npx pm2 stop teamsrelay`. Log: `npx pm2 logs teamsrelay`.

Start at logon on Windows, once, after `pm2 save` (a Windows service would run in session 0, where the browser window cannot be shown):

```bash
powershell -File scripts/relay-autostart.ps1
```

It registers the scheduled task `TeamsRelay` (`pm2 resurrect` at logon, normal priority); `-DryRun` prints the task without registering it. On Linux: `npx pm2 startup` for the user of the desktop session.

Phone: the relay listens on `127.0.0.1:8787` and the phone needs a way in over HTTPS, since a service worker needs a secure context. Two ways, chosen by the owner of the machine:

- **Tailscale Serve**: phone and machine in one tailnet with HTTPS certificates enabled, then `tailscale serve --bg --https=443 http://127.0.0.1:8787`. The relay stays on loopback; the phone reaches it wherever it has a connection.
- **LAN**: `RELAY_BIND` on the LAN address and `RELAY_TLS_CERT`, `RELAY_TLS_KEY` from a CA the phone trusts. Home network only.

The phone opens the relay address, enters the token once and taps **Notifications**. On iPhone, notifications reach only the app added to the Home Screen. Tapping a notification opens its chat; tapping a message offers reply, reactions, edit, delete, undo. **Test notification** in the menu runs a full check and answers with a push.

When Teams signs out, the relay pushes "Teams signed out" after a minute and its window shows the sign-in page: sign in there, the relay pushes "Teams back". Commands meanwhile answer 409.

Checks of the relay are part of `npm test`; `node dist/relay.cjs --check` loads the packages, the page scripts and the files of the app.

## An account on another computer

A Teams account whose browser runs on another computer (a laptop, a PC at the office) can show in the web app next to the accounts of the browsers container: the [local relay](#local-relay) on that computer reads it and joins this server ([design](design/2026-09-27-relay-joins-server.md)). Only the relay opens connections, to the web app over HTTPS: nothing on that computer has to be reachable, and the phone keeps using the web app of the server.

1. In the web app: account menu → **Add from another computer…**. A dialog shows two lines, once: `SERVER_URL` (the public address of this web app, `APP_URL`) and `SERVER_TOKEN`. **Copy** copies them; where the browser allows no copy (a page on plain HTTP) it leaves them selected for Ctrl+C.
2. On the other computer, set up the relay as above (`npm ci --ignore-scripts`, `npm run relay:setup`, `npm run build:relay`), add the two lines to `app/relay.env`, and sign in once with `npm run relay:login`.
3. Start it (`npx pm2 start ecosystem.config.cjs`, `npx pm2 save`, and the logon task on Windows). Within a minute the account shows its chats in the web app.

The account then works like the others in the app, with these differences:

- No remote desktop: the sign-in happens in the relay window on that computer, and the app says so when Teams asks for one.
- Its status is its relay's: **Active** while the relay syncs, **Not connected** a minute after it stopped; no **Stopped** or **Checked every N h** modes.
- Notifications go from this server to the devices of its owner, with the push keys of the server (`vapid/`, mounted in the web app; `VAPID_SUBJECT` and `NTFY_*` of `.env` apply).
- **Settings** → **Teams accounts** → **New token** replaces the token: the relay stops syncing until its `relay.env` gets the new one.
- Removing the account deletes its data here and its token; the relay keeps its own Teams session until it is stopped there.

Joined, the relay keeps its own app on loopback, without devices of its own.
