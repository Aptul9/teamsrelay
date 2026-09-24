import os, re, sqlite3, secrets, time, hmac, hashlib, base64, json, shutil, threading, urllib.request, urllib.error
from contextlib import closing
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn

# Database dell'app (account, dispositivi per le push). Ogni account Teams ha poi il suo database,
# scritto dal suo agent: <DATA_DIR>/<slot>/messages.db, con media/ e files/ accanto.
APP_DB      = os.environ.get("APP_DB", "/data/app.db")
DATA_DIR    = os.path.dirname(APP_DB)
# profili dei browser, uno per slot: si svuota quello di un account rimosso
CONFIG_DIR  = os.environ.get("CONFIG_DIR", "/config")
# Docker (tramite dockerproxy) serve solo ad accendere e spegnere gli slot
DOCKER_API  = os.environ.get("DOCKER_API", "")
SLOTS       = (1, 2, 3, 4)
UI_USER     = os.environ.get("UI_USER", "")
UI_PASS     = os.environ.get("UI_PASS", "")
# NO_AUTH=1 solo per il test locale (compose.local.yml): la web app ascolta su 127.0.0.1 e non chiede login.
NO_AUTH     = os.environ.get("NO_AUTH", "0") == "1"
if not NO_AUTH and (not UI_USER or not UI_PASS):
    raise SystemExit("UI_USER e UI_PASS sono obbligatori: impostali nel file .env")
# Desktop remoto di ogni account; {n} è lo slot
DESKTOP_URL = os.environ.get("DESKTOP_URL", "") or "/desktop/{n}/"
VAPID_APPKEY_FILE = os.environ.get("VAPID_APPKEY", "/vapid/appkey.txt")
HERE        = os.path.dirname(os.path.abspath(__file__))
# Chiave che firma il cookie di sessione: cambiarla disconnette tutti i dispositivi.
# Se SESSION_SECRET è vuota viene derivata da UI_USER/UI_PASS (allora basta cambiare la password).
SECRET      = os.environ.get("SESSION_SECRET") or hashlib.sha256(f"{UI_USER}:{UI_PASS}:teamsrelay".encode()).hexdigest()
COOKIE_MAXAGE = 60 * 60 * 24 * 365  # 1 anno
REACTIONS   = {"like", "heart", "laugh", "surprised", "cry", "angry"}

def _tok():
    return hmac.new(SECRET.encode(), b"sess", hashlib.sha256).hexdigest()

def authed(request: Request) -> bool:
    if NO_AUTH:
        return True
    ck = request.cookies.get("sess")
    if ck and hmac.compare_digest(ck, _tok()):
        return True
    hdr = request.headers.get("authorization", "")
    if hdr.lower().startswith("basic "):
        try:
            u, p = base64.b64decode(hdr.split(" ", 1)[1]).decode("utf-8").split(":", 1)
            if secrets.compare_digest(u, UI_USER) and secrets.compare_digest(p, UI_PASS):
                return True
        except Exception:
            pass
    return False

def check(request: Request):
    if not authed(request):
        raise HTTPException(401, headers={"WWW-Authenticate": "Basic"})
    return True

def set_sess(resp):
    resp.set_cookie("sess", _tok(), httponly=True, secure=True, samesite="lax", max_age=COOKIE_MAXAGE)
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return resp

app = FastAPI()
app.mount("/static", StaticFiles(directory=os.path.join(HERE, "static")), name="static")

# ---- database: quello dell'app e quelli degli account ----
def acc_dir(n): return os.path.join(DATA_DIR, str(n))
def acc_db(n): return os.path.join(acc_dir(n), "messages.db")

def dbc(path=APP_DB, create=False):
    # il database di un account lo crea il suo agent: aprirlo non deve creare un file vuoto
    c = sqlite3.connect(path if create else f"file:{path}?mode=rw", timeout=8, uri=not create); c.row_factory = sqlite3.Row; return c
def q(n, sql, args=()):
    try:
        with closing(dbc(acc_db(n))) as c: return [dict(r) for r in c.execute(sql, args).fetchall()]
    except Exception: return []
def aq(sql, args=()):
    try:
        with closing(dbc(create=True)) as c: return [dict(r) for r in c.execute(sql, args).fetchall()]
    except Exception as e: print("aq:", e, flush=True); return []
def aex(sql, args=()):
    with closing(dbc(create=True)) as c: c.execute(sql, args); c.commit()

