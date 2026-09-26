#!/bin/bash
# TeamsRelay deploy on the server, run by the GitHub Action over SSH.
#   remote-deploy.sh backup        saves the current code (for the rollback)
#   remote-deploy.sh up <sha>      rebuilds and restarts; if the web app does not answer, goes back to the saved code
# The code arrives through rsync from the Action; .env, config/, data/ and vapid/ stay on the server untouched.
set -euo pipefail
TR_DIR="${TR_DIR:-/opt/teamsrelay}"
BACKUP=/var/tmp/teamsrelay-prev.tgz
cd "$TR_DIR"
# Releases before the browsers container had one container per account in the "accounts" profile: with the
# profile active, a rollback to one of them creates those containers again. No service of this release uses it.
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
  # the web app answers inside its container, then every running agent works
  for _ in $(seq 1 30); do
    if docker compose exec -T webapp node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1; then
      # the web app starts the accounts a few seconds after its start
      sleep 25
      agents_ok
      return
    fi
    sleep 4
  done
  return 1
}

# "<account> <restarts>" for every running agent, from the supervisor of the browsers container
running_agents() {
  docker compose exec -T browsers sh -c 'node /app/supervisor.cjs status | node -e "let s=\"\";process.stdin.on(\"data\",(d)=>s+=d).on(\"end\",()=>{for(const a of JSON.parse(s))if(a.agent.running)console.log(a.account,a.agent.restarts)})"'
}

# An agent works when it keeps running and writes its health row (state 'health' of data/N/messages.db,
# rewritten every few seconds). One that stops at start (wrong environment, VAPID key not matching appkey.txt)
# restarts in a loop, which a single look at its state can miss: its restart count moves.
agents_ok() {
  local before now n stale
  # a rollback to a release without the browsers container: its agents are not checked here
  docker compose ps --services --status running | grep -qx browsers || { echo "no browsers container: agents not checked" >&2; return 0; }
  before="$(running_agents)" || { echo "the supervisor of the browsers container does not answer" >&2; return 1; }
  [ -n "$before" ] || return 0
  for _ in $(seq 1 18); do
    sleep 5
    now="$(running_agents)" || { echo "the supervisor of the browsers container does not answer" >&2; return 1; }
    if [ "$now" != "$before" ]; then
      echo "agent restarting: $(tr '\n' ' ' <<<"$now")" >&2
      return 1
    fi
    stale=""
    for n in $(cut -d' ' -f1 <<<"$before"); do
      docker compose exec -T webapp node -e "const D=require('better-sqlite3');const r=new D('/data/'+process.argv[1]+'/messages.db',{readonly:true,fileMustExist:true}).prepare(\"SELECT v FROM state WHERE k='health'\").get();process.exit(r&&Date.now()/1000-(JSON.parse(r.v).ts||0)<60?0:1)" "$n" >/dev/null 2>&1 || stale="$stale $n"
    done
    [ -z "$stale" ] && return 0
  done
  echo "agent without a recent health row:$stale" >&2
  return 1
}

start() {
  docker compose build
  docker compose create
  # The services outside any profile. The containers of the old "accounts" profile (a rollback) stay created
  # and stopped: the web app of those releases starts the ones of its accounts.
  # shellcheck disable=SC2046
  docker compose up -d --remove-orphans $(COMPOSE_PROFILES='' docker compose config --services)
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
