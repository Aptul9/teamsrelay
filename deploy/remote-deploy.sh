#!/bin/bash
# TeamsRelay deploy on the server, run by the GitHub Action over SSH.
#   remote-deploy.sh backup        saves the current code (for the rollback)
#   remote-deploy.sh up <sha>      rebuilds and restarts; if the web app does not answer, goes back to the saved code
# The code arrives through rsync from the Action; .env, config/, data/ and vapid/ stay on the server untouched.
set -euo pipefail
TR_DIR="${TR_DIR:-/opt/teamsrelay}"
BACKUP=/var/tmp/teamsrelay-prev.tgz
cd "$TR_DIR"
# the account slots (chromium-N, agent-N) are in the "accounts" profile: always include them here
export COMPOSE_PROFILES=accounts

code_files() {
  # everything but the runtime data
  find . -mindepth 1 -maxdepth 1 ! -name .env ! -name config ! -name data ! -name vapid ! -name .caddyfile-sum -printf '%P\n'
}

preflight() {
  # the web app refuses to start without a session key; better to stop here than after the build
  if ! grep -Eq '^(BETTER_AUTH_SECRET|SESSION_SECRET)=.{32,}' .env; then
    echo ".env: BETTER_AUTH_SECRET missing or shorter than 32 characters (openssl rand -hex 32)" >&2
    exit 1
  fi
}

healthy() {
  # the web app answers inside its container, then no agent may be in a restart loop
  for _ in $(seq 1 30); do
    if docker compose exec -T webapp node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1; then
      # the web app starts the slots of the accounts a few seconds after its start
      sleep 25
      bad="$(docker ps --filter name=teams-agent- --filter status=restarting --format '{{.Names}}')"
      [ -z "$bad" ] && return 0
      echo "agent in a restart loop: $bad" >&2; return 1
    fi
    sleep 4
  done
  return 1
}

start() {
  docker compose build
  # Every slot exists, stopped: the web app starts those of the accounts (through dockerproxy it can only
  # start and stop existing containers). A container whose configuration changed is recreated stopped
  # and the web app starts it again.
  docker compose create
  docker compose up -d --remove-orphans webapp dockerproxy caddy
  # Caddy has no image to rebuild and reads the mounted Caddyfile: rsync replaces it with a new file and
  # the container would keep seeing the old one. If it changed, restart (certificates stay in the volume).
  caddy_sum="$(sha256sum caddy/Caddyfile | cut -d' ' -f1)"
  if [ "$caddy_sum" != "$(cat .caddyfile-sum 2>/dev/null)" ]; then
    docker compose restart caddy && echo "$caddy_sum" > .caddyfile-sum
  fi
}

case "${1:-}" in
  backup)
    code_files | tar -czf "$BACKUP" -T - 2>/dev/null || true
    echo "backup: $BACKUP"
    ;;
  up)
    sha="${2:-unknown}"
    [ -f .env ] || { echo ".env missing in $TR_DIR: the first setup is manual (see docs/setup.md)" >&2; exit 1; }
    preflight
    echo "deploy $sha"
    start
    if healthy; then
      echo "$sha" > .deployed-sha
      docker image prune -f >/dev/null
      docker ps --filter name=teams- --format '{{.Names}}: {{.Status}}'
      echo "ok: $sha running"
      exit 0
    fi
    echo "the web app does not answer after the deploy of $sha: rollback" >&2
    docker compose logs --tail 40 webapp >&2 || true
    if [ -f "$BACKUP" ]; then
      code_files | xargs -r rm -rf
      tar -xzf "$BACKUP"
      rm -f .caddyfile-sum
      start
      healthy && echo "rollback done: $(cat .deployed-sha 2>/dev/null || echo previous version)" >&2
    fi
    exit 1
    ;;
  *)
    echo "usage: $0 backup | up <sha>" >&2; exit 2
    ;;
esac
