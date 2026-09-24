# Desktop remoto

Il browser remoto (porta 3000 del server, solo su localhost) serve per il primo login e per rifarlo quando la sessione scade. Tre modi per raggiungerlo.

## A. Tunnel SSH

Nessuna esposizione, solo dal PC.

```bash
ssh -L 3100:localhost:3000 utente@ip-del-server
```

Poi `http://localhost:3100`. La porta locale 3100 evita il conflitto con uno stack locale già su 3000.

## B. Tunnel Cloudflare "quick"

Nessun DNS da configurare, funziona anche dalla scheda **Desktop** del telefono.

```bash
# cloudflared: per x86_64 sostituire arm64 con amd64
curl -L -o /tmp/cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i /tmp/cloudflared.deb

# servizio che tiene su il tunnel e scrive l'URL in data/desktop_url.txt
sudo cp deploy/teamsrelay-desktop.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now teamsrelay-desktop
cat data/desktop_url.txt
```

L'URL cambia a ogni riavvio del tunnel e la web app lo legge da sola. Chi ha l'URL arriva alla pagina di login del desktop: `DESKTOP_PASS` deve essere robusta, e senza `DESKTOP_PASS` lo script si rifiuta di avviare il tunnel.

## C. Sottodominio con Caddy

URL fisso.

1. Record DNS A per `desktop.example.com`.
2. Nel `.env`: `DESKTOP_DOMAIN=desktop.example.com` e `DESKTOP_URL=https://desktop.example.com`.
3. Togliere il commento al blocco del desktop in `caddy/Caddyfile`.
4. `docker compose up -d`.
