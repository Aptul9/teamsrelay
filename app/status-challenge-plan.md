# Status challenge: implementation plan

> For agentic workers: build task by task, test first (vitest, red before green). Steps use checkbox (`- [ ]`) syntax.

**Goal:** public pages `/kamila` and `/damian` with the Teams status history of two AGAP2 colleagues, collected by the light agent of slot 4, per `app/status-challenge-spec.md`.

**Architecture:** the light agent of an account polls the presence of the people its pages track once per poll and writes status stretches into `data/status.db`. The web app reads that file for a public JSON API and a public dashboard page, and keeps the page configuration in `app.db` table `status_pages`, managed from a card in `/admin`.

**Tech stack:** Next.js 16 (app router), React 19, better-sqlite3, zod, Tailwind 4 with the app's theme tokens, vitest 5, Playwright core with the local Chrome for page tests.

## Global constraints

- Statuses: `available`, `busy`, `dnd`, `brb`, `away`, `offline`, `unknown`; `nodata` only in stats.
- Mapping: Available, AvailableIdle `available`; Busy, BusyIdle `busy`; DoNotDisturb `dnd`; BeRightBack `brb`; Away `away`; Offline `offline`; anything else `unknown`.
- `GAP` = 3 × poll (180 s at `LIGHT_POLL` 60).
- Slug `[a-z0-9-]{2,32}`, not a top-level entry of `src/app` or `public`, not `desktop`.
- Times in the zone of the container (`TZ`, Europe/Rome on prod). The web app container has no `TZ` today (prod 2026-11-03: `teams-webapp` UTC, `teams-browsers` Europe/Rome): `docker-compose.yml` gives it `TZ` too.
- `status.db`: WAL, `busy_timeout` 8 s, next to `app.db`.
- No chart library, no third-party fonts or scripts. Public pages carry `noindex, nofollow`.
- Checks: `npx tsc --noEmit -p .`, `npx eslint src test`, `npx vitest run` (known unrelated failures: `test/local/server-link-h2.test.ts`, one `test/call-audio.test.ts` test under a full run).

## Decisions taken while planning

- **A status change within `GAP` holds the old status until the change.** Spec: the time between the old `until` and the new `since` is no data. Read literally, every change leaves one poll (60 s) of no data, a few dozen minutes a day. Stats join a stretch to the next one when the next `since` is at most `GAP` after its `until`; a longer gap stays no data. The rows keep what was seen. The newest stretch runs to now while it is fresh.
- **Name resolution is reported by the agent** in its slot database, state key `status_names` (JSON `{name: mri or ""}`), so the admin card can say "not found in AGAP2" (tenant from the identity row).
- **Pages ended more than 7 days ago** lose their data in the agent's hourly retention, and their row in `status_pages` when the web app next lists pages (admin GET, API, page): the agent does not write `app.db` tables of the web app.
- **Reserved slugs at build time:** `next.config.ts` reads `src/app` and `public` and passes the list as `STATUS_RESERVED` (inlined by Next); tests and `next dev` without it read the folders at run time.
- **API answer carries `zone`** (the IANA zone of the server) besides the fields of the spec, so the browser formats times of the stretches in the zone of the challenge, not of the viewer.
- **End date** is a day (`YYYY-MM-DD`): `ends` = the next midnight in the zone.

## Files

