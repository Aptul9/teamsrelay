FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries and esbuild its binary in an optional package: no install scripts,
# no compiler
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# web app (.next/standalone) and agent (dist/agent.cjs)
RUN npm run build
# What the agent loads at runtime besides its bundle. The standalone output traces only the web app, so these
# are copied explicitly: playwright-core whole (no dependencies), better-sqlite3 without its sources and with
# the binary of this architecture only (the image is built on the machine that runs it).
RUN mkdir -p /agent/node_modules/better-sqlite3/prebuilds \
 && cp -r node_modules/playwright-core /agent/node_modules/ \
 && cp -r node_modules/better-sqlite3/package.json node_modules/better-sqlite3/lib /agent/node_modules/better-sqlite3/ \
 && cp "node_modules/better-sqlite3/prebuilds/linux-$(node -p process.arch).node" /agent/node_modules/better-sqlite3/prebuilds/ \
 && cp dist/agent.cjs dist/agent.cjs.map /agent/

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8090 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /agent ./
# fails the build if the agent cannot load its packages or its page scripts in this image
RUN node agent.cjs --check
EXPOSE 8090
# web app; the agents of docker-compose.yml run: node --enable-source-maps agent.cjs
CMD ["node", "server.js"]
