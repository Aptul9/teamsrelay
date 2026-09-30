# Calling a person from the app

Date: 2026-09-30. Answered calls today: [2026-09-28-answer-calls.md](2026-09-28-answer-calls.md), sound in the app: [2026-09-29-call-audio-in-app.md](2026-09-29-call-audio-in-app.md).

**Goal:** a Teams audio call to the person of a 1:1 chat, placed from the app for an account of the browsers container, heard and ended in the app like an answered call.

## What exists

- The app answers, mutes and hangs up calls of an account of the browsers container; the call in progress is the Teams page recording from the microphone (`in_call` state), whatever started it, and its sound comes to the app over the websocket of the remote desktop.
- Teams marks each row of its chat list with the kind of chat in `aria-labelledby`: `one-on-one-chat-support-text`, `chat-group-support-text`, `chat-meeting-support-text` (captured list of slot 2, `app/test/agent/fixtures/chat-list.html`: 23, 7 and 22 rows). The header of a group chat holds its participant count (`chat-header-participant-count`).
- Teams web starts an audio call from the open chat with Alt+Shift+A (Microsoft support, *Keyboard shortcuts for Microsoft Teams*, web column). The same keys accept a video call while a call rings.

## Decision

2026-09-30, owner: 1:1 chats only; the app asks *Call X?* before calling. Group and meeting chats get no Call button, nor does the self chat, nor an account on another computer (its sound is on that computer).

## Flow

1. The agent keeps the kind of each chat of the list (`chats.kind`: `one`, `group`, `meeting`, `""` when Teams shows none). A chat out of the last read keeps the kind it had.
2. The conversation header of the app shows a Call button for a 1:1 chat of a running account of the browsers container while no call rings or runs on it. A tap asks *Call Anna Rossi?*; **Call** starts the sound of the call in the app from that tap (as Answer does) and sends `POST /api/call/start?a=N` with `{"name": <chat>}`.
3. The web app checks that the session user owns slot N (404), that the account runs and is not on another computer (409), that no call rings or runs on it (409), and that the chat is a 1:1 chat of its list (409). It queues the command `call` (arg1 the chat); a second tap while it waits gets the same command.
4. The loop of the agent runs `call`, since it opens a chat: it refuses a command older than 25 s (the app waits 45 s for the outcome, so a call never starts after the app gave up), a call ringing or in progress, a chat that is not 1:1 in the list, then opens the chat as `open` does, refuses a header with a participant count, and presses Alt+Shift+A inside the input lock only after reading that no call toast shows. It tells the call watch whom it calls (`outgoing`), and ends `done` once a Teams page records from the microphone, within 10 s; `failed` otherwise, with the reason in `cmd_result:<id>` (`CallResult`).
5. The call watch reads the microphone at every look while a call is being placed, and names the call in progress after the person called. The banner shows *Calling Anna Rossi* from the tap until the call shows in progress, then the banner of a call in progress: sound in the app, Mute, devices, Desktop, Hang up. The ringback comes through the sound of the call. The person declining, or not answering, ends the call in Teams: the page stops recording and the banner goes.
6. A failure shows why (*A call is on*, *Teams did not start the call*...) and stops the sound in the app.

## Not done

- Group, meeting and self chats; a person without a chat in the list; video.
- The outgoing call in the Calls tab.
- The screens of Teams during an outgoing call were never read: the agent counts the call placed once the page records, and logs the overlays it sees when it does not.

## Tests

- Page script on the captured list: kind of every row (1:1 rows with a presence badge, group rows named `, +N`), the synthetic list without the attribute gives `""`.
- Store, reader and schema: the column `kind`.
- `call` with a fake agent: every refusal presses nothing; the toast read right before the press; one press of Alt+Shift+A; done once recording; failed after the wait; `outgoing` set before the press and cleared on a failure.
- Call watch: the call placed is named after the person, the microphone read at every look while placing, `outgoing` cleared when the call is over.
- Route: queued once, each refusal, nothing queued on a refusal.
- Chrome: the Call button only with a callable chat, *Call X?* then **Call** calls, **Cancel** does not; the banner *Calling X* until the call shows in progress, gone on a failure.
- Live, after the deploy: one call from an account of the owner to the owner's other account, answered there: `CMD call`, `call: calling`, in progress in the app, sound both ways, Hang up.
