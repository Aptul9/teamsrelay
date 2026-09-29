# One desktop tab, a button per account

Date: 2026-09-29.

**Goal:** the owner opens the remote desktop in one browser tab and moves between accounts there: a bar above the desktop has a button per account, and a click brings the window of that account to the front of the desktop already on screen, with no new tab and no new connection.

## Decisions

- One desktop for every account (one Selkies, one labwc session): a second tab of the desktop cuts off the first, since Selkies keeps one controlling viewer (`Killing old client for 'primary'`). Two tabs side by side cannot work; the switch happens inside the tab, on the connection already open.
- The page is the web app's `/remote?account=N` (`/desktop/*` belongs to Selkies behind Caddy): a bar on top, the desktop below in an iframe opened on `/api/desktop/N` (the `desktop` row, the window of N to the front, then `/desktop/`), as the phone view of the app does.
- The bar lists the accounts whose window is on the desktop: not on another computer, not stopped, not checked every few hours between two checks (their browser runs only then). Label: the tenant, else the name, as in the account menu. The account in front is pressed.
- A click on another account: `POST /api/desktop/M`, the GET without the redirect: the `desktop` row of M, the window of M to the front. The iframe keeps its address; the keyboard goes back to the desktop. A failure keeps the pressed account and says so in the bar.
- On a PC, *Open the remote Teams* opens `/remote?account=N` in the tab named `teamsrelay-desktop`: the next opening, of any account, reuses that tab instead of cutting off the first. On a phone the Desktop view of the app stays. A `DESKTOP_URL` of another desktop keeps the previous behaviour, a new tab on that address.
- A window never brings itself to the front since PR 69 (labwc `ignoreFocusRequest`): the pressed account stays the one in front until another click, in the bar or in the app.
- Rejected: buttons injected into the page of Selkies (a third-party page rewritten by the proxy); one desktop per account (one Selkies and compositor per account, more CPU and memory while viewing); the Desktop view of the app on a PC (the desktop in a part of the window).

## Contract

- `POST /api/desktop/N`: session required (401), the account of the user (404), not on another computer (409). Answer `{ok: true, shown}`, `shown` false when the supervisor could not bring the window forward. Writes the `desktop` row as the GET does.
- Page `/remote?account=N`: session required (the login, then back here). An account not on the desktop: the first one that is. None: a line that says so, no iframe.

## Tests

- Route (`test/desktop-routes.test.ts`): POST for the owner brings the window forward and writes `desktop`, with no redirect; the account of another user 404 and nothing shown; an account on another computer 409; no session 401; supervisor not reachable `shown: false`.
- Page in Chrome (`test/desktop-switcher.test.ts`, harness `test/desktop-switcher-page.tsx`): the desktop opens on the account asked for, pressed; a click on another posts to its route, the iframe keeps its address and is not loaded again, the other one pressed; accounts on another computer, stopped or between checks not listed; a failed POST keeps the pressed account and shows why.
- Opening from the app (`desktopTarget` in `app/src/lib/client.ts`): the default desktop gives `/remote?account=N` in `teamsrelay-desktop`; a `DESKTOP_URL` elsewhere gives its own address in a new tab.

## Revision: a pull-down tab, the address follows (2026-09-29, evening)

Asked by the owner after the first release: no bar across the page, a small tab at the top as in the connection bar of Remote Desktop. The desktop takes the whole page; a tab with an arrow sits at the top centre, over the title bar of the window in front. A click on the arrow pulls the accounts down, the arrow under them pointing up; a click on it again, anywhere else on the page, on the desktop (the page loses the focus to the frame) or Escape puts them away. A pick closes the tab and gives the keyboard back to the desktop; a failure keeps the tab down with the reason. The address follows the account in front (`history.replaceState`, no reload), so a reload opens that account again; an account asked for that is not on the desktop is replaced in the address by the one opened. Tests (`test/desktop-switcher.test.ts`): only the arrow at the start, down and up at the arrow, up at a click on the desktop and at Escape, the pick with the address and a reload, the failure keeping the tab down, the address of the account opened instead.
