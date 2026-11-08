# MCP-only accounts

## Goal

Some Teams accounts are already used in the official Teams app. TeamsRelay duplicates their notifications and calls. An MCP-only account stays signed in and synced for AI clients (`/mcp`, and the unified communication MCP that forwards it as `teams_*`) without pushing anything about its messages or calls to the owner, and without appearing in the chat UI.

## Decisions (owner, 2026-11-08)

| Topic | Decision |
|---|---|
| Push notifications | Off for messages, mentions, calls and missed calls |
| Sign-in alerts | Kept: signed out, signed in again, browser down or back, recheck result |
| Calls | Off: no ringing, no answering, no native calls worker |
| Presence keep-alive | On, as on every account today |
| Read marking | Unchanged: `refresh_chat` and `open` mark the chat read in Teams |
| MCP scope | Read and write, every existing tool |
| Browser | Light after the first sign-in |
| Chat UI | Hidden from the account switcher, the default account choice and the badges |
| How | Chosen when adding, and switchable in Settings at any time |
| Approach | One `mcp_only` flag, not separate toggles and not a reader outside TeamsRelay |

## Data and lifecycle

- New column `teams_accounts.mcp_only INTEGER DEFAULT 0`, added by migration in `src/lib/appdb.ts` like `calls`, and in the `Slot` type and `SLOT_COLUMNS`.
- The flag does not overwrite `light` or `calls`. While it is on, the account runs light and its calls are off. Switched off, the account returns to its own `light` and `calls` values.
- `POST /api/accounts` accepts `mcpOnly`. The first sign-in uses the browser and the remote desktop, as for every account. Once the sign-in is captured, the account moves to light.
- `PATCH /api/accounts/[slot]` accepts `mcpOnly`. On: same path as `setLightMode` (`src/lib/slots.ts`): an always-on account keeps its browser until the sign-in capture, a stopped account starts light. Off: the slot follows its own settings again.
- `keepSlotsUp` runs the light agent when `light || mcp_only`.
- Relay accounts (on another computer) cannot be MCP-only: 409, as for light mode.
- MCP-only accounts count toward `ACCOUNTS_PER_USER` like any other.

## Runtime

- `AppStore` reads `mcp_only` with a short cache, like `callsOn()`.
- `Notifier.message()`, `call()` and `missedCall()` return without sending, without ntfy and without a history row when the account is MCP-only.
- Missed calls from the Activity feed are pushed today through `alert()` (`src/agent/jobs/missed-calls.ts`). They move to a path the flag silences; `alert()` stays for account health only.
- Kept: `alert()` for "Teams signed out" and "Teams back" (`src/agent/light/loop.ts`, `src/agent/jobs/health.ts`), "Relay browser down" and "back", the recheck result.
- Messages are saved to `messages.db` before the notify step (`src/agent/light/loop.ts`, `notifyNew`), so the MCP keeps reading them.
- `callsOn()` returns false: the light agent starts no native calls worker. `CallWatch` does not start during the browser runs of a sign-in (`src/agent/loop.ts`). The web app leaves the account out of ringing (`src/lib/calls.ts`) and out of the calls of the events stream.
- Presence keep-alive and read marking are unchanged.

## App

- The account summary (`src/lib/accounts.ts`) carries `mcpOnly`.
- The chat UI leaves MCP-only accounts out of the account switcher (`src/components/AccountMenu.tsx`), the account chosen on load (`src/components/App.tsx`, `applyAccounts`) and the unread and missed badges.
- Settings lists them with an "MCP only" label, the switch, and the remote-desktop link for sign-in. The desktop switcher keeps them: sign-in and re-sign-in go through it.
- Add account offers "For the MCP only".

## MCP

- `list_accounts` reports `mcp_only` for each account. Every other tool is unchanged.
- Light limits apply: SharePoint and OneDrive files cannot be downloaded without a browser. A chat with no saved messages needs `refresh_chat` before `read_chat` returns them, which marks it read.

## Error handling

- Switching a relay account: 409, nothing changed.
- Switching while a sign-in run is in progress: the flag is saved; the run finishes and the account continues light.
- Signed-out MCP-only account: the sign-in alert is pushed; MCP write tools answer as for any account whose Teams is not ok (`canAct`).

## Testing

Vitest, next to `test/light-mode.test.ts`:

- migration adds the column with default 0 on an existing `app.db`;
- `keepSlotsUp` runs light for `mcp_only` and returns to the browser when switched off on a non-light account;
- `POST` and `PATCH` routes, 409 for relay accounts;
- `Notifier`: no delivery for `message`, `call`, `missedCall` and feed missed calls of an MCP-only account; sign-in alerts delivered;
- `callsOn()` false and the slot absent from ringing;
- account summary flag, switcher and badge filtering, `list_accounts` flag.

## Out of scope

- Separate per-account toggles for notifications, calls or visibility.
- Changing presence or read marking.
- Prefetching messages of light accounts.
- Any change to the unified communication MCP beyond forwarding the new `list_accounts` field.
