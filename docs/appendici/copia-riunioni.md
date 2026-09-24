# Copiare le riunioni su un altro calendario

Per far comparire le riunioni del calendario di lavoro sul calendario di **un altro account Microsoft 365** senza che l'organizzatore riceva notifiche. *Inoltra riunione* avvisa l'organizzatore; qui invece si crea un **evento tuo senza partecipanti**, e nessuno viene avvisato.

## Passaggi

1. Nuovo flusso automatizzato. **Trigger**: *Office 365 Outlook* → **Quando viene creato un nuovo evento (V3)** sul calendario di lavoro, *ID calendario* `Calendar`.
2. **Azione**: **Crea evento (V4)**, con una **connessione all'altro account**:
   - *Cambia connessione → Aggiungi nuovo → Accedi*.
   - Se il popup riusa da solo l'account di lavoro (succede quando nel browser c'è un solo account Microsoft), prima aggiungere l'altro account: `login.microsoftonline.com` → **Usa un altro account** → accesso. Poi di nuovo *Aggiungi nuovo* e scegliere l'account giusto.
   - In fondo al pannello deve comparire *Connesso a* seguito dall'altro account.
3. Campi di *Crea evento (V4)*:
   - **ID calendario**: `Calendar` dell'altro account.
   - **Oggetto**: `<ORG> - Forward: ` + **Oggetto**.
   - **Ora di inizio** / **Ora di fine**: i contenuti dinamici **Ora di inizio** / **Ora di fine**.
   - **Fuso orario**: **(UTC) Coordinated Universal Time**. Gli orari del trigger sono in UTC; Outlook li mostra nell'ora locale.
   - Parametri avanzati: **Corpo** = **Corpo** (contiene il link della riunione Teams), **Percorso** = **Percorso** (si trova scrivendo "Locali" nel selettore).
   - **Partecipanti vuoti**: altrimenti partono degli inviti.
4. Salva.

## Da sapere

- La frequenza di controllo del trigger **non si configura**: dipende dal piano, da 1 a 5 minuti circa.
- Appena creato, il flusso può mostrare *"Attivazione non completata negli ultimi 28 giorni"*: sparisce al primo controllo.
- Vengono presi solo gli eventi creati **dopo** l'attivazione: per il test serve un evento nuovo.
- Modifiche e annullamenti successivi della riunione **non** vengono sincronizzati.
- Vengono copiati **tutti** i nuovi eventi del calendario di lavoro, anche quelli creati da te.
