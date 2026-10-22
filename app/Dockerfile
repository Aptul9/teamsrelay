FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries and esbuild its binary in an optional package: no install scripts,
# no compiler
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# web app (.next/standalone), agent (dist/agent.cjs), supervisor (dist/supervisor.cjs) and the socket of the sound of the
# calls of accounts on another computer (dist/call-audio.cjs), loaded before the server of the web app; the local relay
# and the fleet bundles are no image's
RUN npx next build && node scripts/bundles.mjs agent supervisor hub
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
FROM lscr.io/linuxserver/chromium:latest@sha256:2d32e1b2b28aa92973aa0f58c433c0b045db6e1224d7001eeaa9cde1a474ce13 AS browsers
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
COPY --from=build /app/dist/call-audio.cjs ./
EXPOSE 8090
CMD ["node", "--require", "./call-audio.cjs", "server.js"]
