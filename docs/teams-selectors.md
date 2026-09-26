# Teams selectors

Everything the agent knows about Teams web is in `app/src/agent/teams/selectors.ts`: hosts, selectors and the English texts read on the page. When Microsoft changes the interface, the change goes there. The page scripts (`app/src/agent/teams/scripts/`) receive those values as argument and run inside the Teams page; they import nothing at runtime, which a lint rule enforces. Checked on Teams web in English (`teams.cloud.microsoft`) in September 2026.

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
| Open chat | `[data-tid="chat-title"]` |
| Activity / Chat view | side bar buttons whose `aria-label` starts with `Activity` / `Chat` |
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
| Status | `[class*="fui-ChatMyMessage__statusIcon"]`, `aria-label` `Sent`, `Seen`, `Seen by everyone` |
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

## Activity

| Element | Selector |
|---|---|
| Entry | `[data-tid="activity-feed-list-item"]`, id in `aria-labelledby` |
| Title | `[data-tid="activity-feed-item-title"]` |
| Lines | preview, time, place; the time is recognized by its format |

## Expired session

Texts `REDUCED_CAPABILITIES`, *Chats are temporarily unavailable*, *Sync engine is running in Reduced*, *We need you to sign in again*.
