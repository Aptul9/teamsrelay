# Configurazione

Tutta la configurazione sta nel file `.env` accanto a `docker-compose.yml`. Si parte da `.env.example`. Il file contiene password: resta sul server, è escluso da git e il deploy automatico non lo tocca.

## Variabili

| Variabile | Obbligatoria | Descrizione |
|---|---|---|
| `DOMAIN` | sì | Nome pubblico della web app, per esempio `teams.example.com` o `84-8-248-192.sslip.io`. Caddy chiede il certificato per questo nome. |
| `UI_USER`, `UI_PASS` | sì | Credenziali della web app. Senza, la web app non parte (tranne in locale, vedi sotto). |
| `SESSION_SECRET` | consigliata | Firma il cookie di sessione, che dura un anno. Se è vuota viene derivata da utente e password. Cambiarla disconnette tutti i dispositivi. |
| `DESKTOP_USER`, `DESKTOP_PASS` | no | Password propria di ogni Chromium. Lasciale vuote: il desktop di ogni account è su `/desktop/N/` dietro il login della web app (UI_USER/UI_PASS), e con una password il Chromium ne chiederebbe una seconda. |
| `DESKTOP_URL` | no | Template dell'indirizzo del desktop remoto, con `{n}` al posto del numero di slot. Vuoto vale `/desktop/{n}/` sullo stesso dominio dell'app. |
| `VAPID_SUBJECT` | no | Contatto richiesto dallo standard Web Push, nella forma `mailto:...`. |
| `TZ` | no | Fuso orario, usato dai controlli automatici delle fasce 8-11 e 17-20. |
| `HTTPS_PORT`, `HTTPS_BIND` | no | Porta e interfaccia di Caddy. Default `443` e `0.0.0.0`. Con sslh: `8443` e `127.0.0.1`. |
| `NTFY_ENABLED`, `NTFY_URL`, `NTFY_TOPIC` | no | Notifiche aggiuntive via [ntfy](https://ntfy.sh), spente di default. |

## Applicare una modifica

```bash
docker compose up -d
```

Ricrea solo i container la cui configurazione è cambiata.

## Variabili per il solo uso locale

Il file `compose.local.yml` (vedi [Sviluppo in locale](/guida/sviluppo-locale)) imposta:

| Variabile | Effetto |
|---|---|
| `NO_AUTH=1` sulla web app | Nessun login. Senza questa variabile, credenziali vuote bloccano l'avvio: un server non resta mai aperto per errore. |
| `PASSWORD=` vuota sul desktop | Nessuna password sulla pagina del browser remoto. |

Entrambe hanno senso solo perché in locale le porte sono legate a `127.0.0.1`.
