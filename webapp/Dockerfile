FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries for linux x64 and arm64: no install scripts, no compiler
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8090 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 8090
CMD ["node", "server.js"]
