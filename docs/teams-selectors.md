# Teams selectors

Everything the agent knows about Teams web is in `app/src/agent/teams/selectors.ts`: hosts, selectors and the English texts read on the page. The agent of a slot and the local relay use the same file. When Microsoft changes the interface, the change goes there. The page scripts (`app/src/agent/teams/scripts/`) receive those values as argument and run inside the Teams page; they import nothing at runtime, which a lint rule enforces. Checked on Teams web in English (`teams.cloud.microsoft`) in September 2026.

Tests: `app/test/agent/page-*.test.ts` run every page script in Chrome, on hand-written pages and on fixtures captured from live Teams (`app/test/agent/fixtures/`, structure only, names and texts invented). After an interface change, capture the part again with `app/scripts/capture-fixture.ts` (the header of the script has the commands) and run `npm test` from `app/`.

## Page and chat list

| Element | Selector |
|---|---|
| Teams tab | URL on `teams.cloud.microsoft` (or the older `teams.microsoft.com`), also behind the Defender for Cloud Apps proxy, which appends `.mcas.ms`, `.mcas-gov.us` or `.mcas-gov.ms` to the host |
| List sections | `[role="treeitem"][aria-level="1"]`: *Quick views*, *Favorites*, *Chats*; `aria-expanded` tells whether they are open |
| Chat | `[role="treeitem"][aria-level="2"]` under *Chats* or *Favorites* |
| Unread | `[data-tid="unread"]` in the row |
| Muted | row with `data-item-type="muted-chat"`, icon `[data-testid="muted-icon"]` |
| Picture | `img.fui-Avatar__image` |
| Presence of the person | `[data-tid="presence-badge"]` on the picture of a 1:1 row, `role="img"`, `aria-label` *Available*, *Busy*, *Do not disturb*, *Away*, *Offline*, *Out of office*... (none on a group chat); live 2026-09-29: 10 of 23 rows on MSC, 11 of 27 on Npo |
| Kind of chat | among the ids the row's `aria-labelledby` names: `one-on-one-chat-support-text` (1:1, the self chat included), `chat-group-support-text`, `chat-meeting-support-text`; captured list of slot 2: 23, 7 and 22 rows. Only a 1:1 chat can be called from the app |
| Open chat | `[data-tid="chat-title"]`, first line; a group chat without a name shows its first person, then `+N` on the next line, read as `Anna Rossi, +2` like the list |
| Activity / Chat view | side bar buttons whose `aria-label` starts with `Activity` / `Chat`; the tooltip of the app launcher (`[data-tid="waffle-open-button"]`) can cover Activity and stays open while the mouse is on it; right after a start the side bar shows a few seconds after the chat list, then a `[role="progressbar"]` covers both buttons a few seconds more |
| Your status | `aria-label` of `[data-tid="me-control-avatar-presence"]` in the header: `available`, `away`, `busy`... |

## Messages

| Element | Selector |
|---|---|
| Container | `[data-tid="chat-pane-item"]`, one message per container |
| Message | `[data-tid="chat-pane-message"]` with `data-mid`; yours are inside `.fui-ChatMyMessage` |
| Body | `#content-<mid>` or `[data-tid="messageBodyContent"]` |
| Author and picture | `[data-tid="message-author-name"]`, `[data-tid="message-avatar"]` in the container, only on the first of a series |
| Mention | `[itemtype*="Mention"]` inside `[data-mention-type]`; `aria-label="Mentioned you"` when it is you |
| Emoji | `img` with an Emoji `itemtype` or inside `[data-tid="emoticon-renderer"]`, the emoji is in `alt` |
| Images | `itemtype` AMSImage, `data-tid="lazy-image-*"`; until Teams has loaded one it draws a 1x1 GIF and the address is in `data-orig-src` |
| Attachments | `[data-tid="file-attachment-grid"]`, name and URL in `aria-label` |
| Quote | `[data-tid="quoted-reply-card"]`, `[data-tid="quoted-reply-preview-content"]` |
| Reactions | `[data-tid="diverse-reaction-pill-button"]`, `aria-pressed="true"` when it is yours |
| Status | `[class*="fui-ChatMyMessage__statusIcon"]`, drawn under the last message of yours only: `aria-label` `Sending...` while Teams sends it, then `Sent`, `Seen`, `Seen by everyone`; a label with *fail* is a message Teams could not send. A new message counts as sent once its icon says so, not before |
| Edited | span with the text `Edited` in the message header |
| Deleted | `[data-tid="message-tombstone"]`, `[data-tid="message-undo-delete-btn"]` |

## Actions

