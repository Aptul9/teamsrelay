# Inoltrare le email con Power Automate

Per quando l'account di lavoro **non permette l'inoltro automatico** verso un indirizzo esterno: molti amministratori bloccano sia le regole di Outlook sia l'impostazione *Inoltro*.

Un flusso Power Automate, per ogni email in arrivo, **compone e invia una nuova email** verso l'altro indirizzo con l'azione *Invia un messaggio di posta elettronica*. È posta in uscita normale e di solito passa; l'azione *Inoltra* invece verrebbe fermata dalla stessa policy. Va comunque provato.

## Passaggi

1. **make.powerautomate.com** con l'account di lavoro → **Crea da zero**, flusso automatizzato.
2. **Trigger**: *Office 365 Outlook* → **All'arrivo di un nuovo messaggio di posta elettronica (V3)**.
   - La prima volta chiede di creare la connessione: **Accedi** e completa il popup subito, prima che scada.
   - *Cartella*: `Inbox`. *Includi allegati*: **Sì** (se il menu mostra solo "No", scrivere `Sì` nel campo e sceglierlo).
3. **Azione**: *Office 365 Outlook* → **Invia un messaggio di posta elettronica (V2)**.
   - **A**: l'altro indirizzo, poi *Usa "..."*.
   - **Oggetto**: `Mail <ORG> inoltrata: ` seguito dal contenuto dinamico **Oggetto**.
   - **Corpo**: `Mail <ORG> inoltrata. Da: ` + **Da**, una riga vuota, poi **Corpo**.
   - **Allegati** (*Mostra tutto* nei parametri avanzati): modalità **matrice intera** (icona a destra del campo) con il contenuto dinamico **Allegati**.
4. Nome del flusso e **Salva**. È attivo da subito.

Contenuto dinamico: in un campo si digita `/` → *Inserisci contenuto dinamico*, oppure l'icona a forma di fulmine a destra del campo.

Il Copilot di Power Automate può sostenere che il connettore Office 365 Outlook "non è disponibile": va verificato cercando il trigger a mano, nel caso reale era disponibile.

## Da sapere

- La copia arriva **dal tuo indirizzo di lavoro**; il mittente originale è nel corpo.
- Vengono copiate **tutte** le email. Per filtrarle si aggiunge una *Condizione*.