def state(n, k):
    rows = q(n, "SELECT v FROM state WHERE k=?", (k,))
    try: return json.loads(rows[0]["v"]) if rows else {}
    except Exception: return {}

def migrate_layout():
    """Dal vecchio layout a un solo account (data/messages.db, data/media, data/files) allo slot 1.
    Sul server lo fa già deploy/remote-deploy.sh a container fermi; qui copre l'avvio locale."""
    old = os.path.join(DATA_DIR, "messages.db")
    if not os.path.exists(old) or os.path.exists(acc_db(1)): return
    os.makedirs(acc_dir(1), exist_ok=True)
    for f in ("messages.db", "messages.db-wal", "messages.db-shm", "media", "files"):
        src = os.path.join(DATA_DIR, f)
        if os.path.exists(src): shutil.move(src, os.path.join(acc_dir(1), f))
    print("layout: dati spostati nello slot 1", flush=True)

def app_init():
    migrate_layout()
    with closing(dbc(create=True)) as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("CREATE TABLE IF NOT EXISTS accounts(slot INTEGER PRIMARY KEY, added INTEGER)")
        c.execute("CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, sub TEXT)")
        # primo avvio con gli account: gli slot che hanno già dati diventano account, e i dispositivi
        # registrati per le push passano dal database dell'account a quello dell'app
        if c.execute("PRAGMA user_version").fetchone()[0] == 0:
            for n in SLOTS:
                if not os.path.exists(acc_db(n)): continue
                c.execute("INSERT OR IGNORE INTO accounts(slot,added) VALUES(?,?)", (n, int(time.time())))
                for r in q(n, "SELECT endpoint,sub FROM push_subs"):
                    c.execute("INSERT OR IGNORE INTO push_subs(endpoint,sub) VALUES(?,?)", (r["endpoint"], r["sub"]))
            c.execute("PRAGMA user_version=1")
        c.commit()
app_init()

def accounts():
    return [r["slot"] for r in aq("SELECT slot FROM accounts ORDER BY slot")]

def account(request: Request) -> int:
    """Lo slot su cui lavora la richiesta: parametro a=N, che deve essere un account esistente."""
    check(request)
    ids = accounts()
    a = request.query_params.get("a", "")
    if not a and ids: return ids[0]
    try: n = int(a)
    except ValueError: n = 0
    if n not in ids: raise HTTPException(404, detail="Account non trovato")
    return n

# ---- slot: accensione e spegnimento dei container ----
def docker(action, name):
    if not DOCKER_API: raise HTTPException(503, detail="Controllo di Docker non configurato (DOCKER_API)")
    url = f"{DOCKER_API}/containers/{name}/{action}" + ("?t=10" if action == "stop" else "")
    try:
        urllib.request.urlopen(urllib.request.Request(url, data=b"", method="POST"), timeout=40)
    except urllib.error.HTTPError as e:
        if e.code == 304: return                       # già acceso / già spento
        if e.code == 404: raise HTTPException(503, detail=f"Container {name} non creato: rifai il deploy")
        raise HTTPException(502, detail=f"Docker: {action} {name} non riuscito ({e.code})")
    except Exception as e:
        raise HTTPException(502, detail=f"Docker non raggiungibile: {e}")

def slot_up(n):
    # l'agent usa la rete del suo Chromium: prima il browser
    docker("start", f"teams-chromium-{n}"); docker("start", f"teams-agent-{n}")
def slot_down(n):
    docker("stop", f"teams-agent-{n}"); docker("stop", f"teams-chromium-{n}")

def wipe(n):
    """Cancella profilo del browser (la sessione Teams) e dati dello slot."""
    cfg = os.path.join(CONFIG_DIR, str(n))
    if os.path.isdir(cfg):
        for e in os.listdir(cfg):
            p = os.path.join(cfg, e)
            shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) and not os.path.islink(p) else os.remove(p)
    shutil.rmtree(acc_dir(n), ignore_errors=True)

ACC_LOCK = threading.Lock()

def keep_slots_up():
    # Gli account esistenti devono avere il loro slot acceso: dopo un deploy che ricrea un container,
    # dopo un riavvio del server o se qualcuno lo ha fermato a mano. Avviare uno slot acceso non fa nulla.
    while True:
        for n in SLOTS:
            # sotto lo stesso lock di aggiunta e rimozione: uno slot appena spento non si riaccende
            with ACC_LOCK:
                if n not in accounts(): continue
                try: slot_up(n)
                except HTTPException as e: print(f"slot {n}:", e.detail, flush=True)
        time.sleep(60)
