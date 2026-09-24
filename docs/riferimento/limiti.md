# Limiti noti

Verificati sul campo.

| Limite | Dettaglio |
|---|---|
| Presenza | Lo stato (Disponibile, Occupato...) non si imposta: nei test Teams l'ha lasciato su *Unknown* in tutti i casi provati. Probabilmente dipende dalle policy del tenant. |
| Sessione che scade | Il conditional access invalida i token e Teams smette di sincronizzare. TeamsRelay lo rileva (stato rosso e push) e il login si rifà dal desktop remoto. |
| Solo chat | Chat 1:1 e di gruppo, fino a 40 nella lista, ultimi 40 messaggi della chat aperta. I canali dei Team compaiono nel feed Attività ma non si aprono. |
| Letto da | Raccolto solo per la chat aperta, sugli ultimi 5 tuoi messaggi: aprire altre chat in Teams le segnerebbe come lette. Alla prima apertura di un gruppo arriva in pochi secondi per messaggio. |
| Latenza | Messaggi nuovi ogni 3-4 s, azioni confermate in 3-10 s, feed Attività ogni pochi minuti. |
| Lingua | Teams web va lasciato in inglese: alcuni testi letti dall'agent (stato dei messaggi, titoli del feed, sessione scaduta) sono in inglese. |
| Interfaccia di Teams | Se Microsoft cambia i [selettori](/riferimento/selettori), le funzioni coinvolte smettono di funzionare finché non si aggiornano. |
| Bot senza anteprima | Il rilevamento dei messaggi nuovi si basa sull'anteprima: i bot che non la mostrano possono sfuggire. |
| iPhone | Le push arrivano solo all'app installata sulla Home. |
| Massimo 4 account | Fino a 4 account Teams contemporanei per installazione. |
