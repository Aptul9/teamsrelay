# Local relay for one Teams account

Date: 2026-09-26. Adds a second product to the repository; the server product ([2026-09-26-single-container.md](2026-09-26-single-container.md)) stays as it is. Design: [2026-09-26-local-relay.md](../design/2026-09-26-local-relay.md).

## Context

The server product runs every Teams account in a Chromium of the `browsers` container, shown through a Selkies remote desktop behind Caddy, and an agent attached over the DevTools port. For one personal account the containers, the remote desktop, the reverse proxy and the multi-user web app add weight and no value, and the sign-in through a streamed desktop is the fragile part. The tenant of that account allows no Entra application registration, so Microsoft Graph is out and Teams web in a browser stays the interface. The organization allows Teams in a browser (an app-versus-browser control, not device compliance).

## Options

| Option | Why not, or why |
|---|---|
| Graph or MSAL relay | No application registration possible in the tenant. |
| Token tools (TokenSmith, roadtx, TokenTactics) | API bearer tokens instead of a web session, first-party client impersonation; Conditional Access detects and blocks them. |
| Cookies or profile copied from an enrolled machine | The device PRT is TPM-bound, DPAPI and App-Bound Encryption block the copy, the session dies at the first Conditional Access refresh. |
| Remote browser streaming (the server product) | Works; pointless for one account. |
| `connectOverCDP` to the everyday Chrome or Edge | Chrome 136 and later ignore remote debugging on the default user data directory. |
| Local Node process, Playwright `launchPersistentContext` on a dedicated profile, headful, signed in once by the user | Chosen. |

## Decision

One Node process on an always-on machine with a desktop session: it launches Chrome or Edge on a profile of its own (never the everyday profile), headful, where the user signs in once (`npm run relay:login`, MFA included). The session stays in the profile as in a browser used every day. Notifications leave as Web Push (VAPID); the phone reaches the relay through one small bearer-token API and a text-only app. pm2 restarts the process, a push says when the session expires. No container, Selkies, Caddy or DevTools port.

The relay is a third entry point of the `app/` package (`app/src/local`, bundled to `dist/relay.cjs`), not a separate repository: selectors, page scripts, actions, jobs, logic, store, notifier, VAPID keys and command validation exist once and serve both products. What differs sits behind small interfaces of the shared agent: where the browser comes from, where the devices of the pushes come from, and the settings of the product.

## Consequences

- Improvements made for the relay apply to the server product as well: send confirmed on the page and refused on a non-empty compose box, commands that waited more than 2 minutes never run, the signed-out push waits a minute and a second push says when Teams is back, urgent pushes, commands left running by a stopped agent never run again.
- The contract of the slot databases grows only by additions: the column `commands.key`, the statuses `running` and `unconfirmed` (reported by the web app as `pending` and `failed`), the state keys `login_watch` and `browser_watch`, the optional health field `browser`. The API of the web app does not change.
- The phone must reach the API over HTTPS (a service worker needs a secure context): how is a network choice left to the owner (Tailscale Serve, or the LAN with a certificate of their own).
- A restart of the browser keeps the Microsoft session only when the tenant lets it persist ("Stay signed in"); otherwise every restart asks for a new sign-in in the relay window.
- The relay needs the desktop session of its user: a Windows service (session 0) would hide the window; a logon task starts pm2 instead.
