# Push delivery: urgency, TTL, retries, one notification per chat

Date: 2026-09-26. Status: accepted. Supersedes the push TTL of [2026-09-26-agent-typescript.md](2026-09-26-agent-typescript.md).

## Context

- Every push went out with the web-push default urgency `normal` and a TTL of one hour, with one try per device, and the service worker gave each push a notification of its own.
- RFC 8030 section 5.3: a device on low battery can ask its push service for `high` only, and `normal` then waits.
- A push the push service refused for now (429, 5xx) or did not answer was logged and lost.
- A phone off for more than an hour lost the pushes of that time. A TTL of 24 hours had been set aside because a phone back after a night showed every push of the night as a separate notification.
- The Python agent passed no `ttl` to pywebpush, whose default is 0: a phone asleep or offline at that moment lost the push. A server still on that release keeps doing so until it is updated.

## Options

| Question | Choice | Not chosen |
|---|---|---|
| Urgency | `high` for messages, alerts and the Recheck answer; `normal` for the automatic check that passed | `normal` for everything, the web-push default |
| TTL | 24 hours | 1 hour (a phone off longer loses its messages); 4 weeks (messages days old) |
| Grouping | Service worker: one notification per account and chat with its last five lines, alerting again (`tag`, `renotify`); since 2026-09-30 the newest message only, an older one arriving late leaves it ([architecture](../architecture.md)) | Web Push `Topic` header per chat: FCM, the push service of Chrome, treats a topic as a collapse key, limits collapsible messages to a burst of 20 per app and device with a refill of one every 3 minutes, and keeps at most four collapse keys per device. A published measurement on Android saw pushes 150-172 s late with a topic and within 3.1 s without |
| Retries | 429, 5xx and no answer (network error, timeout) sent again after 5, 30 and 120 s, a 429 after its `Retry-After` (at most 15 minutes), on timers outside the agent round, and only while the device still belongs to the owner of the account | none; retries inside the round (a slow push service would stall the reading of Teams) |
| Delivery receipts | None | acknowledgement from the service worker: a new endpoint, and nothing yet to act on it |

## Decision

The choices of the table.

## Consequences

- A phone off overnight gets the pushes of the last 24 hours as one notification per chat.
- A device keeps the previous service worker, one notification per push, until the app is opened once.
- A push can arrive twice when the push service took it and its answer was lost: the service worker keeps the line once and does not alert again.
- Retries waiting when the agent stops are lost; the history keeps the message.
- `push` log lines carry `status`, `attempt` and `retry`.