if DOCKER_API: threading.Thread(target=keep_slots_up, daemon=True).start()

# ---- public: SW, manifest, vapid key, login ----
@app.get("/sw.js")
def sw():
    return FileResponse(os.path.join(HERE, "static", "sw.js"), media_type="application/javascript")
@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(os.path.join(HERE, "static", "manifest.webmanifest"), media_type="application/manifest+json")
@app.get("/api/vapidkey")
def vapidkey():
    try: k = open(VAPID_APPKEY_FILE).read().strip()
    except Exception: k = ""
    return {"key": k}

class LoginReq(BaseModel):
    user: str
    password: str
# Il login protegge anche il desktop remoto, cioè la sessione Teams: pausa a ogni errore e blocco per IP
LOGIN_FAILS = {}           # ip -> [tentativi falliti, primo fallimento]
LOGIN_MAX, LOGIN_WINDOW = 10, 900
def client_ip(request: Request):
    return (request.headers.get("x-forwarded-for", "").split(",")[0].strip()) or (request.client.host if request.client else "?")
@app.post("/api/login")
def login(r: LoginReq, request: Request):
    ip, now = client_ip(request), time.time()
    n, first = LOGIN_FAILS.get(ip, (0, now))
    if now - first > LOGIN_WINDOW: n, first = 0, now
    if n >= LOGIN_MAX:
        raise HTTPException(429, detail="Troppi tentativi, riprova fra qualche minuto")
    if secrets.compare_digest(r.user, UI_USER) and secrets.compare_digest(r.password, UI_PASS):
        LOGIN_FAILS.pop(ip, None)
        return set_sess(JSONResponse({"ok": True}))
    LOGIN_FAILS[ip] = (n + 1, first)
    time.sleep(1.5)
    raise HTTPException(401, detail="Credenziali errate")

@app.get("/api/authcheck")
def authcheck(request: Request):
    """Usata da Caddy (forward_auth) per il desktop remoto: 200 se la sessione è valida, altrimenti al login."""
    if authed(request): return {"ok": True}
    nxt = request.headers.get("x-forwarded-uri", "/")
    if not nxt.startswith("/") or nxt.startswith("//"): nxt = "/"
    from urllib.parse import quote
    return Response(status_code=302, headers={"Location": "/?next=" + quote(nxt)})

# ---- root: app o login ----
@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    if not authed(request):
        r = HTMLResponse(open(os.path.join(HERE, "login.html"), encoding="utf-8").read())
        r.headers["Cache-Control"] = "no-store"; return r
    html = open(os.path.join(HERE, "index.html"), encoding="utf-8").read().replace("__DESKTOP_URL__", DESKTOP_URL)
    return set_sess(HTMLResponse(html))

# ---- account ----
def health_of(n, added=0):
    h = state(n, "health")
    # L'agent riscrive lo stato ogni ~5 s. Se è fermo da oltre un minuto (agent bloccato o browser giù)
    # lo stato salvato non è più vero: non va mostrato come "tutto ok".
    try: age = time.time() - float(h.get("ts") or 0)
    except Exception: age = 1e9
    h["agent"] = "ok" if age < 60 else "stale"
    if h["agent"] != "ok":
        # slot appena acceso: browser e agent impiegano fino a un paio di minuti a partire
        starting = time.time() - (added or 0) < 180
        h.update(teams="starting" if starting else "unknown", watcher="stale", overall="yellow" if starting else "red")
    h.setdefault("overall", "yellow")
    h["push_subs"] = (aq("SELECT COUNT(*) AS n FROM push_subs") or [{"n": 0}])[0]["n"]
    return h

@app.get("/api/accounts")
def list_accounts(request: Request):
    check(request)
    out = []
    for r in aq("SELECT slot,added FROM accounts ORDER BY slot"):
        n = r["slot"]; me = state(n, "me"); h = health_of(n, r["added"])
        unread = q(n, "SELECT COUNT(*) AS c FROM chats WHERE unread=1 AND COALESCE(muted,0)=0 AND name NOT LIKE '%(You)%'")
        out.append({"slot": n, "name": me.get("name", ""), "email": me.get("email", ""), "tenant": me.get("tenant", ""),
                    "av": me.get("av", ""), "teams": h.get("teams", ""), "overall": h.get("overall", ""),
                    "unread": unread[0]["c"] if unread else 0, "desktop": DESKTOP_URL.replace("{n}", str(n))})
    return {"accounts": out, "max": len(SLOTS)}

