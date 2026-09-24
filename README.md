# TeamsRelay

Microsoft Teams sul telefono anche quando le app native sono bloccate. Un Chromium sul tuo server tiene aperto Teams web con il tuo account; una web app installabile ti dà chat, notifiche push e le azioni di Teams (rispondi, reagisci, modifica, elimina), con lo stesso aspetto dell'app.

> Usa TeamsRelay solo con il tuo account e nel rispetto delle policy della tua organizzazione. Il progetto non è affiliato né approvato da Microsoft; "Microsoft Teams" è un marchio di Microsoft.

## Documentazione

La documentazione completa è in [`docs/`](docs/) ed è un sito VitePress:

```bash
npm install
npm run docs:dev          # http://localhost:5173
```

| Argomento | Pagina |
|---|---|
| Cosa fa e come funziona | [docs/guida/introduzione.md](docs/guida/introduzione.md) |
| Installazione su un server | [docs/guida/installazione.md](docs/guida/installazione.md) |
| Variabili di `.env` | [docs/guida/configurazione.md](docs/guida/configurazione.md) |
| Deploy automatico con GitHub Actions | [docs/guida/deploy.md](docs/guida/deploy.md) |
| Prova sul PC con Docker Desktop | [docs/guida/sviluppo-locale.md](docs/guida/sviluppo-locale.md) |
| Problemi frequenti | [docs/guida/manutenzione.md](docs/guida/manutenzione.md) |
| Architettura, API, selettori di Teams | [docs/riferimento/](docs/riferimento/) |

## Avvio rapido

Server Linux con Docker, porte 80 e 443 aperte:

```bash
git clone <url-del-repository> /opt/teamsrelay && cd /opt/teamsrelay
cp .env.example .env && nano .env          # DOMAIN, UI_USER, UI_PASS
docker run --rm -v "$PWD:/w" -w /w python:3.12-slim \
  sh -c "pip install -q cryptography && python tools/gen_vapid.py vapid"
docker compose up -d --build
```

Poi apri l'app su `https://<DOMAIN>` (credenziali UI_USER e UI_PASS), aggiungi il tuo account Teams, e accedi dal desktop remoto. Passo per passo: [Installazione](docs/guida/installazione.md).

## Licenza

Vedi [LICENSE](LICENSE).
