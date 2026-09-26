# Dependency audit

Date: 2026-09-26. Versions read from Docker Hub, PyPI, npm and GitHub releases on that day.

| Component | Where | Before | Current release | Action |
|---|---|---|---|---|
| Docker socket proxy | `docker-compose.yml` | `tecnativa/docker-socket-proxy:v0.5.0` | v0.5.0 (2026-07-27) | Replaced by `wollomatic/socket-proxy:1.13.1`. The Tecnativa proxy is current but coarse: `ALLOW_START` and `ALLOW_STOP` cover every container on the host. The Wollomatic proxy takes a regex per method and path, so start and stop are limited to the TeamsRelay slot containers. |
| Chromium | `docker-compose.yml` | `lscr.io/linuxserver/chromium:latest` | `latest` rebuilt 2026-09-24 | Pinned by digest, bumped by Dependabot. With a floating tag the deploy never pulled a newer browser: the image stayed at whatever the first install downloaded. |
| Caddy | `docker-compose.yml` | `caddy:2` | 2.11.4 (2026-06-03) | `caddy:2.11.4-alpine`. Same pull problem as Chromium. |
| Python base image | `agent/Dockerfile` | `python:3.12-slim` | 3.14 | `python:3.14-slim`. Python 3.12 receives security fixes only. |
| Playwright | `agent/Dockerfile` | 1.55.0 (2025-08-28) | 1.63.0 (2026-09-15) | 1.63.0, pinned in `agent/requirements.txt`. |
| pywebpush | `agent/Dockerfile` | 2.5.0 | 2.5.0 | Kept, moved to `agent/requirements.txt`. |
| FastAPI, Uvicorn | `webapp/Dockerfile` | 0.141.1, 0.53.0 | 0.141.1, 0.54.0 | Removed with the Next.js web app. |
| Web app runtime | `webapp/Dockerfile` | Python 3.12 | Node 24 LTS | `node:24-slim`, Next.js 16.3, React 19.3. |
| actions/checkout | CI | v4 | v7.0.1 | v7 |
| actions/setup-python | CI | v5 | v7.0.0 | v7 |
| actions/setup-node | CI | v4 with Node 22 | v7.0.0 | v7 with Node 24 |
| VitePress, vitepress-plugin-mermaid, mermaid | root `package.json` | 1.6.4, 2.0.17, ^11.17.2 | 1.6.4 (2025-08), 2.0.17 (2024-09, peer mermaid 10 or 11), 12.0.0 | Removed. The site was built in CI and never published. The documentation is plain Markdown; GitHub renders its mermaid diagrams. |
| Dependency updates | repository | none | | `.github/dependabot.yml` for GitHub Actions, Compose, Dockerfiles, npm and pip. |

## Legacy code removed

- The migration from the single-account layout (`data/messages.db`, `config/`) to slot 1, in `deploy/remote-deploy.sh` and in the web app. Production ran it with the deploy of `7b26cb4` on 2026-09-24.
- `deploy/sslh.default.example` and the OpenVPN port-sharing section: host-specific, unrelated to TeamsRelay. `HTTPS_PORT` and `HTTPS_BIND` stay.
- The Power Automate appendices (mail forwarding, calendar copy): unrelated to TeamsRelay.
