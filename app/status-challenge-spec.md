# Status challenge: spec

Written 2026-11-03. Not built.

## Goal

A public page per tracked person with their Teams status today and over the days of a group challenge: a live card, a timeline of the day, hours per status, a scoreboard. The people tracked agreed to it. First pages: `/kamila` (Camilla Marini) and `/damian` (Damiano Bogni), both in the AGAP2 tenant (slot 4 on prod).

## Facts it rests on (prod, 2026-11-03)

- `POST https://presence.teams.microsoft.com/v1/presence/getpresence/` with body `[{"mri": "8:orgid:<oid>"}]` and a token of audience `https://presence.teams.microsoft.com/.default` answers 200 per person with `presence.availability` (the status Teams shows), plus activity, device and calendar fields this feature does not use. Both people answered `Busy`.
- The light agent of a light account renews that token from its stored sign-in (`src/agent/light/token.ts`, scope `PRESENCE`) and already calls the service for its chat list (`LightApi.presence`).
- Both people have a 1:1 chat with the AGAP2 account; `fetchShortProfile` names them (tenant `AGAP2`).
- `everbright.it` DNS is at Seeweb with no wildcard: a path needs nothing, a subdomain needs a record there.

## Decisions

| Topic | Decision |
|---|---|
| Where | Inside TeamsRelay: the light agent of the account collects, the web app shows. A separate service would need its own sign-in, or would renew the same refresh token file as the light agent. |
| Accounts | Light accounts only. An account set back to Always on or stopped collects nothing until it is light again; the page shows the gap. |
| Address | A path on the TeamsRelay domain, one per person: `/kamila`, `/damian`. Names changeable in the admin card. |
| Access | Public, no login, no key (owner's choice). Pages carry `noindex`. |
| Poll | Every poll of the light agent (`LIGHT_POLL`, 60 s by default): one presence call for all tracked people of the account. |
| What is measured | The status alone, as Teams shows it next to the name: Available, Busy, Do not disturb, Be right back, Away, Offline. Why someone is busy (a call, a meeting) is not stored. |
| Storage | Status changes only, as stretches; a poll with the same status extends the current one. |
| Time | Days and clock times in the time zone of the containers (`TZ`, Europe/Rome). |
| Retention | Until the challenge ends. The end date is optional and set later in the admin card; with none, data is kept. Collecting stops at the end; data and pages are deleted 7 days after it. Deleting a page deletes its data at once. |
| Charts | Plain SVG drawn by the page, no chart library. |

## Data

### app.db: `status_pages`

```sql
CREATE TABLE IF NOT EXISTS status_pages(
  slug TEXT PRIMARY KEY,     -- path of the page, [a-z0-9-]{2,32}, not a route of the app
  slot INTEGER NOT NULL,     -- the light account that collects
  name TEXT NOT NULL,        -- the person as Teams shows the name ("Camilla Marini")
  added INTEGER NOT NULL,    -- Unix s
  ends INTEGER NOT NULL DEFAULT 0  -- Unix s of the end of the challenge, 0 none
);
```

Reserved slugs, refused: every top-level entry of `src/app` and `public` (`admin`, `api`, `consent`, `files`, `healthz`, `login`, `mcp`, `media`, `remote`, `settings`, `static`, `sw.js`, `manifest.webmanifest`) and the paths Caddy takes (`desktop`). The check reads both folders at build time, so a route added later is reserved too.

### data/N/messages.db: `presence_log`

```sql
CREATE TABLE IF NOT EXISTS presence_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,        -- as in status_pages.name
  mri TEXT NOT NULL,
  since INTEGER NOT NULL,    -- Unix s of the first poll that saw this status
  until INTEGER NOT NULL,    -- Unix s of the last poll that saw it
  status TEXT NOT NULL       -- available, busy, dnd, brb, away, offline, unknown (mapping below)
);
CREATE INDEX IF NOT EXISTS presence_log_name ON presence_log(name, since);
```

Added through `ADDED_TABLES` of `src/shared/slot-db/schema.ts`; not in `SLOT_TABLES` (a relay account has no light agent and syncs no such table).

`status` from `presence.availability`, as Teams draws it: Available and AvailableIdle `available`; Busy and BusyIdle `busy`; DoNotDisturb `dnd`; BeRightBack `brb`; Away `away`; Offline `offline`; PresenceUnknown and any other value `unknown`.

Rules of one poll, per person:

- Same `status` as the newest stretch, and its `until` at most `GAP` (3 × poll) ago: `until` = now.
- Otherwise: a new stretch with `since` = `until` = now. The time between the old `until` and the new `since` is no data.
- No answer for the person (call failed, signed out): nothing written.

## Collector

`src/agent/light/status.ts`, a step of the light loop after the chat list read:

1. The rows of `status_pages` for its slot, read from app.db through `AppStore` (at most every 60 s), with `ends` 0 or in the future.
2. Name to mri: the people the agent already knows (`l.people`, filled by the chat list), matched on `displayName` without case; else the other member of a 1:1 chat whose name is that one. Unresolved names are logged once per hour and retried at each poll.
3. One `LightApi.presence(mris)` call for all of them, then the rules above in one transaction.
4. Retention: rows of names no page tracks any more, and of pages ended more than 7 days ago, are deleted once an hour.

A presence call that fails leaves everything as it is and is logged once per failure kind per hour.

## Web app

### Stats, `src/lib/status-stats.ts` (pure, tested)

From the stretches of a day, clipped to the day:

- **Hours per status:** available, busy, dnd, brb, away, offline, and no data (gaps and `unknown`). A past day adds up to its length (24 h; 23 or 25 on a DST change); today adds up to the time elapsed so far.
- **First online / last online:** first `since` and last `until` of a stretch not offline and not unknown.
- **Longest Available streak:** longest run of adjacent available stretches with no gap, in minutes.
- **Green share:** available hours over online hours (every status but offline and no data).

Over the challenge (from the first day with data, or the `added` date): the same per day, plus totals and averages.

### Public API, `GET /api/status/<slug>`

No login. 404 for an unknown or deleted slug. Answer:

```json
{ "name": "Camilla Marini", "now": { "status": "busy", "since": 1793700000, "fresh": true },
  "days": [ { "day": "2026-11-03", "hours": { "available": 3.2, "busy": 3.1, "dnd": 0.5, "brb": 0.2, "away": 0.4, "offline": 13.8, "nodata": 2.8 },
              "firstOnline": "08:47", "lastOnline": "18:12", "longestAvailable": 95, "green": 0.43,
              "stretches": [[1793690000, 1793691200, "available"]] } ],
  "ends": 0, "updated": 1793700060 }
```

`fresh` false when the newest `until` is older than `GAP`: the card says "no data since HH:MM". Stretches only for today and yesterday (the timeline); older days carry the totals only. `Cache-Control: public, max-age=30`.

### Page, `src/app/[slug]/page.tsx`

No login. `notFound()` for an unknown slug. `robots: noindex, nofollow`. A client component fetches the API every 60 s.

- **Now:** name, a colored dot and the status in words ("Busy"), since when.
- **Today:** a band of the whole day, 00:00 to 24:00, one color per status, no data hatched.
- **Days:** stacked bars of hours per status, one bar per day of the challenge.
- **Scoreboard:** earliest first online, latest last online, longest Available streak, green share: today, and the best day of the challenge for each.

Colors as Teams draws the statuses: available green, busy and dnd red, brb and away yellow, offline grey, no data hatched; from the theme of the app (`--success`, `--destructive`, `--warning`, `--muted-foreground`), so light and dark both work.

### Admin card, `src/components/AdminPanel.tsx`

Admins only, through `/api/admin/status-pages` (GET, POST, PATCH, DELETE):

- List of pages: link, person, account, collecting or not (account light or not, name resolved or not), last status seen.
- Add: slug, account (light accounts of the admin), person name.
- End date: set or clear.
- Delete: the page and its data, after a confirm dialog.

## Error handling

- Name not found among the people of the account: the card says "not found in AGAP2"; nothing collected.
- Account not light, stopped, or signed out: the card says why; the page shows no data from then.
- A slug that clashes with a route or another page: 409 with the reason.

## Tests

- Collector: same status extends, change opens, gap opens, failed call writes nothing, ended page stops, retention deletes; with a fake `LightApi` and a temp slot database.
- Stats: status mapping, a past day sums to its length and today to the time elapsed, clipping at midnight, longest streak across a gap, first and last online, DST day (23 h and 25 h).
- API: unknown slug 404, public without session, shape above.
- Admin API: reserved slug refused, non-admin 403, delete removes data.
- Page: rendered in Chrome with a fixed API answer: the band, the bars and the cards show, no overflow at 360 px.
- Live on prod: `/kamila` and `/damian` for an hour, statuses checked against what Teams shows.