| Action | Selector |
|---|---|
| Action bar | `[data-tid="message-actions-container"]`, in a portal |
| Quick reactions | `message-actions-like`, `-heart`, `-laugh`, `-surprised` |
| Other reactions | `expanded-reactions-picker-entry`, then `emoticon-button-cry`, `emoticon-button-angry` |
| Edit | `message-actions-edit`; confirm `newMessageCommands-send`; cancel `newMessageCommands-discard-draft` and `messagedraft-discard-confirm` |
| Menu | `message-actions-more`, entries `[role="menuitem"]` |
| Reply | `message-actions-quoted-reply`; quote in the box with `close-quoted-reply` |
| Delete | `message-actions-delete` in the menu |
| Read by | `message-actions-read-receipt` in the menu, names in the submenu |
| Editor and send | `[data-tid="ckeditor"]`; send `sendMessageCommands-send` or `newMessageCommands-send` depending on the layout |
| People to tag | `@` typed in the compose box opens `[data-tid="AutocompletePopup-Mentions"]`; a person is `li[role="option"][itemtype="person"]` with `data-tid="autocomplete-picker-item-<name>"` (the chat members but you; in the self chat only a *share a contact* entry). Picked, it becomes `[itemtype*="Mention"]` in the box, one `<mention>` per word of the name |
| Members of a group chat | `[data-tid="chat-header-participant-count"]` (*Add people and agents, N participants*) opens a dialog with the names in `[id^="chat-roster-item-name-"]`; the same dialog has `chat-header-remove-user-button`, `chat-add-members`, `leave-chat-btn` |
| Image in the compose box | a `paste` event with the image file in `clipboardData`; the box then holds `<inlineimage>` and `img[data-tid="image-with-loader"]`; your new message shows `Sending...` until Teams has it |

## Activity

| Element | Selector |
|---|---|
| Entry | `[data-tid="activity-feed-list-item"]`, id in `aria-labelledby` |
| Title | `[data-tid="activity-feed-item-title"]` |
| Lines | preview, time, place; the time is recognized by its format |

## Incoming call