| File | Role |
|---|---|
| `src/shared/status-db.ts` | schema of `status.db`, `statusOf`, record a poll, read stretches, retention deletes |
| `src/agent/light/status.ts` | `StatusCollector`: pages of the slot, name to mri, presence call, write, retention, logs |
| `src/agent/store/app-store.ts` | `statusPages()` read of `status_pages` |
| `src/agent/light/loop.ts`, `context.ts`, `main.ts`, `src/agent/config.ts` | collector wired in the loop after the chat list |
| `src/shared/slot-db/state.ts` | `STATE.statusNames`, `StatusNames` |
| `src/lib/appdb.ts` | `status_pages` table in `migrateAppSchema` |
| `src/lib/status-pages.ts` | slug rules, CRUD of `status_pages`, purge of ended pages, the API answer |
| `src/lib/status-stats.ts` | pure stats of a day and of the challenge, zone helpers |
| `src/app/api/status/[slug]/route.ts` | public API |
| `src/app/api/admin/status-pages/route.ts` | admin API |
| `src/app/[slug]/page.tsx` | public page |
| `src/components/StatusDashboard.tsx` | the dashboard (client) |
| `src/components/StatusPagesCard.tsx` | admin card, rendered by `AdminPanel.tsx` |
| `next.config.ts` | `STATUS_RESERVED` |
| `docker-compose.yml` | `TZ` for `webapp` |

---

### Task 1: status.db and the status mapping

**Files:** create `src/shared/status-db.ts`; test `test/status-db.test.ts`.

**Produces:**
- `STATUSES: readonly ["available","busy","dnd","brb","away","offline"]`, `type Status = (typeof STATUSES)[number] | "unknown"`
- `statusOf(availability: string): Status`
- `openStatusDb(file: string): Database.Database` (mkdir, WAL, busy_timeout 8000, schema)
- `recordStatuses(db, seen: { name: string; mri: string; status: Status }[], now: number, gap: number): void` (one transaction)
- `stretchesOf(db, name: string, from: number, to: number): [number, number, Status][]` (stretches overlapping `[from, to)`, by `since`)
- `newestOf(db, name: string): { since: number; until: number; status: Status } | null`
- `firstSince(db, name: string): number | null`
- `deleteStatusesExcept(db, keep: readonly string[]): number`, `deleteStatusesOf(db, name: string): number`
- `STATUS_GAP = 180`

- [ ] **Step 1: failing tests**

```ts
it("maps the availability as Teams draws it", () => {
  expect(["Available", "AvailableIdle", "Busy", "BusyIdle", "DoNotDisturb", "BeRightBack", "Away", "Offline", "PresenceUnknown", ""].map(statusOf))
    .toEqual(["available", "available", "busy", "busy", "dnd", "brb", "away", "offline", "unknown", "unknown"]);
});
it("extends the newest stretch on the same status within the gap, opens one on a change or after a gap", () => {
  const db = openStatusDb(path.join(tempDir(), "status.db"));
  const seen = (status: Status) => [{ name: "Anna Rossi", mri: "8:orgid:a", status }];
  recordStatuses(db, seen("busy"), 1000, 180);
  recordStatuses(db, seen("busy"), 1060, 180);
  recordStatuses(db, seen("available"), 1120, 180);
  recordStatuses(db, seen("available"), 1500, 180);
  expect(stretchesOf(db, "Anna Rossi", 0, 2000)).toEqual([[1000, 1060, "busy"], [1120, 1120, "available"], [1500, 1500, "available"]]);
});
it("deletes the rows of names no page tracks, and of one name", () => { /* two names, keep one, then delete it */ });
```

- [ ] **Step 2:** `npx vitest run test/status-db.test.ts`: FAIL, module not found.
- [ ] **Step 3:** implement `src/shared/status-db.ts` with the schema of the spec section Data.
- [ ] **Step 4:** tests PASS.
- [ ] **Step 5:** commit `feat: status history database of the status challenge`.

### Task 2: the collector of the light agent

**Files:** create `src/agent/light/status.ts`; modify `src/agent/store/app-store.ts`, `src/shared/slot-db/state.ts`, `src/agent/light/context.ts`, `src/agent/light/loop.ts`, `src/agent/light/main.ts`, `src/agent/config.ts`; test `test/agent/light-status.test.ts`.

**Consumes:** Task 1.

**Produces:**
- `AppStore.statusPages(): { slug: string; slot: number; name: string; ends: number }[]` (every page, `[]` without the table)
- `STATE.statusNames = "status_names"`, `StatusNames = z.record(z.string(), z.string())`
- `class StatusCollector { constructor(o: { pages: () => StatusPageRow[]; file: string; slot: number; gap: number }); poll(l: Light, now?: number): Promise<void> }`
- `Light.status?: StatusCollector`, `Config.statusDb: string` (`status.db` next to `APP_DB`)
- loop: `await l.status?.poll(l)` right after `readList(l)` in the list branch

