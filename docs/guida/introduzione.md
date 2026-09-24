# Introduzione

::: warning Avvertenze
Usa TeamsRelay solo con il **tuo** account e nel rispetto delle policy della tua organizzazione: automatizza una sessione web di Teams a tuo nome. Il progetto non è affiliato né approvato da Microsoft. Se Microsoft cambia l'interfaccia di Teams web, alcune funzioni smettono di funzionare finché i [selettori](/riferimento/selettori) non vengono aggiornati.
:::

## Perché esiste

Alcuni account Microsoft 365, per licenza o per regole di *conditional access*, possono usare Teams **solo dal browser del PC**: le app Teams per Windows, iPhone e Android sono bloccate e Teams web sul telefono non si apre. Lontano dal PC non arrivano né chat né notifiche.

TeamsRelay sposta il browser su un server: un Chromium in un container tiene aperto Teams web con il tuo account, un agent lo legge e lo comanda come faresti tu con mouse e tastiera, e una web app mobile ti mostra tutto e ti manda le notifiche.

## Cosa fa

| Area | Funzioni |
|---|---|
| Lista chat | Foto profilo e foto dei gruppi, anteprima, orario, non letti, chat silenziate con la campanella barrata, filtri Tutte / Non lette / Menzioni, ordine. |
| Messaggi | Testo con la formattazione di Teams (colori, grassetto, elenchi, codice, link), menzioni evidenziate (in rosso quelle a te), emoji, immagini, GIF, file, citazioni, autore e foto nei gruppi, "Modificato". |
| Azioni | Invia, rispondi con citazione, reagisci con sei reazioni rapide, tocca una reazione per toglierla o aggiungerla, modifica ed elimina i tuoi messaggi, annulla l'eliminazione, scarica gli allegati. |
| Stato dei tuoi messaggi | *Inviato*, *Visualizzato*, e nei gruppi *Letto da N su M* con i nomi. |
| Notifiche | Web Push sul telefono per i messaggi nuovi (non per le chat silenziate). Scheda **Notifiche** con il feed Attività di Teams: reazioni ai tuoi messaggi, menzioni, risposte, inviti. |
| Affidabilità | Pannello di stato verde solo se tutto il giro funziona, push quando la sessione scade, controllo automatico due volte al giorno. |
| Desktop | Scheda Desktop (solo da telefono) con il browser remoto, per il login e l'MFA. |

## Come funziona

```mermaid
flowchart LR
  subgraph Server["Server Linux (Docker Compose)"]
    CH["chromium<br/>Teams web loggato"]
    AG["agent<br/>Playwright via CDP"]
    DB[("SQLite<br/>data/messages.db")]
    WA["webapp<br/>FastAPI + PWA"]
    CA["caddy<br/>HTTPS automatico"]
  end
  PH["Telefono<br/>web app TeamsRelay"]
  WP["Servizio Web Push<br/>Apple / Google"]

  AG -- "Chrome DevTools Protocol" --> CH
  AG -- "chat, messaggi, stato" --> DB
  WA -- "legge i dati, accoda comandi" --> DB
  CA --> WA
  PH -- HTTPS --> CA
  AG -- "push firmate VAPID" --> WP --> PH
```

1. **chromium** ([linuxserver/chromium](https://docs.linuxserver.io/images/docker-chromium/)) apre Teams web. Il login lo fai una volta dal desktop remoto e la sessione resta nella cartella `config/`.
2. **agent** si collega al browser con il Chrome DevTools Protocol, legge lista chat, conversazione aperta e feed Attività, li salva in SQLite e manda le push.
3. **webapp** serve la web app e le API. Le tue azioni (apri, invia, reagisci, modifica...) diventano **comandi** in SQLite che l'agent esegue sulla pagina di Teams; la web app segue l'esito di ogni comando.
4. **caddy** pubblica la web app in HTTPS con certificati Let's Encrypt.

Il database è l'unico canale fra web app e agent. I dettagli sono in [Architettura](/riferimento/architettura).

## Da dove partire

- Server nuovo: [Installazione](/guida/installazione), poi [App sul telefono](/guida/telefono).
- Aggiornamenti automatici a ogni push: [Deploy automatico](/guida/deploy).
- Provare sul PC prima di usare un server: [Sviluppo in locale](/guida/sviluppo-locale).
