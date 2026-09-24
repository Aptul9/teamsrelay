# Sicurezza

- **Credenziali**: `UI_PASS` robusta (protegge l'accesso alla web app e al desktop remoto di tutti gli account), `SESSION_SECRET` impostata. In produzione la web app non si avvia senza credenziali.
- **Mai pubblicare** `.env`, `config/`, `data/`, `vapid/`. Sono in `.gitignore` e il deploy automatico non li copia né li tocca.
- **`config/N/` è la sessione Teams dell'account N**: chi ha quella cartella entra nell'account con quell'accesso Microsoft. Proteggere tutto `config/` è **critico**: il backup va crittato.
- **Desktop remoto**: ogni account ha il suo desktop su `/desktop/N/`, dietro il login della web app (Caddy `forward_auth` su `/api/authcheck`); la porta 3000 di Chromium resta legata a `127.0.0.1`. Chi ha le credenziali dell'app controlla tutte le sessioni Teams: `UI_PASS` va scelta robusta. Il login ha una pausa a ogni errore e blocca un IP per 15 minuti dopo 10 errori.
- **dockerproxy**: la web app accede a Docker solo tramite un proxy che nega tutto tranne start/stop di container esistenti. Creare container, eseguire comandi, leggere configurazioni, listare, ispezionare: tutto 403 (Forbidden). I browser non possono raggiungerlo (rete interna). Il proxy non distingue i container: chi controllasse la web app potrebbe avviare o fermare anche altri container dello stesso host, ma non crearne, modificarli o leggerne i dati.
- **HTTPS obbligatorio**: il cookie è `Secure` e `HttpOnly`. Per revocare tutti gli accessi si cambia `SESSION_SECRET` (o `UI_PASS` se `SESSION_SECRET` è vuota) e si esegue `docker compose up -d`.
- **Contenuto dei messaggi**: l'HTML mostrato nella web app è ricostruito dall'agent con un insieme ridotto di tag, colori validati e link solo http(s); il testo è sempre escapato.
- **Download**: la web app accetta solo link `https://*.sharepoint.com` e serve i file solo a utenti autenticati; i nomi dei file su disco sono hash.
- **Deploy**: chiave SSH dedicata a un utente senza password, host key fissata nei secrets, nessun `StrictHostKeyChecking=no`.
- **Aggiornamenti**: tenere aggiornati il server e l'immagine `chromium`.