Seen on 2026-09-27 on slot 2 (behind Defender for Cloud Apps) with 1:1 audio calls from a person of another organization; a video call and a group call were not seen. The fixture `call-toast.html` was rebuilt from those probes (attributes, texts and nesting as seen, name invented), not captured with the script. The only click on the toast is *Accept with audio*, when the owner answers from the app (`SEL.callAccept`): a real click, CDP mouse events at a point of the button nothing covers, sent at once. Teams animates the toast while it rings, and a click that waited for the button to hold still (Playwright's) waited 3 s on prod and landed after its own timeout (2026-09-29). Where no part of Accept can be clicked, or its toast stays 1.5 s after the click, the Accept shortcut of Teams web follows, Alt+Shift+S; the answer counts once the toast is gone or a page records.

| Element | Selector |
|---|---|
| Toast | `[data-testid="calling-notification"]`, inside `[data-testid="notification-wrapper"]` (`role="group"`, title `role="alert"` *Microsoft Teams*) in `[data-tid="app-layout-area--in-app-notifications"]`, bottom right. It shows while the call rings and goes away when it stops: missed, cancelled, taken by voicemail or answered elsewhere look the same |
| Caller | `[id^="cn-calling-main-content-"]`: *Anna Rossi is calling you*, badge, name and words in separate elements; a person of another organization has the badge *External* (`aria-label="External unfamiliar"`) before the name |
| Buttons | `[data-testid="calling-actions"]`: `aria-label` *Accept with audio*, *Decline call*; in the header *More options* and `[data-testid="dismiss-toast-button"]` *Dismiss notification* |
| Sound | Teams plays its ringtone (the content of `Teams_Call_Ringing.mp3`, 7.6 s) while the toast shows, then `Teams_Call_Ended.mp3`; with the page visible there is no browser notification |
| Afterwards | the Activity feed lists *Missed call from Anna Rossi* for a missed call, nothing for one taken by voicemail |
| Call in progress | the page records from the microphone. An init script of every page and frame wraps `navigator.mediaDevices.getUserMedia` and keeps the audio tracks it returns (`__teamsMicTracks`); a track `live` is a call in progress. A call in progress whose microphone button reads muted stays in progress without a live track, in case Teams lets the microphone go while muted; no call starts from the button alone |
| Microphone of the call | `#microphone-button` (`aria-keyshortcuts="Ctrl+Shift+M"`) in the toolbar `#horizontalEnd` (`data-tid="ubar-horizontal-end"`, *Calling controls*), full screen and in the floating call monitor (`data-tid="floating-call-monitor"`) alike. Its state shows twice: live `data-state="mic-volume-renderer"`, `data-track-action-scenario="callMuteAudio"`, *Mute mic*; muted `data-state="mic-off"`, `"callUnmuteAudio"`, *Unmute mic* (1:1 call on slot 2, 2026-09-29, muted and unmuted several times in both views). `data-state="mic"` is live in other builds (extension *teams-caffeine*, github.com/g-guerzoni/teams-caffeine). One mark known is enough; two that disagree, none known, no button with a size, or two buttons on screen that disagree (any frame of any Teams page) read as unknown, and nothing is pressed then. Teams can leave a hidden one in the page after the call. The microphone track stays live while muted |
| Mute | the shortcut of Teams web for mute, Ctrl+Shift+M (same table as Hang up), a toggle: pressed only when the microphone button reads the other state than the one asked, on the page that shows it; where the state has not changed 1.5 s later and still reads, one real click on the button (CDP mouse events at a point nothing covers, as Accept). Done once the button reads as asked, within 5 s. On slot 2 (2026-09-29, 1:1 call) the shortcut sent as Playwright sends it and the click both muted and unmuted within 250 ms, and the caller saw the mute mark |
| Hang up | the shortcut of Teams web for ending a call, Ctrl+Shift+H (Microsoft support, *Keyboard shortcuts for Microsoft Teams*, web column; there accept audio call is Alt+Shift+S, decline Ctrl+Shift+D, mute Ctrl+Shift+M), sent to the page that records, or to the page of the microphone button for a call muted without a live track |
| Place a call | the shortcut of Teams web for starting an audio call from the open chat, Alt+Shift+A (same table; there Alt+Shift+A also accepts a ringing call as a video call, so it is pressed only after reading, inside the input lock, that no toast shows). A group chat is told by its header, `[data-tid="chat-header-participant-count"]` on screen; the agent presses nothing there. The screens of an outgoing call were never read: the call counts as placed once a page records |
| Call window | a 1:1 call answered on slot 2 (2026-09-29) showed in the main window, the calling screen in place of the app: nothing depends on it. The sound goes through the one sound server of the desktop whatever the window, the call in progress is read from every Teams page of the browser, and the hang-up goes to the page that records |
| After the call | the main area can stay on a post-meeting page, `[data-tid="calling-screen-background"]` with a Teams Labs offer (`post-meeting-teams-labs-feature-dismiss` *Not now*, `post-meeting-teams-labs-feature-opt-in` *Try it*): the side bar shows, the chat list does not. The Chat button of the side bar brings the list back at once (the agent clicks it 3 s after the call, reloads Teams after 3 tries); *Try it* is never clicked |

## Expired session

Texts `REDUCED_CAPABILITIES`, *Chats are temporarily unavailable*, *Sync engine is running in Reduced*, *We need you to sign in again*.

The one press of Sign in after a sign-out ([design](design/2026-09-29-sign-in-once.md)) reads the screens below by their texts only, and presses when exactly one matches. None of them was ever read on an account: they come from public reports, the fixtures `sign-in-teams.html` and `sign-in-microsoft.html` are rebuilt by hand, and the agent logs the buttons of each page once per sign-out (`SESSION: sign-in page buttons`), so the next real sign-out confirms or corrects them.

| Item | Read as |
|---|---|
| Teams banner | *We need you to sign in again. This could be a request from your IT department or Teams, or the result of a password update.*, a **Sign in** button (whole text, `TEXTS.signInButton`) and *Learn more about sign-in requests* (PWAsForFirefox issue 704). Its button opens the Microsoft identity platform with `window.open` (teams-for-linux issue 2621): a popup, which the browser opens for a trusted click only |
| Microsoft sign-in page | host `login.microsoftonline.com`, `login.live.com` or `login.microsoft.com`, in that popup or in the Teams tab itself. Any field to type in (`SEL.fields`: password, code, email; not checkboxes or buttons) means nothing is pressed |
| Account picker | *Pick an account*: one tile per account, `[role="button"]` with the name and the email, `data-test-id` the email, a menu of sign-out options inside it, and *Use another account*. The tile pressed is the one whose `data-test-id` is this account's email (`me` row) or whose text holds it as a whole word, never a longer email that contains it; a point of the tile itself, not of the menu inside it |
| Sign in, Continue | the one button, link or submit of a page that asks for nothing whose whole text is *Sign in* or *Continue* (`TEXTS.microsoftButton`). *Stay signed in?* (Yes, No) is not pressed |
