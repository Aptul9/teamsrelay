#!/bin/bash
# Prints the server .env on stdout from the environment of the deploy job (variables TR_<KEY>).
# Only non-empty values are written: every variable of docker-compose.yml has a default, so absent equals empty.
# Usage in the Action:  deploy/render-env.sh | ssh "$TARGET" 'umask 077; cat > .env.new && mv .env.new .env'
set -euo pipefail

KEYS=(
  DOMAIN APP_URL
  BETTER_AUTH_SECRET SESSION_SECRET
  ADMIN_EMAIL ADMIN_PASSWORD
  MCP_TOKEN SLOT_COUNT ACCOUNTS_PER_USER
  DESKTOP_USER DESKTOP_PASS DESKTOP_URL
  VAPID_SUBJECT TZ HTTPS_PORT HTTPS_BIND
  NTFY_ENABLED NTFY_URL NTFY_TOPIC
)

for key in "${KEYS[@]}"; do
  ref="TR_$key"
  value="${!ref:-}"
  [ -n "$value" ] || continue
  case "$value" in
    *$'\n'*|*$'\r'*) echo "$key: the value contains a line break" >&2; exit 1 ;;
  esac
  printf '%s=%s\n' "$key" "$value"
done
