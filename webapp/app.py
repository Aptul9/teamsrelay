import os, re, sqlite3, secrets, time, hmac, hashlib, base64, json
from contextlib import closing
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn

DB_PATH     = os.environ.get("DB_PATH", "/data/messages.db")
UI_USER     = os.environ.get("UI_USER", "")
UI_PASS     = os.environ.get("UI_PASS", "")
# NO_AUTH=1 solo per il test locale (compose.local.yml): la web app ascolta su 127.0.0.1 e non chiede login.
NO_AUTH     = os.environ.get("NO_AUTH", "0") == "1"
if not NO_AUTH and (not UI_USER or not UI_PASS):
    raise SystemExit("UI_USER e UI_PASS sono obbligatori: impostali nel file .env")
# URL del desktop remoto (tab "Desktop"). Se esiste data/desktop_url.txt (scritto dal tunnel) ha la precedenza.
DESKTOP_URL = os.environ.get("DESKTOP_URL", "")
DESKTOP_URL_FILE = os.path.join(os.path.dirname(DB_PATH), "desktop_url.txt")
VAPID_APPKEY_FILE = os.environ.get("VAPID_APPKEY", "/vapid/appkey.txt")
HERE        = os.path.dirname(os.path.abspath(__file__))
# Chiave che firma il cookie di sessione: cambiarla disconnette tutti i dispositivi.
# Se SESSION_SECRET e' vuota viene derivata da UI_USER/UI_PASS (allora basta cambiare la password).
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

def dbc():
    c = sqlite3.connect(DB_PATH, timeout=8); c.row_factory = sqlite3.Row; return c
def q(sql, args=()):
    try:
        with closing(dbc()) as c: return [dict(r) for r in c.execute(sql, args).fetchall()]
    except Exception: return []
def ex(sql, args=()):
    try:
        with closing(dbc()) as c: c.execute(sql, args); c.commit()
    except Exception as e: print("ex:", e, flush=True)

try:
    with closing(dbc()) as c:
        c.execute("CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, sub TEXT)"); c.commit()
except Exception: pass

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
@app.post("/api/login")
def login(r: LoginReq):
    if secrets.compare_digest(r.user, UI_USER) and secrets.compare_digest(r.password, UI_PASS):
        return set_sess(JSONResponse({"ok": True}))
    raise HTTPException(401, detail="Credenziali errate")

# ---- root: app o login ----
def desktop_url():
    try:
        u = open(DESKTOP_URL_FILE).read().strip()
        if u.startswith("http"): return u
    except Exception:
        pass
    return DESKTOP_URL

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    if not authed(request):
        r = HTMLResponse(open(os.path.join(HERE, "login.html"), encoding="utf-8").read())
        r.headers["Cache-Control"] = "no-store"; return r
    html = open(os.path.join(HERE, "index.html"), encoding="utf-8").read().replace("__DESKTOP_URL__", desktop_url())
    return set_sess(HTMLResponse(html))

# ---- api (auth) ----
@app.get("/api/feed")
def feed(request: Request):
    check(request); return JSONResponse(q("SELECT id,ts,title,body FROM messages ORDER BY id DESC LIMIT 150"))
@app.get("/api/chats")
def chats(request: Request):
    check(request); return JSONResponse(q("SELECT name,preview,tm,unread,mention FROM chats ORDER BY pos"))
@app.get("/api/messages")
def messages(request: Request, name: str):
    check(request)
    rows = q("SELECT mid,author,text,mine,reacts,extra FROM chat_messages WHERE chat=? ORDER BY idx", (name,))
    for r in rows:
        try: r.update(json.loads(r.pop("extra") or "{}"))
        except Exception: pass
    return JSONResponse(rows)

# immagini delle chat, scaricate dall'agent in data/media
MEDIA_DIR = os.path.join(os.path.dirname(DB_PATH), "media")
@app.get("/media/{fn}")
def media(request: Request, fn: str):
    check(request)
    if not re.fullmatch(r"[0-9a-f]{16}\.(png|jpg|gif|webp)", fn): raise HTTPException(404)
    path = os.path.join(MEDIA_DIR, fn)
    if not os.path.exists(path): raise HTTPException(404)
    return FileResponse(path, headers={"Cache-Control": "private, max-age=31536000, immutable"})

class OpenReq(BaseModel):
    name: str
@app.post("/api/open")
def openc(request: Request, r: OpenReq):
    check(request); ex("INSERT INTO commands(ts,type,arg1) VALUES(?,?,?)", (int(time.time()), "open", r.name)); return {"ok": True}

class SendReq(BaseModel):
    name: str
    text: str