@app.post("/api/accounts")
def add_account(request: Request):
    """Nuovo account: prende il primo slot libero, lo parte pulito e ne accende browser e agent.
    Il login a Microsoft si fa poi dal desktop remoto dello slot."""
    check(request)
    with ACC_LOCK:
        free = [n for n in SLOTS if n not in accounts()]
        if not free: raise HTTPException(409, detail=f"Al massimo {len(SLOTS)} account")
        n = free[0]
        try: slot_down(n)
        except HTTPException: pass
        wipe(n)
        aex("INSERT INTO accounts(slot,added) VALUES(?,?)", (n, int(time.time())))
        try: slot_up(n)
        except HTTPException:
            aex("DELETE FROM accounts WHERE slot=?", (n,)); raise
    return {"ok": True, "slot": n, "desktop": DESKTOP_URL.replace("{n}", str(n))}

@app.delete("/api/accounts/{n}")
def remove_account(request: Request, n: int):
    """Come "Esci" in Teams: spegne lo slot e cancella sessione e dati di quell'account."""
    check(request)
    if n not in accounts(): raise HTTPException(404, detail="Account non trovato")
    with ACC_LOCK:
        slot_down(n)
        wipe(n)
        aex("DELETE FROM accounts WHERE slot=?", (n,))
    return {"ok": True}

# ---- api dell'account (a=N) ----
@app.get("/api/feed")
def feed(request: Request):
    n = account(request); return JSONResponse(q(n, "SELECT id,ts,title,body FROM messages ORDER BY id DESC LIMIT 150"))
@app.get("/api/activity")
def activity(request: Request):
    n = account(request)
    ts = q(n, "SELECT v FROM state WHERE k='activity_ts'")
    return {"ts": int(ts[0]["v"]) if ts else 0,
            "items": q(n, "SELECT id,kind,actor,title,emoji,preview,tm,chat,channel,unread,av FROM activity ORDER BY pos")}
@app.post("/api/activity/refresh")
def activity_refresh(request: Request):
    n = account(request); return {"ok": True, "id": command(n, "activity")}
@app.get("/api/chats")
def chats(request: Request):
    n = account(request); return JSONResponse(q(n, "SELECT name,preview,tm,unread,mention,muted,av FROM chats ORDER BY pos"))
@app.get("/api/messages")
def messages(request: Request, name: str):
    n = account(request)
    rows = q(n, "SELECT mid,author,text,mine,reacts,extra FROM chat_messages WHERE chat=? ORDER BY idx", (name,))
    for r in rows:
        try: r.update(json.loads(r.pop("extra") or "{}"))
        except Exception: pass
    return JSONResponse(rows)

# immagini delle chat, scaricate dall'agent in data/<slot>/media
@app.get("/media/{fn}")
def media(request: Request, fn: str):
    n = account(request)
    if not re.fullmatch(r"[0-9a-f]{16}\.(png|jpg|gif|webp)", fn): raise HTTPException(404)
    path = os.path.join(acc_dir(n), "media", fn)
    if not os.path.exists(path): raise HTTPException(404)
    return FileResponse(path, headers={"Cache-Control": "private, max-age=31536000, immutable"})

class OpenReq(BaseModel):
    name: str
@app.post("/api/open")
def openc(request: Request, r: OpenReq):
    n = account(request); command(n, "open", r.name); return {"ok": True}

class SendReq(BaseModel):
    name: str
    text: str
@app.post("/api/send")
def send(request: Request, r: SendReq):
    n = account(request); command(n, "send", r.name, r.text); return {"ok": True}

@app.post("/api/push/subscribe")
async def push_sub(request: Request):
    # un dispositivo riceve le notifiche di tutti gli account
    check(request)
    sub = await request.json()
    aex("INSERT OR REPLACE INTO push_subs(endpoint,sub) VALUES(?,?)", (sub.get("endpoint", ""), json.dumps(sub)))
    return {"ok": True}

@app.get("/api/health")
def health(request: Request):
    n = account(request)
    added = aq("SELECT added FROM accounts WHERE slot=?", (n,))
    return JSONResponse(health_of(n, added[0]["added"] if added else 0))

