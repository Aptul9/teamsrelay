# Manutenzione e problemi

## Comandi utili

```bash
cd /opt/teamsrelay
docker compose ps                      # stato dei container
docker compose logs -f agent           # NEWMSG, CMD, errori
docker compose logs -f webapp
docker compose restart agent webapp
```

## Stato rosso "Login scaduto"

Il caso più frequente. Il conditional access invalida la sessione e Teams mostra *"Chats are temporarily unavailable"* o *"We need you to sign in again"*: non sincronizza più e la lista resta ferma.

1. Apri il [desktop remoto](/guida/desktop-remoto): pannello di stato → **Apri Teams remoto**, oppure `https://<DOMAIN>/desktop/`.
2. In Teams clicca **Sign in** o ricarica la pagina, e accedi di nuovo con MFA.
3. Entro un minuto lo stato torna verde.

TeamsRelay manda una push quando succede. La frequenza dipende dalla durata di sessione decisa dall'organizzazione.

## Le notifiche non arrivano

1. Pannello di stato:
   - *Teams: Login scaduto*: rifai il login.
   - *Motore browser: Non risponde*: `docker compose logs --tail 50 agent`, poi `docker compose restart chromium agent`.
   - *Rilevamento nuovi messaggi: Fermo*: `docker compose restart agent`.
   - *Notifiche push: 0 dispositivi*: riattiva le notifiche dall'app installata.
2. La chat è silenziata? Le chat silenziate non notificano, come in Teams.
3. iPhone: l'app va aperta dall'icona sulla Home. Controlla *Impostazioni → Notifiche → TeamsRelay* e le modalità Full immersion.
4. Chiavi VAPID rigenerate: ogni dispositivo deve riattivare le notifiche.
5. **Riverifica** nel pannello manda una push di prova.

## Una reazione o una modifica non arriva su Teams

L'app mostra *non applicata su Teams* quando l'agent non vede il cambio sulla pagina entro qualche secondo. Cause tipiche: sessione scaduta, oppure qualcuno sta usando il desktop remoto e ha aperto un menu o una finestra. L'agent chiude menu e finestre rimasti aperti prima di ogni azione; se il problema resta, guarda `docker compose logs agent` alle righe `react:`, `edit:`, `reply:`, `delete:`.

## La lista chat è vuota o vecchia

Pull-to-refresh o **Risincronizza**. Se resta ferma a una data vecchia è quasi sempre il login scaduto. L'agent ricostruisce la lista completa scorrendola ogni pochi minuti, e i riavvii non la svuotano.

## Teams si è ricaricato da solo

Teams web ricarica la pagina di tanto in tanto. L'agent si ricollega, riapre la chat che stavi usando e, se non vede più la scheda di Teams per 60 secondi, si riavvia da solo (Docker lo rimette su).

## Aggiornare

Con il [deploy automatico](/guida/deploy) basta un push su `main`. A mano:

```bash
cd /opt/teamsrelay
git pull
docker compose up -d --build
docker compose pull chromium && docker compose up -d chromium    # aggiorna il browser, la sessione resta in config/
```

## Backup

Da salvare: `.env`, `vapid/` (chiavi push), `config/` (sessione Teams, dato **sensibile**) e, se serve, `data/` (database, immagini e file scaricati).

## Porta 443 condivisa con OpenVPN (sslh)

Se sulla 443 c'è già OpenVPN, [sslh](https://github.com/yrutschle/sslh) smista il traffico: HTTPS a Caddy, OpenVPN al VPN.

1. OpenVPN in ascolto TCP su `127.0.0.1:1443`.
2. Nel `.env`: `HTTPS_PORT=8443` e `HTTPS_BIND=127.0.0.1`, poi `docker compose up -d`.
3. sslh:

```bash
sudo apt install -y sslh
sudo cp deploy/sslh.default.example /etc/default/sslh
sudo systemctl restart sslh && sudo systemctl enable sslh
```

In questa modalità il sito va aperto sempre con `https://`: il redirect da `http://` includerebbe la porta 8443.

## Disinstallare

```bash
cd /opt/teamsrelay && docker compose down -v
sudo systemctl disable --now teamsrelay-desktop 2>/dev/null
sudo rm -rf /opt/teamsrelay /etc/systemd/system/teamsrelay-desktop.service
```
