# Multi-user self-hosted, web app on Next.js

Date: 2026-09-26. Status: accepted; the agent part is superseded by [2026-09-26-agent-typescript.md](2026-09-26-agent-typescript.md).

## Context

TeamsRelay served one owner: one credential pair, up to four Teams accounts, one shared list of push devices. Several people need to use the same server, each with their own login, Teams accounts and devices, and without access to each other's data. The web app (FastAPI plus one HTML file) has to be rewritten for this anyway, since every endpoint needs an ownership check.

## Options

| Tenancy | Consequence |
|---|---|
| Multi-user, self-hosted | Known people on one server. User model, ownership checks, push per user, network isolation per slot, fixed pool of slots. |
| SaaS | Public sign-up, dynamic browser provisioning, billing, custody of customers' Microsoft sessions. Needs a legal and security assessment. |
| Single owner | No change to the model. |

| Stack | Consequence |
|---|---|
| Next.js web app now, agent later | Web app rewritten in TypeScript on the same SQLite contract. The Python agents keep running with small changes. |
| Full TypeScript rewrite | One language sooner. The agent rewrite adds regression risk against live Teams at the same time. |
| Stay on Python | Multi-user built in FastAPI. The UI can still move to a React SPA. |

## Decision

Multi-user, self-hosted. Next.js for the web app now; the agent stays Python and is ported in a later phase.

## Consequences

- Users are created by an administrator; there is no public sign-up. The first administrator comes from `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
- Authentication uses better-auth: email and password, sessions stored in the database, admin plugin. Sessions are per device and revocable.
- Each Teams account (slot) has one owner. Every per-account endpoint, `/media`, `/files` and the desktop route check ownership. Administrators manage users and can free a slot; they do not read other users' chats.
- Push subscriptions belong to a user. The agent of a slot pushes only to the devices of the slot owner.
- Each slot runs on its own Docker network, shared only with Caddy.
- The Docker socket proxy allows only start and stop of the TeamsRelay slot containers.
- The PWA receives updates over server-sent events instead of polling.
- The contract between web app and agent stays `data/N/messages.db`. The agent reads slot ownership and push subscriptions from `data/app.db`.
- Existing data migrates on first start: the slots of the legacy `accounts` table and the devices of the legacy `push_subs` table go to the first administrator. The legacy tables are left in place, so a rollback to the previous release still finds them.