- [ ] **Step 1: failing tests** (fake `LightApi.presence`, temp `status.db`, temp slot database, `l.people` and `l.list` filled):
  - same status extends, a change opens, a poll after more than `GAP` opens;
  - a failed presence call writes nothing and logs once per hour per kind;
  - a person missing from the answer gets nothing;
  - a page of another slot is not polled; an ended page (`ends` in the past) is not polled;
  - name to mri: from `l.people` without case, else the other member of the 1:1 chat of that name; unresolved names in `status_names` as `""`;
  - pages read at most every 60 s;
  - retention once an hour: rows of names no page tracks, and of pages ended more than 7 days ago, deleted; an ended page of less than 7 days keeps its rows.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** implement; wire into `main.ts` and the loop.
- [ ] **Step 4:** PASS, and `test/agent/light-loop.test.ts` still PASS.
- [ ] **Step 5:** commit `feat: light agent collects the status of the people of the status pages`.

### Task 3: stats of a day

**Files:** create `src/lib/status-stats.ts`; test `test/status-stats.test.ts`.

**Consumes:** `Status`, `STATUSES` of Task 1.

**Produces:**
- `type Stretch = [since: number, until: number, status: Status]`
- `type Hours = Record<(typeof STATUSES)[number] | "nodata", number>`
- `type DayStats = { day: string; hours: Hours; firstOnline: string; lastOnline: string; longestAvailable: number; green: number | null; byHour: (Status | "nodata")[] }`
- `dayOf(t: number, zone: string): string`, `dayStart(day: string, zone: string): number`, `nextDay(day: string): string`, `hourBounds(day: string, zone: string): number[]` (25 values on a normal day, 24 or 26 on a DST day), `clock(t: number, zone: string): string`
- `joinStretches(stretches: Stretch[], gap: number, now: number): Stretch[]` (the decision on gaps above)
- `dayStats(stretches: Stretch[], day: string, o: { zone: string; now: number; gap: number }): DayStats`

- [ ] **Step 1: failing tests:**
  - a past day sums to 24 h, today to the time elapsed;
  - clipping at midnight: a stretch 23:00-01:00 counts one hour on each day;
  - a change within `GAP` holds the old status; a longer gap is no data; `unknown` is no data;
  - longest Available streak breaks across a gap;
  - first and last online skip offline and unknown, `""` without any;
  - green share = available over online, `null` without online time;
  - by hour: the status that held most of each hour, no data where the gap holds most;
  - DST 2026-03-29 (23 h, 23 entries) and 2026-10-25 (25 h, 25 entries) in Europe/Rome.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: stats of a day of the status challenge`.

### Task 4: status_pages and the public API

**Files:** modify `src/lib/appdb.ts`, `next.config.ts`; create `src/lib/status-pages.ts`, `src/app/api/status/[slug]/route.ts`; test `test/status-routes.test.ts`.

**Consumes:** Tasks 1, 3.

**Produces:**
- `type StatusPage = { slug: string; slot: number; name: string; added: number; ends: number }`
- `SLUG = /^[a-z0-9-]{2,32}$/`, `reservedSlugs(): Set<string>`, `slugProblem(db, slug): string | null`
- `listStatusPages(db)`, `statusPageOf(db, slug)`, `addStatusPage(db, p)`, `setStatusPageEnds(db, slug, ends)`, `deleteStatusPage(db, statusDb, slug)`, `purgeEndedPages(db, statusDb, now)`
- `statusDbFile(): string` (next to `config.appDb`), `serverZone(): string`
- `type StatusAnswer` (shape of the spec plus `zone`), `statusAnswer(slug: string, now?: number): StatusAnswer | null`
- `GET /api/status/<slug>`: 200 with `Cache-Control: public, max-age=30`, 404 unknown.

- [ ] **Step 1: failing tests:** unknown slug 404 without any session mock; a page with stretches answers the shape (name, now with fresh true/false, days from the added day to today, stretches only on today and yesterday, byHour length, ends, updated, zone); a page ended more than 7 days ago is gone (404, row and data deleted); `reservedSlugs()` holds `admin`, `api`, `login`, `sw.js`, `desktop` and every top-level entry of `src/app` and `public`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: public API of the status pages`.

