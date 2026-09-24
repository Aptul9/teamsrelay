# Architettura

## Container

| Servizio | Immagine | Ruolo | Esposizione |
|---|---|---|---|
| `chromium` | `lscr.io/linuxserver/chromium` | Teams web con la sessione in `config/`, CDP su `127.0.0.1:9222` | `127.0.0.1:3000-3001` (interfaccia del desktop) |
| `agent` | `./agent` (Python, Playwright come client CDP) | Legge e comanda Teams, manda le push | nessuna; condivide la rete di `chromium` |
| `webapp` | `./webapp` (FastAPI) | PWA e API | solo tramite Caddy |
| `caddy` | `caddy:2` | HTTPS automatico, reverse proxy | `80`, `${HTTPS_BIND}:${HTTPS_PORT}` |

L'agent si collega a `http://127.0.0.1:9222`: Chromium espone CDP solo su IPv4, e `localhost` nel container risolve prima `::1`.

## Web app e agent

Web app e agent non si parlano direttamente: condividono `data/messages.db` (SQLite in WAL).

```mermaid
sequenceDiagram
  participant T as Telefono
  participant W as webapp
  participant D as SQLite
  participant A as agent
  participant C as Teams (Chromium)
  T->>W: POST /api/react {name, mid, emoji}
  W->>D: INSERT commands (pending)
  W-->>T: {id}
  loop ogni ~1 s
    A->>D: comandi pending
  end
  A->>C: apre la chat, hover reale, click sul pulsante
  A->>C: verifica il cambio sulla pagina
  A->>D: salva la conversazione, poi status done/failed
  T->>W: GET /api/cmd/{id}
  W-->>T: done
  T->>W: GET /api/messages
```

Lo stato della conversazione viene salvato **prima** di segnare il comando come concluso: quando la web app vede `done` e rilegge, trova già il nuovo stato.

## Ciclo dell'agent

Un giro al secondo, circa:

| Quando | Cosa |
|---|---|
| ogni giro | hook delle notifiche di Teams (sorgente secondaria), comandi in coda, conversazione aperta |
| ogni ~3 giri | lista chat visibile: foto, anteprime, non letti, silenziate; rilevamento messaggi nuovi e push |
| ogni ~5 giri | stato di salute; se la sessione è scaduta, una sola push di avviso |
| ogni 2 giri, senza comandi | "Letto da" di un tuo messaggio recente nel gruppo aperto |
| ogni ~150 giri | feed Attività (passa alla vista Activity e torna alla chat) |
| ogni ~300 giri | lista chat completa, scorrendola dall'inizio alla fine |
| 8-11 e 17-20 | controllo automatico con push dell'esito |

Un messaggio è nuovo quando l'anteprima o l'orario di una chat cambia con un testo in arrivo, oppure quando la chat passa a non letta. Le chat silenziate e la chat con sé stessi non notificano; le notifiche uguali entro 150 s vengono scartate.

### Robustezza

- **Liste virtualizzate**: Teams disegna solo le voci che entrano nella finestra, e la finestra dipende da chi guarda il desktop remoto. Le letture parziali aggiornano la testa della lista senza cancellare il resto; la lettura completa scorre la lista e la riscrive in una sola transazione.
- **Reload di Teams**: se la pagina si ricarica l'agent chiude la vecchia connessione CDP e ne apre una nuova; senza chat aperta riapre quella in uso; se non vede la scheda per 60 s termina e Docker lo riavvia.
- **Chat giusta**: prima di salvare una conversazione l'agent controlla il titolo della chat aperta in Teams (`[data-tid="chat-title"]`), così un cambio di chat dal desktop non mescola i messaggi. L'invio rifiuta di scrivere se la chat aperta non è quella richiesta.

## Come vengono fatte le azioni

- **Barra azioni**: compare solo con un hover vero del mouse, gli eventi sintetici via JavaScript vengono ignorati. È disegnata in un portal fuori dal messaggio e possono esserne visibili due: si usa quella più vicina al messaggio e si clicca per coordinate.
- **Apertura di una chat**: click sulla riga. L'unico pulsante dentro la riga è *More chat options*, con voci come *Hide* e *Remove chat history*.
- **Reazioni**: pulsanti rapidi della barra, o il picker per 😢 e 😠. Togliere o aggiungere dalla pill sotto il messaggio è un click sulla pill (`aria-pressed` dice se è tua).
- **Rispondi**: *Reply with quote*, sulla barra per i messaggi altrui e nel menu *More options* per i tuoi. Dopo la citazione il cursore è già nel box: il testo si scrive senza cliccare e si invia con Invio.
- **Modifica**: editor in linea nel messaggio, pulsante *Done*. Se qualcosa va storto la bozza viene scartata (*Discard draft*), il messaggio resta com'era.
- **Elimina**: *More options → Delete*, immediato; *Undo* resta disponibile per poco.
- **Letto da**: voce *Read by X of Y* del menu *More options* e il suo sottomenu con i nomi.

## Contenuti

- **Testo**: il corpo del messaggio viene ricostruito dal DOM in HTML ridotto: solo tag noti, colori validati, link http(s), testo sempre escapato. Le emoji di Teams sono immagini con l'emoji nell'`alt`.
- **Immagini** dei messaggi: URL `blob:` o AMS leggibili solo nella pagina, scaricate con `fetch` dalla pagina in `data/media`. Le GIF di Giphy bloccano CORS e restano come URL pubblico.
- **Foto profilo**: l'API di Teams vuole il suo token e rifiuta `fetch`; le foto sono già disegnate nella pagina e sono dello stesso dominio, quindi vengono copiate da un canvas.
- **Allegati**: link SharePoint scaricati con la sessione del browser (`download=1`) in `data/files`, solo per `*.sharepoint.com`.

## Tabelle SQLite

| Tabella | Contenuto |
|---|---|
| `chats` | lista chat: nome, anteprima, ora, non letto, menzione, silenziata, foto |
| `chat_messages` | messaggi delle chat aperte; i campi ricchi (HTML, immagini, file, reazioni, stato, letto da) stanno in `extra` come JSON |
| `readby` | "Letto da" per messaggio |
| `activity` | feed Attività |
| `commands` | coda dei comandi della web app con esito |
| `messages` | storico delle notifiche inviate |
| `state` | salute, chat attiva, risultati dei comandi |
| `push_subs` | sottoscrizioni Web Push |

## File del progetto

```
teamsrelay/
├── docker-compose.yml        stack di produzione
├── compose.local.yml         override per il PC (niente Caddy, niente login)
├── .env.example
├── agent/agent.py            lettura e pilotaggio di Teams, push, salute
├── webapp/app.py             API FastAPI, login, sessione, media e file
├── webapp/index.html         la PWA
├── webapp/static/            manifest, service worker, icone
├── caddy/Caddyfile
├── deploy/remote-deploy.sh   deploy e rollback sul server
├── deploy/desktop-tunnel.sh  tunnel Cloudflare per il desktop
├── .github/workflows/        CI/CD
├── docs/                     questa documentazione (VitePress)
└── tools/                    chiavi VAPID, icone
```

Create a runtime e mai versionate: `config/` (profilo del browser con la sessione Teams), `data/`, `vapid/`.
