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
| Storage | Status changes only, as stretches; a poll with the same status extends the current one. In a database of its own, `data/status.db`, not in the account's `data/N/messages.db`: removing or re-adding an account (done with Tesco on 2026-11-03) deletes `data/N/`, and the history of the challenge must outlive that. |
| Dashboard | A real dashboard, designed with the ui-ux-pro-max skill (section Dashboard and visualization). |
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

### data/status.db: `presence_log`

Where it lives on prod: `/opt/teamsrelay/data/status.db` on the host (the data volume already holding `app.db` and `N/messages.db`), `/data/status.db` in the web app container, `/root/data/status.db` in the browsers container. WAL mode, `busy_timeout` 8 s, like the other databases. Schema in `src/shared/status-db.ts`, created by whichever side opens it first. The light agents write; the web app reads and deletes.

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

Size: one row per status change, a few dozen a day per person: under 1 MB a year for two people.

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
4. Retention: rows in `status.db` of names no page tracks any more, and of pages ended more than 7 days ago, are deleted once an hour.

A presence call that fails leaves everything as it is and is logged once per failure kind per hour.

## Web app

### Stats, `src/lib/status-stats.ts` (pure, tested)

From the stretches of a day, clipped to the day:

- **Hours per status:** available, busy, dnd, brb, away, offline, and no data (gaps and `unknown`). A past day adds up to its length (24 h; 23 or 25 on a DST change); today adds up to the time elapsed so far.
- **First online / last online:** first `since` and last `until` of a stretch not offline and not unknown.
- **Longest Available streak:** longest run of adjacent available stretches with no gap, in minutes.
- **Green share:** available hours over online hours (every status but offline and no data).
- **By hour:** for each of the hours of the day, the status that held most of it (no data when most of it is a gap), for the heat map.

Over the challenge (from the first day with data, or the `added` date): the same per day, plus totals and averages.

### Public API, `GET /api/status/<slug>`

No login. 404 for an unknown or deleted slug. Answer:

```json
{ "name": "Camilla Marini", "now": { "status": "busy", "since": 1793700000, "fresh": true },
  "days": [ { "day": "2026-11-03", "hours": { "available": 3.2, "busy": 3.1, "dnd": 0.5, "brb": 0.2, "away": 0.4, "offline": 13.8, "nodata": 2.8 },
              "firstOnline": "08:47", "lastOnline": "18:12", "longestAvailable": 95, "green": 0.43,
              "byHour": ["offline", "offline", "...", "available", "busy", "...", "nodata"],
              "stretches": [[1793690000, 1793691200, "available"]] } ],
  "ends": 0, "updated": 1793700060 }
```

`fresh` false when the newest `until` is older than `GAP`: the card says "no data since HH:MM". `byHour` has one entry per hour of that day (23 or 25 on a DST change). Stretches only for today and yesterday (the timeline); older days carry the totals and `byHour` only. `Cache-Control: public, max-age=30`.

### Page, `src/app/[slug]/page.tsx`

No login. `notFound()` for an unknown slug. `robots: noindex, nofollow`. A client component fetches the API every 60 s. Content and look per section Dashboard and visualization.

## Dashboard and visualization

The page is the product: a dashboard that is good to look at and quick to read, on a phone first. It is designed and checked with the ui-ux-pro-max skill (`~/.agents/skills/ui-ux-pro-max`), not improvised.

### How the skill is used

1. Design system first: `search.py "<product> <keywords>" --design-system --density 7 --motion 4 --persist -p "Status Challenge" --output-dir app`, which writes `app/design-system/status-challenge/MASTER.md`, then a page override with `--page "status"`. Committed with the code; the page follows them.
2. Chart choices from `--domain chart`, UX details from `--domain ux`, implementation from `--stack nextjs` and `--stack shadcn`.
3. Before delivery: the skill's pre-delivery checklist (`references/pro-rules.md`), each item checked on the real page.

First pass of the skill (2026-11-03), to start from:

- Style: Minimalism and Swiss style, the one it gives for dashboards: grid, clear hierarchy, high contrast, little decoration, light and dark.
- Not taken: its page pattern (hero, features, call to action: a landing page) and its fonts (Fira, loaded from Google): the page keeps the app's Geist and theme tokens, and loads nothing from third parties.
- Charts: time of day by hour across days as a heat map; hours compared as bars; never meaning by color alone (labels or patterns too); values on hover and on keyboard focus; a data table as fallback.
- Motion: short stagger on load (300-450 ms), off under `prefers-reduced-motion`.

### Content, top to bottom

- **Now:** name, a large status dot with the status in words ("Busy"), since when, and how long that is. "No data since HH:MM" when the collector is silent.
- **Today:** a band of the whole day, 00:00 to 24:00, one segment per stretch, a marker at the current time; hover or focus on a segment gives status, from, to, duration.
- **Challenge at a glance:** a heat map, one row per day of the challenge, 24 columns (hours), each cell the status that held most of that hour, no data hatched.
- **Hours per day:** stacked bars, one per day, segments per status, direct labels on the larger segments.
- **Scoreboard:** earliest first online, latest last online, longest Available streak, green share: today against the best day of the challenge, as stat cards.
- **Data table:** the same numbers per day, collapsed under the charts, for screen readers and exact values.

### Rules

- Colors as Teams draws the statuses: available green, busy and dnd red, brb and away yellow, offline grey, no data hatched; from the app's theme tokens (`--success`, `--destructive`, `--warning`, `--muted-foreground`), so light and dark both work. Busy and dnd, brb and away, told apart by a pattern or an icon as well.
- Every chart has a title, a legend and a text summary of what it shows ("Mostly available between 09:00 and 13:00").
- Layout: one column at 375 px, two at 1024 px and up; no horizontal scroll at any width; touch targets 44 px.
- Charts in plain SVG, no chart library; nothing shifts while the data loads (space reserved).

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
- Page: rendered in Chrome with a fixed API answer at 375, 768, 1024 and 1440 px, light and dark: every section shows, no horizontal scroll, the values of a segment come up on keyboard focus, screenshots read by eye; then the ui-ux-pro-max pre-delivery checklist.
- Live on prod: `/kamila` and `/damian` for an hour, statuses checked against what Teams shows.