### Task 5: admin API

**Files:** create `src/app/api/admin/status-pages/route.ts`; test `test/status-admin-routes.test.ts`.

**Consumes:** Task 4, `requireAdmin` of `src/lib/session.ts`, `slotsOf`, `SlotReader` (identity, `status_names`).

**Produces:** `GET` `{ pages: AdminStatusPage[], accounts: { slot: number; label: string; light: boolean }[] }` with `AdminStatusPage = StatusPage & { tenant: string; collecting: boolean; reason: string; last: { status: Status; since: number; until: number } | null }`; `POST {slug, slot, name}` 200, 400 (bad slug, name, account not light or not the admin's), 409 (reserved, taken); `PATCH {slug, ends: "YYYY-MM-DD" | ""}`; `DELETE {slug}`.

- [ ] **Step 1: failing tests:** non-admin 403 on every method (`requireAdmin` mocked to throw `HttpError(403)`); reserved slug 409 with the reason; taken slug 409; account not light 400; add, then GET lists it with `reason` "not found in AGAP2" once the agent wrote `""` for the name, and `collecting` true once it wrote an mri; PATCH sets `ends` to the next midnight, `""` clears; DELETE removes the row and the rows in `status.db`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: admin API of the status pages`.

### Task 6: the dashboard page

**Files:** create `src/app/[slug]/page.tsx`, `src/components/StatusDashboard.tsx`; test `test/status-page.test.ts`, `test/status-page.tsx`.

**Consumes:** Tasks 3, 4; `app/design-system/status-challenge/MASTER.md` and `pages/status.md`.

**Produces:** `StatusDashboard({ slug, initial }: { slug: string; initial: StatusAnswer })`, fetching `/api/status/<slug>` every 60 s.

- [ ] **Step 1: failing test** (esbuild bundle of `test/status-page.tsx` with a fixed answer, CSS compiled from `globals.css` by `@tailwindcss/postcss`, headless Chrome): at 375, 768, 1024, 1440 px, light and dark: every section heading shows (Now, Today, Challenge at a glance, Hours per day, Scoreboard, Data), `scrollWidth <= innerWidth`, keyboard Tab onto a segment of Today shows its status, from, to and duration in the readout, a heat map cell likewise, screenshots written to `TR_SHOTS` when set.
- [ ] **Step 2:** FAIL. **Step 3:** implement per the design files. **Step 4:** PASS.
- [ ] **Step 5:** screenshots read by eye, pre-delivery checklist of `references/pro-rules.md` item by item.
- [ ] **Step 6:** commit `feat: public dashboard of a status page`.

### Task 7: admin card

**Files:** create `src/components/StatusPagesCard.tsx`; modify `src/components/AdminPanel.tsx`.

- [ ] list (link, person, account, collecting or reason, last status), add dialog (slug, light account, name), end date (date field, clear), delete with confirm dialog.
- [ ] checked by hand against `next dev` with a seeded `app.db`, then on prod.
- [ ] commit `feat: admin card of the status pages`.

### Task 8: deploy and live check

- [ ] `TZ` for `webapp` in `docker-compose.yml`.
- [ ] full checks, PR, owner's yes, merge (deploys, restarts the 5 accounts), run green, slots green.
- [ ] pages `kamila` (Camilla Marini) and `damian` (Damiano Bogni) on slot 4 through the admin card on prod.
- [ ] an hour of `/kamila` and `/damian` against the presence Teams answers for both, read on prod.
- [ ] screenshots of the live pages read by eye; vault and Board.
