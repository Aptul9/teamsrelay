# Limitations

| Limitation | Detail |
|---|---|
| Presence | While TeamsRelay runs, Teams sees an active desktop: the page counts as visible and focused and the agent moves the mouse every minute, so the status stays *Available*. Busy, Do not disturb, meetings and calls set elsewhere still win. Teams mobile, set to notify only when you are not active on a desktop, may then stay silent: the push of TeamsRelay does not depend on it. |
| Visible page | A visible page marks as read what arrives in the open chat. The agent keeps a chat open only while the app shows it (`viewing`), otherwise Teams stays on the self chat. Without a self chat in the list, the last chat opened stays open. |
| Expiring session | Conditional access invalidates the tokens and Teams stops syncing. TeamsRelay detects it (red status and a push); the sign-in is repeated in the remote desktop. |
| Chats only | 1:1 and group chats, up to 40 in the list, last 40 messages of the open chat. Team channels appear in the Activity feed but do not open. |
| Reading opens the chat | The agent reads the chat that is open in the remote Teams, so reading a chat from the app marks it as read in Teams. |
| Read by | Collected only for the open chat, on your last 5 messages. |
| Latency | New messages every 3-4 s, actions confirmed in 3-10 s, Activity feed every few minutes. |
| Language | Teams web must stay in English: some texts read by the agent (message status, feed titles, expired session) are English. |
| Teams interface | When Microsoft changes the [selectors](teams-selectors.md), the affected functions stop working until they are updated. |
| Same display name | Chats are identified by the name shown in the list. With two chats of identical name, only the first one in the list is reachable. |
| Group chats named "Name, +2" | Teams lists an unnamed group chat as its first members plus a count, and titles it with the full names once open: the agent does not recognize the title and the chat does not open from the app. |
| Offline phones | The push service keeps a notification for one hour; a device offline longer misses it (the chat list still shows the message). |
| Bots without preview | New message detection relies on the preview: bots that show none can be missed. |
| Files | The app sends images only: one PNG, JPEG, GIF or WebP of up to 10 MB per message, pasted, dropped or attached, with the text as caption; not in a reply or an edit. Any other file (Excel, PDF...) is refused with a message. Attachments received show with their name; the download works only for SharePoint files the browser session reaches: behind Defender for Cloud Apps the link answers with a web page and the app says to open the file in Teams. Sending and saving other files is a manual step in Teams. |
| Tagging people | `@` in the app tags the people Teams lists for that chat (in a group chat its members, you excluded; in the self chat nobody), in a new message only: not in a reply, an edit or the caption of an image. The list of members is read from Teams on the first `@` of a chat and again after an hour. |
| iPhone | Push notifications reach only the app installed on the Home Screen. |
| One owner | Every Teams account of a server belongs to one person: all of them show their browser window on the one remote desktop. `SLOT_COUNT` caps their number (default 4). |
| One container | The browsers of every account run in one container: a new browsers image (Chromium update, agent release) restarts every account. |
