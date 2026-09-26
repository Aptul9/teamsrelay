# Limitations

| Limitation | Detail |
|---|---|
| Presence | The status (Available, Busy...) cannot be set: in every test Teams left it on *Unknown*. It probably depends on tenant policies. |
| Expiring session | Conditional access invalidates the tokens and Teams stops syncing. TeamsRelay detects it (red status and a push); the sign-in is repeated in the remote desktop. |
| Chats only | 1:1 and group chats, up to 40 in the list, last 40 messages of the open chat. Team channels appear in the Activity feed but do not open. |
| Reading opens the chat | The agent reads the chat that is open in the remote Teams, so reading a chat from the app marks it as read in Teams. |
| Read by | Collected only for the open chat, on your last 5 messages. |
| Latency | New messages every 3-4 s, actions confirmed in 3-10 s, Activity feed every few minutes. |
| Language | Teams web must stay in English: some texts read by the agent (message status, feed titles, expired session) are English. |
| Teams interface | When Microsoft changes the [selectors](teams-selectors.md), the affected functions stop working until they are updated. |
| Same display name | Chats are identified by the name shown in the list. With two chats of identical name, only the first one in the list is reachable. |
| Bots without preview | New message detection relies on the preview: bots that show none can be missed. |
| Sending attachments | Not supported: text only. Receiving images and downloading files works. |
| iPhone | Push notifications reach only the app installed on the Home Screen. |
| Slots | Fixed by `docker-compose.yml` (4). More slots need more services and networks there. |
