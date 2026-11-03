# Status Page Overrides

> **PROJECT:** Status Challenge
> **Generated:** 2026-11-03 12:30:16, then edited to the decisions of `app/status-challenge-spec.md` (section Dashboard and visualization)
> **Page Type:** Dashboard / Data View, public, `/<slug>` (`src/app/[slug]/page.tsx`, `src/components/StatusDashboard.tsx`)

> Rules in this file **override** the Master file (`MASTER.md`). Only deviations from the Master are documented here.

---

## Not taken from the Master

- **Pattern** (Enterprise Gateway, hero, CTA): a landing page. The page is a dashboard of one person, no call to action.
- **Typography** (Fira Code, Fira Sans from Google Fonts): the page keeps the app's Geist (`next/font`, self-hosted) and loads nothing from third parties. Numbers in `tabular-nums`.
- **Colors** (navy palette): the app's theme tokens of `src/app/globals.css`, so light and dark both work with the rest of TeamsRelay.

## Kept from the Master

- Style Minimalism and Swiss: grid, clear hierarchy, high contrast, little decoration, light and dark.
- Density 7: 8-32 px spacing, cards with `p-4`/`p-5`, `gap-3`/`gap-4`.
- Motion 4: one short stagger of the cards on load (opacity and 8 px rise, 350 ms, 60 ms apart), CSS only, none under `prefers-reduced-motion`.
- Pre-delivery checklist of the Master and of `references/pro-rules.md`.

## Layout

- One column at 375 px, in the order of the spec; two columns from 1024 px (`lg:grid-cols-2`): Now beside Today, Challenge at a glance full width, Hours per day beside Scoreboard, Data per day full width. Grid items carry `min-w-0` so long text never widens the page (checked with text at 200%).
- Max width 72rem (`max-w-6xl`), page padding 12 px on phones, 24 px from 768 px.
- No horizontal scroll at any width: every chart is an SVG with a `viewBox` and `width: 100%`.
- Space reserved for every chart (fixed aspect or height), so nothing shifts when data arrives; the first answer comes with the HTML.

## Status colors

| Status | Token | Told apart also by |
|---|---|---|
| available | `--success` | solid fill |
| busy | `--destructive` | solid fill |
| dnd | `--destructive` | diagonal stripes |
| brb | `--warning` | dots |
| away | `--warning` | solid fill |
| offline | `--muted-foreground` at 38% over `--card` (opaque) | solid fill |
| no data | none | grey hatching on `--muted` |

Never meaning by color alone: the legend names each status with its pattern swatch, every segment and cell has its status in words on hover and focus, the data table carries every value.

## Charts (from `--domain chart`)

- **Today:** a band 00:00-24:00, one segment per stretch, a marker at the current time. Segments are focusable (`tabindex=0`, `role=img`, `aria-label` with status, from, to, duration); the readout line under the band shows the one hovered or focused. Space for the readout always reserved.
- **Challenge at a glance:** heat map, one row per day, one column per hour (23 or 25 on a DST day), each cell the status that held most of the hour, no data hatched, future hours of today empty. Cells focusable with the same readout.
- **Hours per day:** horizontal stacked bars, one per day, segments per status, the hours printed in segments wide enough for the label.
- **Scoreboard:** stat cards, today against the best day of the challenge: earliest first online, latest last online, longest Available streak, green share.
- **Data table:** the same numbers per day under a `<details>` closed by default.
- Each chart: title, legend, one-sentence text summary ("Mostly available between 09:00 and 13:00").

## Interaction

- Touch targets 44 px: the cells and segments are smaller, so the readout also works by tap (tap focuses the segment), and the table has every value.
- Focus ring visible (`outline-ring`), never removed.
- Data refreshed every 60 s in place; a collector silent past the gap says "No data since HH:MM" on the Now card.
