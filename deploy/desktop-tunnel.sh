#!/bin/bash
# TeamsRelay — tunnel Cloudflare "quick" verso il desktop remoto (porta 3000).
# Scrive l'URL pubblico in $TR_DIR/data/desktop_url.txt: la web app lo legge e lo usa nel tab "Desktop".
# L'URL cambia a ogni riavvio del tunnel; la web app si aggiorna da sola.
TR_DIR="${TR_DIR:-/opt/teamsrelay}"
CF="${CLOUDFLARED:-$(command -v cloudflared)}"
[ -x "$CF" ] || { echo "cloudflared non trovato: installalo (vedi README)" >&2; exit 1; }
# Il tunnel rende il desktop pubblico: senza DESKTOP_PASS chiunque abbia l'URL entrerebbe nel tuo Teams.
grep -qE '^DESKTOP_PASS=.+' "$TR_DIR/.env" 2>/dev/null || { echo "DESKTOP_PASS vuota in $TR_DIR/.env: tunnel non avviato" >&2; exit 1; }
LOG=/tmp/cf-desktop.log; rm -f "$LOG"
"$CF" tunnel --url http://localhost:3000 --no-autoupdate > "$LOG" 2>&1 &
CFPID=$!
for i in $(seq 1 40); do
  U=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" | head -1)
  if [ -n "$U" ]; then mkdir -p "$TR_DIR/data"; echo "$U" > "$TR_DIR/data/desktop_url.txt"; break; fi
  sleep 1
done
wait $CFPID
