#!/bin/bash
# TeamsRelay — deploy sul server, lanciato dalla GitHub Action via SSH.
#   remote-deploy.sh backup        salva il codice attuale (per il rollback)
#   remote-deploy.sh up <sha>      ricostruisce e riavvia; se la web app non risponde torna alla versione salvata
# Il codice arriva con rsync dalla Action; .env, config/, data/ e vapid/ restano sul server e non vengono toccati.
set -euo pipefail
TR_DIR="${TR_DIR:-/opt/teamsrelay}"
BACKUP=/var/tmp/teamsrelay-prev.tgz
cd "$TR_DIR"

code_files() {
  # tutto tranne i dati di runtime
  find . -mindepth 1 -maxdepth 1 ! -name .env ! -name config ! -name data ! -name vapid -printf '%P\n'
}

healthy() {
  # la web app risponde dentro il suo container e l'agent è in esecuzione
  for _ in $(seq 1 30); do
    if docker compose exec -T webapp python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=3)" >/dev/null 2>&1 \
       && [ "$(docker inspect -f '{{.State.Running}}' teams-agent 2>/dev/null)" = "true" ]; then
      return 0
    fi
    sleep 4
  done
  return 1
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
    docker compose up -d --build --remove-orphans
    # Caddy non ha un'immagine da ricostruire e legge il Caddyfile montato: rsync lo sostituisce con un file
    # nuovo e il container continuerebbe a vedere il vecchio. Se è cambiato, si riavvia (i certificati restano nel volume).
    caddy_sum="$(sha256sum caddy/Caddyfile | cut -d' ' -f1)"
    if [ "$caddy_sum" != "$(cat .caddyfile-sum 2>/dev/null)" ]; then
      docker compose restart caddy && echo "$caddy_sum" > .caddyfile-sum
    fi
    if healthy; then
      echo "$sha" > .deployed-sha
      docker image prune -f >/dev/null
      echo "ok: $sha in esecuzione"
      exit 0
    fi
    echo "la web app non risponde dopo il deploy di $sha: rollback" >&2
    docker compose logs --tail 40 webapp agent >&2 || true
    if [ -f "$BACKUP" ]; then
      code_files | xargs -r rm -rf
      tar -xzf "$BACKUP"
      docker compose up -d --build --remove-orphans
      healthy && echo "rollback completato: $(cat .deployed-sha 2>/dev/null || echo versione precedente)" >&2
    fi
    exit 1
    ;;
  *)
    echo "uso: $0 backup | up <sha>" >&2; exit 2
    ;;
esac
