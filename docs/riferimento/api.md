# API della web app

Tutte le API richiedono il cookie di sessione ottenuto con `/api/login`, oppure un header `Authorization: Basic`. Fanno eccezione quelle marcate *pubblica*.

Le azioni su Teams sono asincrone: la risposta contiene l'`id` di un comando, e `/api/cmd/{id}` ne dà l'esito quando l'agent ha visto il cambio sulla pagina.

## Lettura

| Metodo | Percorso | Risposta |
|---|---|---|
| GET | `/api/chats` | `name, preview, tm, unread, mention, muted, av` |
| GET | `/api/messages?name=<chat>` | per messaggio: `mid, author, text, mine, reacts` e, se presenti, `html, quote, images, files, reactions, status, readby, edited, deleted, mentionsMe, av` |
| GET | `/api/activity` | `{ts, items}` con `id, kind, actor, title, emoji, preview, tm, chat, channel, unread, av`; `kind` fra `reaction, mention, reply, message, meeting` |
| GET | `/api/feed` | storico delle notifiche inviate |
| GET | `/api/health` | stato, vedi sotto |
| GET | `/api/cmd/{id}` | `{status, result}`, `status` fra `pending, done, failed` |
| GET | `/media/{file}` | immagini dei messaggi e foto profilo |
| GET | `/files/{file}?name=<nome>` | allegato scaricato, con il suo nome originale |

## Azioni

| Metodo | Percorso | Corpo |
|---|---|---|
| POST | `/api/open` | `{name}` apre la chat nel Teams remoto |
| POST | `/api/send` | `{name, text}` |
| POST | `/api/reply` | `{name, mid, text}` risposta con citazione |
| POST | `/api/edit` | `{name, mid, text}` solo messaggi propri |
| POST | `/api/delete` | `{name, mid}` solo messaggi propri |
| POST | `/api/undodelete` | `{name, mid}` |
| POST | `/api/react` | `{name, mid, emoji}` con `emoji` fra `like, heart, laugh, surprised, cry, angry`; oppure `{name, mid, pill}` con l'emoji di una reazione già presente, che viene tolta se è tua o aggiunta se è di altri |
| POST | `/api/download` | `{url, name}` solo link `https://*.sharepoint.com`; il risultato ha il file da chiedere a `/files` |
| POST | `/api/activity/refresh` | rilegge il feed Attività |
| POST | `/api/resync` | rilegge subito chat e conversazione |
| POST | `/api/recheck` | controllo completo con esito via push |
| POST | `/api/push/subscribe` | registra una sottoscrizione Web Push |

## Pubbliche

| Metodo | Percorso | Risposta |
|---|---|---|
| GET | `/` | la PWA, oppure la pagina di login |
| POST | `/api/login` | `{user, password}`, imposta il cookie; `429` dopo 10 errori in 15 minuti dallo stesso IP |
| GET | `/api/vapidkey` | chiave pubblica VAPID |
| GET | `/sw.js`, `/manifest.webmanifest`, `/static/*` | service worker, manifest, icone |
| GET | `/healthz` | liveness della web app |
| GET | `/api/authcheck` | usata da Caddy per `/desktop/`: 200 con sessione valida, altrimenti redirect al login con `next` |

## `/api/health`

| Campo | Valori |
|---|---|
| `agent` | `ok` se l'agent ha aggiornato lo stato negli ultimi 60 s, altrimenti `stale` e gli altri campi non sono affidabili |
| `teams` | `ok`, `login`, `loading`, `err`, `unknown` |
| `reduced` | modalità ridotta di Teams attiva |
| `watcher` | `ok` se l'ultima lettura delle chat ha meno di 60 s |
| `hook` | hook delle notifiche installato nella pagina |
| `ts`, `last_scan_ts`, `last_msg_ts` | timestamp Unix |
| `push_subs` | dispositivi registrati |
| `overall` | `green`, `yellow`, `red` |
