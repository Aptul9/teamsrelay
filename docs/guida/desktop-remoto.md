# Desktop remoto

Ogni account ha il suo Chromium remoto, raggiungibile solo se autenticato nella web app.

## Dall'app

Il desktop dell'account N è su:

```
https://<DOMAIN>/desktop/N/
```

- **Da PC**: pannello di stato (la pillola in alto a destra) → **Apri Teams remoto**, oppure l'indirizzo qui sopra.
- **Da telefono**: scheda **Desktop**. Si apre il desktop dell'account attivo.

Senza sessione valida si finisce sulla pagina di login di TeamsRelay e, dopo l'accesso, si torna al desktop. Caddy chiede alla web app (`/api/authcheck`) se il cookie di sessione è valido prima di far passare ogni richiesta verso il Chromium.

Chi entra nell'app entra anche nel desktop, cioè nella sessione Teams: per questo il login della web app ha un freno ai tentativi (pausa a ogni errore, blocco di 15 minuti dopo 10 errori dallo stesso IP) e conviene una `UI_PASS` robusta.

## Primo login e riautenticazione

1. Dall'app, toccando il nome dell'account nel pannello account, scegli **Accesso a Microsoft da fare**.
2. Si apre il desktop remoto dell'account alla pagina di login di Microsoft: accedi con password e MFA.
3. Se dopo l'accesso vedi "Chats are temporarily unavailable", aggiungi uno spazio dopo lo slash della URL e premi Invio; Teams ricaricherà.
4. Torna all'app principale. Lo stato deve diventare verde entro un minuto.

Se la sessione scade (raro, dipende dall'organizzazione), il pannello di stato mostrerà "Login scaduto" e una push di avviso: ripeti i passi qui sopra.
