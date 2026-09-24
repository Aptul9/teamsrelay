# Uso quotidiano

L'app ha le schede **Notifiche** e **Chat**, più **Desktop** da telefono. La foto profilo in alto a sinistra gestisce gli account.

## Account

Fino a 4 account Teams contemporanei. Tocca la foto in alto a sinistra.

| Elemento | Effetto |
|---|---|
| **Nomi degli account** | Scorri la lista o tocca un nome per passarvi: le chat cambiano al volo. Il nome con la spunta è quello attivo. Accanto a ogni nome: foto profilo, email e organizzazione, e un pallino rosso se ha messaggi non letti. |
| **Teams remoto** / **Accesso a Microsoft da fare** | Ogni account ha il suo pulsante. Con "Teams remoto" il login è fatto; con "Accesso a Microsoft" toccalo per aprire la pagina di login nel desktop remoto di quell'account. |
| **Rimuovi** | Cancella l'account: conferma, poi lo slot si spegne e la sessione Teams di TeamsRelay sparisce (il tuo account Microsoft non cambia). |
| **Aggiungi account** | Tocca per aggiungere il prossimo. Si avvia il browser remoto dello slot libero e si apre la pagina di login. Massimo 4. |
| **Nessun account Teams** | Messaggio quando non ce n'è nessuno. Aggiungi il primo. |

Notifiche: con più di un account attivo, il titolo della notifica push include l'organizzazione o l'email per riconoscere da quale account viene.

## Lista chat

- Foto profilo e foto dei gruppi come in Teams; chi non ha foto ha le iniziali.
- Grassetto e pallino rosso per le chat non lette; il numero sul tab Chat conta le non lette.
- Le **chat silenziate** hanno la campanella barrata, non contano fra le non lette e non mandano notifiche, come in Teams.
- Filtri *Tutte*, *Non lette*, *Menzioni* e ordine dalle più recenti o dalle meno recenti.
- Trascina verso il basso per aggiornare.

## Conversazione

Toccando una chat, il server la apre anche nel Teams remoto: il primo caricamento richiede un paio di secondi.

I messaggi mostrano testo formattato come in Teams (colori, grassetto, elenchi, codice, link), menzioni evidenziate (in rosso quelle a te, con una **@** rossa sul messaggio), emoji, immagini, GIF, allegati, citazioni e reazioni. Nei gruppi nome e foto dell'autore compaiono sul primo di più messaggi consecutivi.

Sotto i tuoi messaggi:

| Testo | Significato |
|---|---|
| Invio... | L'app ha inviato il comando, Teams non lo mostra ancora. |
| Inviato | Il messaggio è su Teams. |
| Visualizzato | Chat 1:1: l'altra persona l'ha letto. |
| Letto da N su M: nomi | Gruppo: chi l'ha letto. Arriva da solo dopo pochi secondi, senza toccare nulla. |
| Letto da tutti | Gruppo: l'hanno letto tutti. |
| Modificato | Il messaggio è stato modificato. |

## Azioni su un messaggio

Tocca un messaggio: compare la barra con le reazioni e le azioni.

| Azione | Dove | Come funziona |
|---|---|---|
| Reazione | tutti i messaggi | Sei reazioni rapide. Toccarne una già tua la toglie. |
| Rispondi | tutti i messaggi | Sopra il box compare la citazione; il messaggio arriva su Teams come *Reply with quote*. |
| Modifica | i tuoi | Il testo torna nel box; l'invio lo sostituisce su Teams. |
| Elimina | i tuoi | Immediato, come in Teams. Il messaggio diventa *Messaggio eliminato* con **Annulla**. |

Toccando una **reazione sotto un messaggio**: se è tua la togli, se è di altri aggiungi la stessa. Vale per qualsiasi emoji, anche fuori dalle sei rapide.

Ogni azione viene confermata solo quando compare davvero su Teams. Se non compare, l'app lo dice con un avviso in basso e riporta il messaggio com'era.

## Allegati

Toccando un file l'agent lo scarica da SharePoint con la sessione di Teams e il telefono lo salva. Dal telefono il link SharePoint diretto chiederebbe il login Microsoft, bloccato dalle stesse policy che bloccano l'app.

## Scheda Notifiche

È il feed **Attività** di Teams: reazioni ai tuoi messaggi, menzioni (tue e di gruppo), risposte, inviti alle riunioni. Filtri *Tutte*, *Non lette*, *Menzioni*, *Reazioni*. Toccando una voce si apre la chat. Il feed si aggiorna ogni pochi minuti e ogni volta che apri la scheda.

## Pannello di stato

Tocca la pillola in alto a destra.

| Riga | Significato |
|---|---|
| Teams | *Connesso*, *Login scaduto*, *In caricamento* o *Non verificabile* (agent fermo). |
| Rilevamento nuovi messaggi | *Attivo* se l'agent ha letto le chat nell'ultimo minuto. |
| Motore browser | *Attivo* se l'agent è collegato al browser e ha aggiornato lo stato nell'ultimo minuto. |
| Ultimo messaggio | Ora dell'ultima notifica. |
| Notifiche push | Dispositivi registrati. |

**Risincronizza** rilegge subito chat e conversazione. **Riverifica** fa un controllo completo e ne manda l'esito come push.
