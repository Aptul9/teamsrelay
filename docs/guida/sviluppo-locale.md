# Sviluppo in locale

Lo stack gira anche sul PC con Docker Desktop, senza dominio e senza login.

```bash
docker compose --env-file compose.local.env -f docker-compose.yml -f compose.local.yml --profile accounts create --build
docker compose --env-file compose.local.env -f docker-compose.yml -f compose.local.yml up -d
```

| Indirizzo | Cosa |
|---|---|
| `http://localhost:8090` | Web app TeamsRelay. |
| `http://localhost:8090/desktop/N/` | Browser remoto con Teams dell'account N: qui si fa il login. |

`compose.local.env` e `compose.local.yml` cambiano tre cose rispetto alla produzione:

- **niente Caddy**: `http://localhost` è già un contesto sicuro per service worker e Web Push;
- **niente login** (NO_AUTH=1) su web app e desktop, perché entrambi ascoltano solo su `127.0.0.1`;
- **volumi Docker** al posto delle cartelle `config/` e `data/`: sul filesystem Windows lock di SQLite e symlink del profilo Chromium non sono affidabili.

Nel `compose.local.env`: `DOMAIN=localhost` e credenziali vuote (`UI_USER=`, `UI_PASS=`).

## Modificare il codice

`agent.py`, `app.py`, `index.html`, `login.html` e `static/` sono montati nei container. Dopo una modifica:

```bash
docker compose -f docker-compose.yml -f compose.local.yml restart agent    # oppure webapp
```

`up -d` da solo non ricarica i file montati. `--build` serve solo se cambia un `Dockerfile`.

## Documentazione

```bash
npm install
npm run docs:dev        # http://localhost:5173
npm run docs:build      # sito statico in docs/.vitepress/dist
```

## Fermare tutto

```bash
docker compose -f docker-compose.yml -f compose.local.yml down
```

I volumi `tr_config` (sessione Teams) e `tr_data` restano; `down -v` li cancella.