@app.post("/api/send")
def send(request: Request, r: SendReq):
    check(request); ex("INSERT INTO commands(ts,type,arg1,arg2) VALUES(?,?,?,?)", (int(time.time()), "send", r.name, r.text)); return {"ok": True}

@app.post("/api/push/subscribe")
async def push_sub(request: Request):
    check(request)
    sub = await request.json()
    ex("INSERT OR REPLACE INTO push_subs(endpoint,sub) VALUES(?,?)", (sub.get("endpoint", ""), json.dumps(sub)))
    return {"ok": True}

@app.get("/api/health")
def health(request: Request):
    check(request)
    rows = q("SELECT v FROM state WHERE k='health'")
    try: h = json.loads(rows[0]["v"]) if rows else {}
    except Exception: h = {}
    # L'agent riscrive lo stato ogni ~5 s. Se e' fermo da oltre un minuto (agent bloccato o browser giu')
    # lo stato salvato non e' piu' vero: non va mostrato come "tutto ok".
    try: age = time.time() - float(h.get("ts") or 0)
    except Exception: age = 1e9
    h["agent"] = "ok" if age < 60 else "stale"
    if h["agent"] != "ok":
        h.update(teams="unknown", watcher="stale", overall="red")
    h.setdefault("overall", "yellow")
    return JSONResponse(h)

@app.post("/api/resync")
def resync(request: Request):
    check(request); ex("INSERT INTO commands(ts,type) VALUES(?,?)", (int(time.time()), "resync")); return {"ok": True}
@app.post("/api/recheck")
def recheck(request: Request):
    check(request); ex("INSERT INTO commands(ts,type) VALUES(?,?)", (int(time.time()), "recheck")); return {"ok": True}

def command(ctype, arg1="", arg2=""):
    """Accoda un comando per l'agent e ne ritorna l'id, per seguirne l'esito."""
    try:
        with closing(dbc()) as c:
            cur = c.execute("INSERT INTO commands(ts,type,arg1,arg2) VALUES(?,?,?,?)", (int(time.time()), ctype, arg1, arg2)); c.commit()
            return cur.lastrowid
    except Exception as e:
        print("command:", e, flush=True); raise HTTPException(500)

class ReactReq(BaseModel):
    name: str
    mid: str
    emoji: str
@app.post("/api/react")
def react_api(request: Request, r: ReactReq):
    check(request)
    if r.emoji not in REACTIONS:
        raise HTTPException(400, detail="Reazione non supportata")
    return {"ok": True, "id": command("react", r.name, json.dumps({"mid": r.mid, "emoji": r.emoji}))}

class EditReq(BaseModel):
    name: str
    mid: str
    text: str
@app.post("/api/edit")
def edit_api(request: Request, r: EditReq):
    check(request)
    if not r.text.strip(): raise HTTPException(400, detail="Testo vuoto")
    return {"ok": True, "id": command("edit", r.name, json.dumps({"mid": r.mid, "text": r.text}))}

class ReadByReq(BaseModel):
    name: str
    mid: str
@app.post("/api/readby")
def readby_api(request: Request, r: ReadByReq):
    check(request)
    return {"ok": True, "id": command("readby", r.name, json.dumps({"mid": r.mid}))}

class DownloadReq(BaseModel):
    url: str
    name: str
@app.post("/api/download")
def download_api(request: Request, r: DownloadReq):
    check(request)
    # solo allegati SharePoint/OneDrive: l'agent li scarica con la sessione Teams dell'utente
    if not re.fullmatch(r"https://[a-z0-9-]+\.sharepoint\.com/\S+", r.url): raise HTTPException(400, detail="Link non supportato")
    return {"ok": True, "id": command("download", r.url, json.dumps({"name": r.name}))}

FILES_DIR = os.path.join(os.path.dirname(DB_PATH), "files")
@app.get("/files/{fn}")
def files(request: Request, fn: str, name: str = "file"):
    check(request)
    if not re.fullmatch(r"[0-9a-f]{16}(\.[a-z0-9]{1,8})?", fn): raise HTTPException(404)
    path = os.path.join(FILES_DIR, fn)
    if not os.path.exists(path): raise HTTPException(404)
    safe = re.sub(r'[\\/:*?"<>|\r\n]+', "_", name)[:150] or "file"
    return FileResponse(path, filename=safe)

@app.get("/api/cmd/{cid}")
def cmd_status(request: Request, cid: int):
    check(request)
    rows = q("SELECT status FROM commands WHERE id=?", (cid,))
    if not rows: raise HTTPException(404)
    res = q("SELECT v FROM state WHERE k=?", (f"cmd_result:{cid}",))
    try: result = json.loads(res[0]["v"]) if res else None
    except Exception: result = None
    return {"status": rows[0]["status"], "result": result}

@app.get("/healthz")
def healthz(): return {"ok": True}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8090)