@app.post("/api/resync")
def resync(request: Request):
    n = account(request); command(n, "resync"); return {"ok": True}
@app.post("/api/recheck")
def recheck(request: Request):
    n = account(request); command(n, "recheck"); return {"ok": True}

def command(n, ctype, arg1="", arg2=""):
    """Accoda un comando per l'agent dell'account e ne ritorna l'id, per seguirne l'esito."""
    try:
        with closing(dbc(acc_db(n))) as c:
            cur = c.execute("INSERT INTO commands(ts,type,arg1,arg2) VALUES(?,?,?,?)", (int(time.time()), ctype, arg1, arg2)); c.commit()
            return cur.lastrowid
    except Exception as e:
        print("command:", e, flush=True); raise HTTPException(503, detail="Account non ancora pronto")

class ReactReq(BaseModel):
    name: str
    mid: str
    emoji: str = ""
    pill: str = ""      # emoji di una reazione già presente sotto il messaggio: click sulla pill, come in Teams
@app.post("/api/react")
def react_api(request: Request, r: ReactReq):
    n = account(request)
    if r.pill:
        if len(r.pill) > 16: raise HTTPException(400, detail="Reazione non valida")
        return {"ok": True, "id": command(n, "react", r.name, json.dumps({"mid": r.mid, "pill": r.pill}))}
    if r.emoji not in REACTIONS:
        raise HTTPException(400, detail="Reazione non supportata")
    return {"ok": True, "id": command(n, "react", r.name, json.dumps({"mid": r.mid, "emoji": r.emoji}))}

class EditReq(BaseModel):
    name: str
    mid: str
    text: str
@app.post("/api/edit")
def edit_api(request: Request, r: EditReq):
    n = account(request)
    if not r.text.strip(): raise HTTPException(400, detail="Testo vuoto")
    return {"ok": True, "id": command(n, "edit", r.name, json.dumps({"mid": r.mid, "text": r.text}))}

class DownloadReq(BaseModel):
    url: str
    name: str
@app.post("/api/download")
def download_api(request: Request, r: DownloadReq):
    n = account(request)
    # solo allegati SharePoint/OneDrive: l'agent li scarica con la sessione Teams dell'utente
    if not re.fullmatch(r"https://[a-z0-9-]+\.sharepoint\.com/\S+", r.url): raise HTTPException(400, detail="Link non supportato")
    return {"ok": True, "id": command(n, "download", r.url, json.dumps({"name": r.name}))}

@app.get("/files/{fn}")
def files(request: Request, fn: str, name: str = "file"):
    n = account(request)
    if not re.fullmatch(r"[0-9a-f]{16}(\.[a-z0-9]{1,8})?", fn): raise HTTPException(404)
    path = os.path.join(acc_dir(n), "files", fn)
    if not os.path.exists(path): raise HTTPException(404)
    safe = re.sub(r'[\\/:*?"<>|\r\n]+', "_", name)[:150] or "file"
    return FileResponse(path, filename=safe)

class MsgActReq(BaseModel):
    name: str
    mid: str
    text: str = ""
@app.post("/api/reply")
def reply_api(request: Request, r: MsgActReq):
    n = account(request)
    if not r.text.strip(): raise HTTPException(400, detail="Testo vuoto")
    return {"ok": True, "id": command(n, "reply", r.name, json.dumps({"mid": r.mid, "text": r.text}))}
@app.post("/api/delete")
def delete_api(request: Request, r: MsgActReq):
    n = account(request); return {"ok": True, "id": command(n, "delete", r.name, json.dumps({"mid": r.mid}))}
@app.post("/api/undodelete")
def undodelete_api(request: Request, r: MsgActReq):
    n = account(request); return {"ok": True, "id": command(n, "undodelete", r.name, json.dumps({"mid": r.mid}))}

@app.get("/api/cmd/{cid}")
def cmd_status(request: Request, cid: int):
    n = account(request)
    rows = q(n, "SELECT status FROM commands WHERE id=?", (cid,))
    if not rows: raise HTTPException(404)
    res = q(n, "SELECT v FROM state WHERE k=?", (f"cmd_result:{cid}",))
    try: result = json.loads(res[0]["v"]) if res else None
    except Exception: result = None
    return {"status": rows[0]["status"], "result": result}

@app.get("/healthz")
def healthz(): return {"ok": True}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8090)
