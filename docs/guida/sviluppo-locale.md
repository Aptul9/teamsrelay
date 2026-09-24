# Sviluppo in locale

Lo stack gira anche sul PC con Docker Desktop, senza dominio e senza login.

```bash
docker compose -f docker-compose.yml -f compose.local.yml up -d --build chromium agent webapp
```

| Indirizzo | Cosa |
|---|---|
| `http://localhost:3000` | Browser remoto con Teams: qui si fa il login. |
| `http://localhost:8090` | Web app TeamsRelay. |

`compose.local.yml` cambia tre cose rispetto alla produzione:

- **niente Caddy**: `http://localhost` è già un contesto sicuro per service worker e Web Push;
- **niente login** su web app e desktop, perché entrambi ascoltano solo su `127.0.0.1`;
- **volumi Docker** al posto delle cartelle `config/` e `data/`: sul filesystem Windows lock di SQLite e symlink del profilo Chromium non sono affidabili.

Nel `.env` locale basta `DOMAIN=localhost`; le altre credenziali possono restare vuote.

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
