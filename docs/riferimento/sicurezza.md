# Sicurezza

- **Credenziali**: `UI_PASS` e `DESKTOP_PASS` robuste, `SESSION_SECRET` impostata. In produzione la web app non si avvia senza credenziali.
- **Mai pubblicare** `.env`, `config/`, `data/`, `vapid/`. Sono in `.gitignore` e il deploy automatico non li copia né li tocca.
- **`config/` è la sessione Teams**: chi ha quella cartella entra nel tuo account.
- **Desktop remoto** legato a `127.0.0.1`. Si espone solo tramite tunnel SSH, tunnel Cloudflare o sottodominio, sempre con password; lo script del tunnel Cloudflare non parte senza `DESKTOP_PASS`.
- **HTTPS obbligatorio**: il cookie è `Secure` e `HttpOnly`. Per revocare tutti gli accessi si cambia `SESSION_SECRET` (o `UI_PASS` se `SESSION_SECRET` è vuota) e si esegue `docker compose up -d`.
- **Contenuto dei messaggi**: l'HTML mostrato nella web app è ricostruito dall'agent con un insieme ridotto di tag, colori validati e link solo http(s); il testo è sempre escapato.
- **Download**: la web app accetta solo link `https://*.sharepoint.com` e serve i file solo a utenti autenticati; i nomi dei file su disco sono hash.
- **Deploy**: chiave SSH dedicata a un utente senza password, host key fissata nei secrets, nessun `StrictHostKeyChecking=no`.
- **Aggiornamenti**: tenere aggiornati il server e l'immagine `chromium`.
