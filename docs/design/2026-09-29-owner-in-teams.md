# The agent leaves Teams to the owner

Date: 2026-09-29.

**Goal:** while the owner works in Teams in the remote desktop (or in the window of the local relay), the agent moves Teams nowhere on its own: no chat switches, no Activity reads, no mouse or Shift of the presence keeper. It goes back to them a few minutes after the owner stops.

## Decisions

- The owner's use is read on the page itself: a click, a key or a wheel turn the agent did not send. The agent sends its own input through CDP, which the page also sees as trusted input: every job and command that sends input runs inside a span of the agent (`asAgent`, `withInput`), and input inside a span, or up to 1 s after it, is the agent's.
- Mouse moves do not count: Chrome sends trusted mouse moves of its own when the page moves under a still pointer.
- Opening the remote desktop of an account from the app (`/api/desktop/N`) counts as use of that account from that moment, before any click: the owner opened it to look.
- Paused for 3 minutes after the last such input or opening. Teams sets Away after about 5 minutes without input: the presence keeper runs again at most 60 s after the pause, and the owner's own input keeps Available meanwhile.
- Paused: presence keeper, parking, back to the chats, full sweep of the chat list, Activity read, Read by prefetch. Not paused: commands of the app (the owner asks for them), reads of the chat list, the open chat and the health, the call watch, the automatic check.
- One desktop for every account, one window in front: input reaches the page of that window only, so each account pauses on its own. The call sound in the app opens the websocket of the desktop without any input: it pauses nothing.
- Rejected: the page loads `/api/authcheck` sees (one desktop for every account, the call sound's websocket among them, nothing once the websocket is open); counting the Selkies viewers from the container (the call sound counts too, the window in front needs the compositor).

## Contract

- Slot db `state` key `desktop`: `{ts}`, Unix seconds, written by the web app when the owner opens the desktop of the account (`GET /api/desktop/N`).
- `AgentHealth.desktop`: `"in-use"` while paused, absent otherwise. The status panel shows *In use by you: Left as it is*.

## Agent

- Page scripts `watchInput` and `drainInput` (`app/src/agent/teams/scripts/page-state.ts`): capture listeners on `pointerdown`, `keydown`, `wheel`, trusted events only, times (ms) kept in the page, the last 50, handed out once. Installed like `makeVisible`: init script and every round.
- `app/src/agent/teams/input.ts`: `asAgent(page, fn)` records the span of `fn` (kept 2 minutes); `withInput` runs its sequences inside one; `byAgent(page, t)`.
- The `page` job drains the page every round and keeps the last input not `byAgent` (`a.ownerAt`); `ownerUses(a)` is true while it, or the `desktop` row, is less than 3 minutes old (`app/src/agent/logic/owner.ts`). One log line when a pause starts, one when it ends.
- `free()` of the loop, the presence keeper and `awayFromChats` check `ownerUses`. Commands, parking, the Activity read and the Read by prefetch run inside `asAgent`.

## Tests

- Page scripts in Chrome: trusted click, key and wheel recorded; `el.click()`, synthetic events and mouse moves not.
- `asAgent`/`byAgent`: inside, after, the tail, a span still running, a span that failed, `withInput`.
- Loop: input of the owner pauses the six jobs for 3 min and not the others; the `desktop` row pauses at once; input sent inside commands, parking, the feed read and Read by is the agent's; the health row says `in-use`.
- The local relay in one process against its fake Teams page (`test/local/relay.test.ts`): after its sends, reads and presence keeper the health is not in use; a click from outside the agent makes it so.
- Route: `/api/desktop/N` writes `desktop` for the owner's account, nothing for another user.

## Docs

`limitations.md` (*Presence*), `architecture.md` (the loop table, *The owner in Teams*), `operations.md` (log lines).
