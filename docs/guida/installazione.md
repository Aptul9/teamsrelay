# Installazione

Installazione manuale su un server. Per gli aggiornamenti successivi conviene il [deploy automatico](/guida/deploy), che parte da questo stesso setup.

## Requisiti

- Server Linux x86_64 o ARM64 con almeno 2 GB di RAM liberi. Testato su Oracle Cloud Always Free, Ampere A1, Ubuntu 24.04.
- Docker con il plugin Compose.
- Un nome DNS che punti al server. Un dominio tuo va bene; senza dominio si può usare `sslip.io` (vedi il passo 3).
- Porte TCP 80 e 443 raggiungibili da Internet, necessarie per il certificato e per il telefono.
- Un account Teams che funziona dal browser.
- Sul telefono: iPhone con iOS 16.4 o successivo per le push, oppure Android.

## 1. Server

Docker, se manca:

```bash
sudo apt update && sudo apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER      # poi esci e rientra
```

Porte 80 e 443. Sulle VM Oracle Cloud i livelli sono due:

1. **Security list** della subnet (console OCI, *Networking → VCN → Security Lists → Ingress Rules*): TCP 80 e TCP 443 da `0.0.0.0/0`.
2. **iptables** della VM, che termina con una regola `REJECT`: le nuove regole vanno prima di quella.

```bash
for p in 80 443; do
  sudo iptables -I INPUT "$(sudo iptables -L INPUT --line-numbers -n | awk '/REJECT/{print $1; exit}')" \
    -p tcp --dport $p -m state --state NEW -j ACCEPT
done
sudo netfilter-persistent save
```

## 2. Codice

```bash
sudo mkdir -p /opt/teamsrelay && sudo chown $USER: /opt/teamsrelay
git clone <url-del-repository> /opt/teamsrelay
cd /opt/teamsrelay
```

Il percorso `/opt/teamsrelay` è quello usato dal deploy automatico e dal servizio del tunnel desktop.

## 3. Dominio

Con un dominio tuo: record **A** verso l'IP pubblico del server.

```bash
dig +short teams.example.com      # deve restituire l'IP del server
```

Senza dominio: `sslip.io` risolve i nomi che contengono l'IP, e Let's Encrypt rilascia il certificato normalmente. Per l'IP `84.8.248.192` il nome è `84-8-248-192.sslip.io`, senza configurare nulla.

## 4. Configurazione

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 32               # da mettere in SESSION_SECRET
nano .env
```

Obbligatori in produzione: `DOMAIN`, `UI_USER`, `UI_PASS`, `DESKTOP_USER`, `DESKTOP_PASS`. Tutte le voci: [Configurazione](/guida/configurazione). Senza `UI_USER` e `UI_PASS` la web app non si avvia.

## 5. Chiavi per le notifiche push

```bash
docker run --rm -v "$PWD:/w" -w /w python:3.12-slim \
  sh -c "pip install -q cryptography && python tools/gen_vapid.py vapid"
```

Crea `vapid/private_key.pem` (privata) e `vapid/appkey.txt` (pubblica). Vanno generate **una volta sola**: se cambiano, ogni telefono deve riattivare le notifiche.

## 6. Avvio

```bash
docker compose up -d --build
docker compose ps                  # quattro container in esecuzione
docker compose logs -f agent       # Ctrl+C per uscire
```

Caddy ottiene il certificato da solo. `https://<dominio>` deve mostrare la pagina di login di TeamsRelay.

## 7. Primo login a Teams

Il browser remoto ascolta solo su localhost del server. Dal PC si raggiunge con un tunnel SSH:

```bash
ssh -L 3100:localhost:3000 utente@ip-del-server
```

1. Apri `http://localhost:3100` ed entra con `DESKTOP_USER` / `DESKTOP_PASS`.
2. Nel Chromium remoto è aperto Teams: accedi con il tuo account, password e MFA.
3. Chiudi i popup di benvenuto e aspetta la lista chat.
4. Imposta la lingua di Teams su **English**: alcuni testi letti dall'agent sono in inglese e le etichette tradotte dalla web app partono da quelli.

Da qui l'agent lavora da solo. Per raggiungere il desktop anche dal telefono: [Desktop remoto](/guida/desktop-remoto).

## 8. Verifica

Apri `https://<dominio>` ed entra con `UI_USER` / `UI_PASS`. Entro un minuto:

- compare la lista chat con le foto;
- la pillola di stato in alto a destra è **verde**;
- toccandola, tutte le righe sono verdi.

Poi installa l'app: [App sul telefono](/guida/telefono).
