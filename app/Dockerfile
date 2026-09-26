FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries and esbuild its binary in an optional package: no install scripts,
# no compiler
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# web app (.next/standalone), agent (dist/agent.cjs) and supervisor (dist/supervisor.cjs)
RUN npm run build
# What the agent loads at runtime besides its bundle. The standalone output traces only the web app, so these
# are copied explicitly: playwright-core whole (no dependencies), better-sqlite3 without its sources and with
# the binary of this architecture only (the image is built on the machine that runs it).
RUN mkdir -p /agent/node_modules/better-sqlite3/prebuilds \
 && cp -r node_modules/playwright-core /agent/node_modules/ \
 && cp -r node_modules/better-sqlite3/package.json node_modules/better-sqlite3/lib /agent/node_modules/better-sqlite3/ \
 && cp "node_modules/better-sqlite3/prebuilds/linux-$(node -p process.arch).node" /agent/node_modules/better-sqlite3/prebuilds/ \
 && cp dist/agent.cjs dist/agent.cjs.map dist/supervisor.cjs /agent/

# Every Teams account: Chromium and the remote desktop of linuxserver, the agents, and the supervisor that runs
# them (s6 service svc-teamsrelay). The desktop no longer opens a browser by itself.
FROM lscr.io/linuxserver/chromium:latest@sha256:cf6200ccdcb224feaf5d3bde4ce45b3783c926a7496c98059cae1e0db78e5b2f AS browsers
# wlrctl brings the window of an account to the front. abc, the user of the browsers, loses its passwordless
# sudo: a browser taken over by a web page must not reach root and, with it, data/ and vapid/.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wlrctl \
 && rm -rf /var/lib/apt/lists/* \
 && gpasswd -d abc sudo
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /agent /app
COPY docker/browsers/ /
# fails the build if the agent cannot load its packages or its page scripts in this image
RUN chmod +x /etc/s6-overlay/s6-rc.d/svc-teamsrelay/run \
 && node /app/agent.cjs --check \
 && node /app/supervisor.cjs --check

# Web app: PWA, API, users and sessions
FROM node:26-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8090 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 8090
CMD ["node", "server.js"]
