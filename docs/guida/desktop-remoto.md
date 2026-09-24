# Desktop remoto

Il desktop remoto è il Chromium del server con Teams aperto. Serve per il primo login e per rifarlo quando la sessione scade.

## Dall'app

È pubblicato sullo stesso indirizzo dell'app, protetto dallo **stesso login**:

```
https://<DOMAIN>/desktop/
```

- **Da PC**: pannello di stato (la pillola in alto a destra) → **Apri Teams remoto**, oppure l'indirizzo qui sopra.
- **Da telefono**: scheda **Desktop**.

Senza sessione valida si finisce sulla pagina di login di TeamsRelay e, dopo l'accesso, si torna al desktop. Caddy chiede alla web app (`/api/authcheck`) se il cookie di sessione è valido prima di far passare ogni richiesta verso il Chromium.

Chi entra nell'app entra anche nel desktop, cioè nella sessione Teams: per questo il login della web app ha un freno ai tentativi (pausa a ogni errore, blocco di 15 minuti dopo 10 errori dallo stesso IP) e conviene una `UI_PASS` robusta.

Con il desktop dietro il login dell'app, `DESKTOP_PASS` può restare vuota: altrimenti il Chromium chiede una seconda password.

## Alternative

Servono solo se non si vuole il desktop sul dominio pubblico.

**Tunnel SSH**, nessuna esposizione:

```bash
ssh -L 3100:localhost:3000 utente@ip-del-server
```

Poi `http://localhost:3100/desktop/`.

**Tunnel Cloudflare "quick"**, con `deploy/teamsrelay-desktop.service`: scrive l'URL in `data/desktop_url.txt`, che la web app usa al posto di `/desktop/`. Il tunnel espone il Chromium senza passare dal login dell'app, quindi lo script non parte senza `DESKTOP_PASS`.

**Sottodominio con Caddy**: blocco commentato in `caddy/Caddyfile`, con `DESKTOP_DOMAIN` e `DESKTOP_URL` nel `.env`. Anche qui la protezione è `DESKTOP_PASS`.
