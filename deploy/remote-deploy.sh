#!/bin/bash
# TeamsRelay — deploy sul server, lanciato dalla GitHub Action via SSH.
#   remote-deploy.sh backup        salva il codice attuale (per il rollback)
#   remote-deploy.sh up <sha>      ricostruisce e riavvia; se la web app non risponde torna alla versione salvata
# Il codice arriva con rsync dalla Action; .env, config/, data/ e vapid/ restano sul server e non vengono toccati.
set -euo pipefail
TR_DIR="${TR_DIR:-/opt/teamsrelay}"
BACKUP=/var/tmp/teamsrelay-prev.tgz
cd "$TR_DIR"
# gli slot degli account (chromium-N, agent-N) sono nel profilo "accounts": qui vanno sempre considerati
export COMPOSE_PROFILES=accounts

code_files() {
  # tutto tranne i dati di runtime
  find . -mindepth 1 -maxdepth 1 ! -name .env ! -name config ! -name data ! -name vapid ! -name .caddyfile-sum -printf '%P\n'
}

migrate() {
  # Dal layout a un solo account (config/, data/messages.db) allo slot 1 (config/1, data/1), a container fermi.
  # I file sono di root e dell'utente del browser: li sposta un container usa e getta.
  if [ -f data/messages.db ] || { [ -d config ] && [ ! -d config/1 ] && [ -n "$(ls -A config 2>/dev/null)" ]; }; then
    echo "migrazione: sessione Teams e dati nello slot 1"
    docker rm -f teams-agent teams-chromium >/dev/null 2>&1 || true
    docker run --rm -v "$TR_DIR:/w" -w /w --entrypoint sh caddy:2 -c '
      set -e
      if [ -d config ] && [ ! -d config/1 ] && [ -n "$(ls -A config)" ]; then
        mkdir config/.slot1
        find config -mindepth 1 -maxdepth 1 ! -name .slot1 -exec mv {} config/.slot1/ \;
        mv config/.slot1 config/1 && chown 1000:1000 config/1
      fi
      if [ -f data/messages.db ] && [ ! -e data/1/messages.db ]; then
        mkdir -p data/1
        for f in messages.db messages.db-wal messages.db-shm media files; do [ ! -e "data/$f" ] || mv "data/$f" data/1/; done
      fi'
  fi
}

healthy() {
  # la web app risponde dentro il suo container, poi nessun agent deve essere in un ciclo di riavvii
  for _ in $(seq 1 30); do
    if docker compose exec -T webapp python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=3)" >/dev/null 2>&1; then
      # la web app riaccende gli slot degli account entro pochi secondi dall'avvio
      sleep 25
      bad="$(docker ps --filter name=teams-agent- --filter status=restarting --format '{{.Names}}')"
      [ -z "$bad" ] && return 0
      echo "agent in riavvio continuo: $bad" >&2; return 1
    fi
    sleep 4
  done
  return 1
}

start() {
  migrate
  docker compose build
  # Tutti gli slot esistono, spenti: la web app accende quelli degli account (via dockerproxy può solo avviare
  # e fermare container già creati). Un container la cui configurazione è cambiata viene ricreato spento
  # e la web app lo riaccende.
  docker compose create
  docker compose up -d --remove-orphans webapp dockerproxy caddy
  # Caddy non ha un'immagine da ricostruire e legge il Caddyfile montato: rsync lo sostituisce con un file
  # nuovo e il container continuerebbe a vedere il vecchio. Se è cambiato, si riavvia (i certificati restano nel volume).
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
    [ -f .env ] || { echo ".env mancante in $TR_DIR: il primo setup va fatto a mano (vedi README)" >&2; exit 1; }
    echo "deploy $sha"
    start
    if healthy; then
      echo "$sha" > .deployed-sha
      docker image prune -f >/dev/null
      docker ps --filter name=teams- --format '{{.Names}}: {{.Status}}'
      echo "ok: $sha in esecuzione"
      exit 0
    fi
    echo "la web app non risponde dopo il deploy di $sha: rollback" >&2
    docker compose logs --tail 40 webapp >&2 || true
    if [ -f "$BACKUP" ]; then
      code_files | xargs -r rm -rf
      tar -xzf "$BACKUP"
      rm -f .caddyfile-sum
      start
      healthy && echo "rollback completato: $(cat .deployed-sha 2>/dev/null || echo versione precedente)" >&2
    fi
    exit 1
    ;;
  *)
    echo "uso: $0 backup | up <sha>" >&2; exit 2
    ;;
esac
