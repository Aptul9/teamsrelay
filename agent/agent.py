import os, time, json, sqlite3, urllib.request, hashlib, base64
from datetime import datetime
from playwright.sync_api import sync_playwright
try:
    from pywebpush import webpush, WebPushException
except Exception:
    webpush = None

NTFY_URL   = os.environ.get("NTFY_URL", "https://ntfy.sh")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")
NTFY_ENABLED = os.environ.get("NTFY_ENABLED", "0") == "1" and bool(NTFY_TOPIC)
CDP        = os.environ.get("CDP", "http://localhost:9222")
DB_PATH    = os.environ.get("DB_PATH", "/data/messages.db")
VAPID_PRIVATE = os.environ.get("VAPID_PRIVATE", "/vapid/private_key.pem")
VAPID_CLAIMS  = {"sub": os.environ.get("VAPID_SUBJECT", "mailto:admin@example.com")}
HEALTHTAG  = "__HEALTHCHECK__"
MEDIA_DIR  = os.path.join(os.path.dirname(DB_PATH), "media")
MEDIA_EXT  = {"image/png":"png","image/jpeg":"jpg","image/gif":"gif","image/webp":"webp"}

HOOK_JS = r"""
() => {
  if (!window.__visPatched) {
    try {
      Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
      try{document.hasFocus=()=>false;}catch(e){}
      window.dispatchEvent(new Event('blur')); document.dispatchEvent(new Event('visibilitychange'));
      window.__visPatched=true;
    } catch(e){}
  }
  if (!window.__teamsHookInstalled) {
    window.__teamsMsgs = window.__teamsMsgs || [];
    const push=(t,b)=>{try{window.__teamsMsgs.push({title:String(t||''),body:String(b||'')});}catch(e){}};
    try{const ON=window.Notification;function W(t,o){push(t,o&&o.body);try{return new ON(t,o);}catch(e){return{close(){}};}}
      try{W.requestPermission=(cb)=>{const p=Promise.resolve('granted');if(cb)cb('granted');return p;};}catch(e){}
      try{Object.defineProperty(W,'permission',{get:()=>'granted'});}catch(e){} window.Notification=W;}catch(e){}
    try{if(window.ServiceWorkerRegistration&&ServiceWorkerRegistration.prototype.showNotification){
      const o=ServiceWorkerRegistration.prototype.showNotification;
      ServiceWorkerRegistration.prototype.showNotification=function(t,op){push(t,op&&op.body);return o.apply(this,arguments);};}}catch(e){}
    try{const oq=(navigator.permissions&&navigator.permissions.query)?navigator.permissions.query.bind(navigator.permissions):null;
      if(oq)navigator.permissions.query=(d)=>(d&&d.name==='notifications')?Promise.resolve({state:'granted',onchange:null}):oq(d);}catch(e){}
    window.__teamsHookInstalled=true; return 'installed';
  }
  return 'already';
}
"""
DRAIN_JS = "() => { const m=window.__teamsMsgs||[]; window.__teamsMsgs=[]; return m; }"

CHATS_JS = r"""
() => {
  const STAT=/\b(Unread|Offline|Away|Available|Busy|Do not disturb|Be right back|Presence unknown|Out of office)\b/gi;
  // Le chat sono solo i figli (aria-level 2) delle sezioni Chats e Favorites; Quick views (Mentions, Drafts) no.
  // Se una sezione è chiusa le sue chat non sono nel DOM: la riapre.
  const SECT=/^(Chats|Chat|Favorites|Preferiti)\b/i;
  const hd=s=>s.querySelector(':scope > :not([role="group"])')||s;
  const head=s=>(hd(s).innerText||'').replace(/\s+/g,' ').trim();
  for (const s of document.querySelectorAll('[role="treeitem"][aria-level="1"][aria-expanded="false"]')){
    if(SECT.test(head(s))) hd(s).click();
  }
  const tis=[...document.querySelectorAll('[role="treeitem"][aria-level="2"][id^="menu"]')].filter(e=>{
    const s=e.parentElement && e.parentElement.closest('[role="treeitem"][aria-level="1"]');
    return s && SECT.test(head(s));
  });
  const out=[]; const seen=new Set();
  for (const e of tis){
    let txt=(e.innerText||'').replace(/\s+/g,' ').trim();
    if(!txt) continue;
    if(/^(Copilot|Drafts|Quick views.*|Favorites|Chats|Meet now|Activity|Unread)$/i.test(txt)) continue;
    const unread = !!e.querySelector('[data-tid="unread"]');
    let clean=txt.replace(/^(Favorites|Chats|Quick views|Recent|Drafts)\s+/i,'').replace(STAT,'').replace(/\s+/g,' ').trim();
    const tmM = clean.match(/\d{1,2}:\d{2}\s?(AM|PM)?|\d{1,2}\/\d{1,2}/);
    const tm = tmM ? tmM[0].trim() : '';
    let name=clean.split(/\s+\d{1,2}:\d{2}|\s+\d{1,2}\/\d{1,2}|\s+You:/)[0].trim();
    if(!name) name=clean.slice(0,40);
    if(!name||seen.has(name)) continue; seen.add(name);
    let prev=clean;
    if(tm){ const i=clean.indexOf(tm); if(i>-1) prev=clean.slice(i+tm.length).trim(); }
    else { prev=clean.slice(name.length).trim(); }
    const al=(e.getAttribute('aria-label')||'');
    const mention = !!e.querySelector('[data-tid*="mention" i],[class*="mention" i]') || /mention|menzion/i.test(al);
    out.push({name:name.slice(0,60), preview:prev.slice(0,120), time:tm, unread:unread, mention:mention});
    if(out.length>=25) break;
  }
  return out;
}
"""

MSGS_JS = r"""
() => {
  const items=[...document.querySelectorAll('[data-tid="chat-pane-message"]')];
  const SKIP='[data-tid="quoted-reply-card"],[data-tid="file-attachment-grid"],[data-tid*="reaction"],[data-tid^="message-actions"]';
  const isEmoji=i=>/Emoji/i.test(i.getAttribute('itemtype')||'')||i.closest('[data-tid="emoticon-renderer"]');
  // testo del corpo: le emoji di Teams sono <img alt="😂">, innerText le perderebbe
  const walk=n=>{
    if(n.nodeType===3) return n.nodeValue;
    if(n.nodeType!==1) return '';
    if(n.matches(SKIP)) return '';
    if(n.tagName==='BR') return '\n';
    if(n.tagName==='IMG') return isEmoji(n)?(n.alt||''):'';
    let t=''; for(const c of n.childNodes) t+=walk(c);
    const d=getComputedStyle(n).display;
    return (n.tagName==='P' || /^(block|flex|grid|list-item|table)$/.test(d))?t+'\n':t;
  };
  const out=[]; let lastAuthor='';
  for (const e of items.slice(-40)){
    const mine = !!e.querySelector('.fui-ChatMyMessage') || (e.className||'').indexOf('MyMessage')>-1 || !!e.closest('.fui-ChatMyMessage');
    let author='';
    const it=e.closest('[data-tid="chat-pane-item"]')||e;
    const an=it.querySelector('[data-tid="message-author-name"]')||e.querySelector('[data-tid="message-author-name"]'); if(an) author=(an.innerText||'').trim();
    if(!author){ const al=e.getAttribute('aria-label')||''; const mm=al.match(/^([^,]+),/); if(mm) author=mm[1].trim(); }
    // Teams mostra il nome solo sul primo di più messaggi consecutivi dello stesso autore
    if(mine) lastAuthor=''; else if(author) lastAuthor=author; else author=lastAuthor;
    const bd=e.querySelector('[id^="content-"]')||e.querySelector('[data-tid="messageBodyContent"]');
    let text=bd?walk(bd).replace(/\u00a0/g,' ').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim():'';
    let quote=null; const qc=e.querySelector('[data-tid="quoted-reply-card"]');
    if(qc){ const qt=qc.querySelector('[data-tid="quoted-reply-preview-content"]');
      const lines=(qc.innerText||'').split('\n').map(x=>x.trim()).filter(Boolean);
      quote={author:(lines[0]||'').slice(0,60), text:((qt&&qt.innerText)||lines.slice(2).join(' ')).trim().slice(0,300)}; }
    const images=[...e.querySelectorAll('img')].filter(i=>!isEmoji(i) && !i.closest(SKIP) && !i.closest('[data-tid*="avatar" i]')
      && (/AMSImage/i.test(i.getAttribute('itemtype')||'') || /^lazy-image/.test(i.getAttribute('data-tid')||'') || i.naturalWidth>64))
      .map(i=>({src:i.currentSrc||i.src||'', w:i.naturalWidth, h:i.naturalHeight}));
    const files=[];
    for(const g of e.querySelectorAll('[data-tid="file-attachment-grid"]')){
      for(const x of g.querySelectorAll('[aria-label*="https://"]')){
        const [name,...rest]=(x.getAttribute('aria-label')||'').split('\n'); const url=rest.join('').trim();
        if(name && !files.some(f=>f.url===url)) files.push({name:name.trim().slice(0,160), url:url});
      }
    }
    let reacts=''; try{ const rc=[...e.querySelectorAll('[aria-label*="reaction" i]')]; reacts=rc.map(x=>(x.getAttribute('aria-label')||'').trim()).filter(Boolean).join(' | ').slice(0,160); }catch(_){}
    out.push({mid:e.getAttribute('data-mid')||'', author:author.slice(0,60), text:text.slice(0,2000), mine:!!mine, reacts:reacts, quote:quote, images:images, files:files});
  }
  return out;
}
"""

# nome della chat aperta in Teams (per non salvare i messaggi di una chat sotto il nome di un'altra)
OPEN_CHAT_JS = r"""() => { const t=document.querySelector('[data-tid="chat-title"]'); return t?(t.innerText||'').split('\n')[0].trim():''; }"""

# scarica un'immagine dalla pagina: gli URL blob: e AMS sono leggibili solo dentro la sessione Teams
FETCH_JS = r"""
async (src) => {
  const r=await fetch(src,{credentials:'include'}); if(!r.ok) return null;
  const b=await r.blob(); if(b.size>8e6) return null;
  const u=await new Promise(ok=>{const f=new FileReader(); f.onload=()=>ok(f.result); f.readAsDataURL(b);});
  return {type:b.type, data:u.split(',')[1]};
}
"""

def dbc():
    c = sqlite3.connect(DB_PATH, timeout=8); c.execute("PRAGMA journal_mode=WAL"); return c

def db_init():
    try:
        with dbc() as c:
            c.execute("CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, source TEXT, title TEXT, body TEXT)")
            c.execute("DROP TABLE IF EXISTS chats")
            c.execute("CREATE TABLE chats(name TEXT PRIMARY KEY, preview TEXT, pos INTEGER, ts INTEGER, tm TEXT, unread INTEGER, mention INTEGER)")
            c.execute("DROP TABLE IF EXISTS chat_messages")
            c.execute("CREATE TABLE chat_messages(chat TEXT, idx INTEGER, mid TEXT, author TEXT, text TEXT, mine INTEGER, reacts TEXT, extra TEXT)")
            c.execute("CREATE TABLE IF NOT EXISTS commands(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, arg1 TEXT, arg2 TEXT, status TEXT DEFAULT 'pending')")
            c.execute("CREATE TABLE IF NOT EXISTS state(k TEXT PRIMARY KEY, v TEXT)")
            c.execute("CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, sub TEXT)")
    except Exception as e: print("db_init:", e, flush=True)

def db_msg(title, body):
    try:
        with dbc() as c: c.execute("INSERT INTO messages(ts,source,title,body) VALUES(?,?,?,?)",(int(time.time()),"teams",title,body))
    except Exception as e: print("db_msg:", e, flush=True)

def save_chats(chats):
    try:
        with dbc() as c:
            c.execute("DELETE FROM chats")
            for i,ch in enumerate(chats):
                c.execute("INSERT OR REPLACE INTO chats(name,preview,pos,ts,tm,unread,mention) VALUES(?,?,?,?,?,?,?)",(ch["name"],ch.get("preview",""),i,int(time.time()),ch.get("time",""),1 if ch.get("unread") else 0,1 if ch.get("mention") else 0))
    except Exception as e: print("save_chats:", e, flush=True)

def save_chat_messages(chat, msgs):
    try:
        with dbc() as c:
            c.execute("DELETE FROM chat_messages WHERE chat=?",(chat,))
            for i,m in enumerate(msgs):
                extra={k:m[k] for k in ("quote","images","files") if m.get(k)}
                c.execute("INSERT INTO chat_messages(chat,idx,mid,author,text,mine,reacts,extra) VALUES(?,?,?,?,?,?,?,?)",(chat,i,m.get("mid",""),m.get("author",""),m.get("text",""),1 if m.get("mine") else 0,m.get("reacts",""),json.dumps(extra,ensure_ascii=False) if extra else ""))
    except Exception as e: print("save_cm:", e, flush=True)

def get_state(k, d=""):
    try:
        with dbc() as c:
            r=c.execute("SELECT v FROM state WHERE k=?",(k,)).fetchone(); return r[0] if r else d
    except Exception: return d
def set_state(k,v):
    try:
        with dbc() as c: c.execute("INSERT OR REPLACE INTO state(k,v) VALUES(?,?)",(k,str(v)))
    except Exception: pass

def pending_commands():
    try:
        with dbc() as c: return c.execute("SELECT id,type,arg1,arg2 FROM commands WHERE status='pending' ORDER BY id").fetchall()
    except Exception: return []
def done_command(cid):
    try:
        with dbc() as c: c.execute("UPDATE commands SET status='done' WHERE id=?",(cid,))
    except Exception: pass

def send_ntfy(title, body):
    if not NTFY_ENABLED: return
    data=json.dumps({"topic":NTFY_TOPIC,"title":(title or "Teams")[:100],"message":(body or "(nuovo messaggio)")[:1000],"priority":4,"tags":["speech_balloon"]}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(NTFY_URL,data=data,headers={"Content-Type":"application/json"}),timeout=10) as r: return r.status
    except Exception as e: print("ntfy:", e, flush=True)

def push_all(title, body):
    if webpush is None or not os.path.exists(VAPID_PRIVATE): return 0
    try:
        with dbc() as c: rows=c.execute("SELECT endpoint,sub FROM push_subs").fetchall()
    except Exception: return 0
    n=0
    for ep,sub in rows:
        try:
            webpush(subscription_info=json.loads(sub), data=json.dumps({"title":(title or "TeamsRelay"),"body":(body or "")}),
                    vapid_private_key=VAPID_PRIVATE, vapid_claims=dict(VAPID_CLAIMS)); n+=1
        except WebPushException as e:
            code=getattr(getattr(e,"response",None),"status_code",0)
            if code in (404,410):
                try:
                    with dbc() as c: c.execute("DELETE FROM push_subs WHERE endpoint=?",(ep,))
                except Exception: pass
        except Exception as e: print("push:", e, flush=True)
    return n

_recent_push = {}
def _dedup_ok(body):
    key = (body or "").strip().lower()[:60]
    now = time.time()
    for k, v in list(_recent_push.items()):
        if now - v > 150: _recent_push.pop(k, None)
    if not key:
        return True
    if key in _recent_push:
        return False
    _recent_push[key] = now
    return True

def notify_msg(title, body):
    if not _dedup_ok(body):
        return
    db_msg(title, body); send_ntfy(title, body); push_all(title, body)

# --- rilevamento nuovi messaggi via polling della lista chat (indipendente dalle notifiche di Teams) ---
_prev_sig = {}     # name -> "preview|tm" visto all'ultima scansione
_prev_unread = {}  # name -> bool
_last_notif = {}   # name -> chiave dell'ultima notifica inviata
_scan_primed = False
def scan_new_messages(chats):
    """Ritorna [(name, body)] per i nuovi messaggi in arrivo.
    Segnale primario: l'anteprima/orario della chat cambia con testo in arrivo.
    Fallback: la chat passa a 'non letto'."""
    global _scan_primed
    out = []
    for ch in chats:
        name = ch.get("name", "")
        prev = (ch.get("preview", "") or "").strip()
        tm = ch.get("time", "")
        unread = bool(ch.get("unread"))
        if not name:
            continue
        sig = prev + "|" + tm
        if not _scan_primed:
            _prev_sig[name] = sig; _prev_unread[name] = unread
            continue
        if "(you)" in name.lower():
            _prev_sig[name] = sig; _prev_unread[name] = unread; continue
        low = prev.lower()
        outbound = low.startswith("you:") or low.startswith("tu:")
        inbound = bool(prev) and not outbound
        content_new = inbound and (name in _prev_sig) and (sig != _prev_sig[name])
        became_unread = (_prev_unread.get(name) is not True) and unread
        if content_new or became_unread:
            key = sig + "|" + ("u" if unread else "r")
            if _last_notif.get(name) != key:
                body = prev if inbound else ("Nuovo messaggio da " + name)
                out.append((name, body)); _last_notif[name] = key
        _prev_sig[name] = sig; _prev_unread[name] = unread
    _scan_primed = True
    return out

def push_count():
    try:
        with dbc() as c: return c.execute("SELECT COUNT(*) FROM push_subs").fetchone()[0]
    except Exception: return 0

def last_msg_ts():
    try:
        with dbc() as c:
            r=c.execute("SELECT ts FROM messages ORDER BY id DESC LIMIT 1").fetchone(); return r[0] if r else 0
    except Exception: return 0

def update_health(page):
    h={"cdp":"ok","ts":int(time.time())}
    try:
        url=(page.url or "").lower()
        loggedout = ("login" in url) or ("signin" in url)
        reduced = page.evaluate("() => /REDUCED_CAPABILITIES|Chats are temporarily unavailable|Sync engine is running in Reduced|We need you to sign in again|Chat non (?:sono )?disponibili/i.test(document.body.innerText||'')")
        dom_ok = page.evaluate("() => !!document.querySelector('[data-tid=\"ckeditor\"]') || !!document.querySelector('[role=\"treeitem\"][id^=\"menu\"]')")
        h["teams"] = "login" if (loggedout or reduced) else ("ok" if dom_ok else "loading")
        h["reduced"] = bool(reduced)
        h["hook"] = "ok" if page.evaluate("() => !!window.__teamsHookInstalled") else "no"
    except Exception as e:
        h["teams"]="err"; h["hook"]="no"; print("health:",e,flush=True)
    h["push_subs"]=push_count(); h["last_msg_ts"]=last_msg_ts()
    try: h["last_scan_ts"]=int(get_state("last_scan_ts") or 0)
    except Exception: h["last_scan_ts"]=0
    scan_fresh = bool(h["last_scan_ts"]) and (int(time.time()) - h["last_scan_ts"] < 60)
    h["watcher"] = "ok" if scan_fresh else "stale"
    if h.get("teams") in ("login","err"):
        h["overall"]="red"
    elif not scan_fresh:
        h["overall"]="yellow"
    else:
        h["overall"]="green"
    # alert una-tantum quando la sessione Teams scade / va in modalita' ridotta
    prev = get_state("teams_status_prev")
    if h.get("teams") == "login" and prev != "login":
        push_all("TeamsRelay", "Sessione Teams scaduta: apri lo schermo remoto e rifai il login per riattivare i messaggi.")
    set_state("teams_status_prev", h.get("teams",""))
    set_state("health", json.dumps(h))
    return h

def self_check(page):
    """Verifica reale: Teams connesso e il rilevatore di nuovi messaggi sta girando."""
    h = update_health(page)
    if h.get("teams") == "login":
        return (False, "Teams disconnesso — serve rifare login")
    if h.get("teams") != "ok":
        return (False, "Teams non completamente caricato")
    try:
        chats = page.evaluate(CHATS_JS)
        if not isinstance(chats, list) or len(chats) == 0:
            return (False, "Lista chat non leggibile")
        save_chats(chats)
        set_state("last_scan_ts", str(int(time.time())))
        for nm, pv in scan_new_messages(chats):
            notify_msg(nm, pv)
    except Exception as e:
        return (False, "Rilevamento nuovi messaggi in errore: " + str(e))
    return (True, "")

def teams_page(ctx):
    for p in ctx.pages:
        u=""
        try: u=p.url or ""
        except Exception: continue
        # Teams web ora reindirizza da teams.microsoft.com a teams.cloud.microsoft
        if ("teams.microsoft.com" in u or "teams.cloud.microsoft" in u) and "serviceworker" not in u: return p
    return None

def same_chat(cur, name):
    return bool(cur) and (cur.startswith(name) or name.startswith(cur))

def open_chat(page, name):
    ok = page.evaluate(r"""(name) => {
      const SECT=/^(Chats|Chat|Favorites|Preferiti)\b/i;
      const hd=s=>s.querySelector(':scope > :not([role="group"])')||s;
      const head=s=>(hd(s).innerText||'').replace(/\s+/g,' ').trim();
      const clean=s=>(s||'').replace(/\s+/g,' ').trim();
      // solo le chat (livello 2): l'header della sezione "Chats" contiene il testo della prima chat e cliccarlo la chiude
      const tis=[...document.querySelectorAll('[role="treeitem"][aria-level="2"][id^="menu"]')].filter(e=>{
        const s=e.parentElement && e.parentElement.closest('[role="treeitem"][aria-level="1"]'); return s && SECT.test(head(s)); });
      let t=tis.find(e => clean(e.innerText).startsWith(name));
      if(!t) t=tis.find(e => clean(e.innerText).indexOf(name)>-1);
      if(t){ (t.querySelector('a,[role=button]')||t).click(); return true; }
      return false;
    }""", name)
    if not ok: return False
    # attende che Teams mostri davvero la chat richiesta (i messaggi della chat precedente sono ancora nel DOM)
    for _ in range(24):
        try:
            if same_chat(page.evaluate(OPEN_CHAT_JS), name): break
        except Exception: pass
        time.sleep(0.25)
    else:
        print("open_chat: la chat non si è aperta:", name, flush=True); return False
    try: page.wait_for_selector('[data-tid="chat-pane-message"]', timeout=3000)
    except Exception: pass
    time.sleep(0.4)
    return True

MEDIA_FAILED = set()

def fetch_media(page, key, src):
    """Salva in MEDIA_DIR l'immagine vista nella pagina; ritorna il nome file o None. Una volta sola per immagine."""
    os.makedirs(MEDIA_DIR, exist_ok=True)
    for ext in MEDIA_EXT.values():
        if os.path.exists(os.path.join(MEDIA_DIR, key+"."+ext)): return key+"."+ext
    if not src or key in MEDIA_FAILED: return None
    try: r = page.evaluate(FETCH_JS, src)
    except Exception as e: print("media:", src[:60], str(e).splitlines()[0][:80], flush=True); r = None
    if not r or r.get("type") not in MEDIA_EXT:
        MEDIA_FAILED.add(key); return None   # es. GIF Giphy senza CORS: resta il link pubblico
    fn = key+"."+MEDIA_EXT[r["type"]]
    with open(os.path.join(MEDIA_DIR, fn), "wb") as f: f.write(base64.b64decode(r["data"]))
    return fn

def read_open_messages(page, chat):
    """Messaggi della chat aperta in Teams, None se in Teams è aperta un'altra chat."""
    try:
        cur = page.evaluate(OPEN_CHAT_JS)
        if not same_chat(cur, chat): return None
        msgs = page.evaluate(MSGS_JS)
    except Exception as e: print("read msgs:", e, flush=True); return None
    for m in msgs:
        imgs = []
        for i, im in enumerate(m.get("images") or []):
            key = hashlib.sha1(f"{chat}|{m.get('mid','')}|{i}".encode()).hexdigest()[:16]
            fn = fetch_media(page, key, im.get("src", ""))
            if fn: imgs.append({"f": fn, "w": im.get("w", 0), "h": im.get("h", 0)})
            elif (im.get("src") or "").startswith("https://"): imgs.append({"url": im["src"], "w": im.get("w", 0), "h": im.get("h", 0)})
        m["images"] = imgs
    return msgs

def save_open_chat(page, chat):
    msgs = read_open_messages(page, chat)
    if msgs is not None: save_chat_messages(chat, msgs)

def do_send(page, name, text):
    if not open_chat(page, name): return False
    if not same_chat(page.evaluate(OPEN_CHAT_JS), name): return False
    try:
        box = page.query_selector('[data-tid="ckeditor"]') or page.query_selector('[role="textbox"]')
        if not box: return False
        box.click(); time.sleep(0.2)
        page.keyboard.insert_text(text); time.sleep(0.2)
        btn = page.query_selector('[data-tid="sendMessageCommands-send"]')
        if btn: btn.click()
        else: page.keyboard.press("Enter")
        time.sleep(1.0); return True
    except Exception as e: print("send err:", e, flush=True); return False

# ---------------- REAZIONI ----------------
QUICK_REACTS    = {"like":"message-actions-like","heart":"message-actions-heart","laugh":"message-actions-laugh","surprised":"message-actions-surprised"}
EXPANDED_REACTS = {"cry":"emoticon-button-cry","angry":"emoticon-button-angry","hearteyes":"emoticon-button-hearteyes","rofl":"emoticon-button-rofl"}

def react_message(page, mid, emoji):
    hov = page.evaluate("""(mid) => {
      const msgs=[...document.querySelectorAll('[data-tid="chat-pane-message"]')];
      let m = mid ? msgs.find(x=>x.getAttribute('data-mid')===mid) : null;
      if(!m) m = msgs[msgs.length-1];
      if(!m) return false;
      m.scrollIntoView({block:'center'});
      for(const ev of ['mouseover','mouseenter','pointerover','pointerenter','mousemove']){
        try{ m.dispatchEvent(new MouseEvent(ev,{bubbles:true})); }catch(e){}
      }
      window.__rt = m; return true;
    }""", mid or "")
    if not hov:
        return False
    time.sleep(0.7)
    if emoji in QUICK_REACTS:
        ok = page.evaluate("""(tid) => {
          const m=window.__rt; if(!m) return false;
          let b=m.querySelector('[data-tid="'+tid+'"]');
          if(!b){ b=[...document.querySelectorAll('[data-tid="'+tid+'"]')].find(x=>x.offsetParent!==null); }
          if(b){ b.click(); return true; } return false;
        }""", QUICK_REACTS[emoji])
        time.sleep(0.4)
        return bool(ok)
    if emoji in EXPANDED_REACTS:
        page.evaluate("""() => {
          const m=window.__rt;
          let e = (m && m.querySelector('[data-tid="expanded-reactions-picker-entry"]')) || [...document.querySelectorAll('[data-tid="expanded-reactions-picker-entry"]')].find(x=>x.offsetParent!==null);
          if(e)e.click();
        }""")
        time.sleep(0.9)
        ok = page.evaluate("""(tid) => { const b=document.querySelector('[data-tid="'+tid+'"]'); if(b){b.click(); return true;} return false; }""", EXPANDED_REACTS[emoji])
        time.sleep(0.4)
        return bool(ok)
    return False

def selfcheck_slot():
    now = datetime.now()
    slot = "am" if 8 <= now.hour < 11 else ("pm" if 17 <= now.hour < 20 else None)
    if not slot: return None
    key = "hc_" + now.strftime("%Y%m%d") + "_" + slot
    return None if get_state(key) == "1" else key

def main():
    db_init()
    print("agent v5 avvio, CDP:", CDP, " ntfy=", NTFY_ENABLED, flush=True)
    with sync_playwright() as pw:
        browser=None
        while browser is None:
            try: browser=pw.chromium.connect_over_cdp(CDP)
            except Exception as e: print("CDP wait:", e, flush=True); time.sleep(3)
        ctx=browser.contexts[0]
        try: ctx.grant_permissions(["notifications"])
        except Exception: pass
        tick=0
        while True:
            try:
                page=teams_page(ctx)
                if not page:
                    set_state("health", json.dumps({"cdp":"ok","teams":"loading","overall":"yellow","ts":int(time.time())}))
                    time.sleep(3); continue
                if page.evaluate(HOOK_JS)=="installed": print("hook ok", flush=True)
                for m in page.evaluate(DRAIN_JS):
                    t,b=m.get("title",""),m.get("body","")
                    if t==HEALTHTAG: continue
                    print("MSG:",repr(t),repr(b),flush=True); notify_msg(t,b)
                # comandi
                for cid,ctype,a1,a2 in pending_commands():
                    print("CMD",ctype,a1,flush=True)
                    if ctype=="open":
                        if open_chat(page,a1): set_state("active_chat",a1); save_open_chat(page, a1)
                    elif ctype=="send":
                        do_send(page,a1,a2); set_state("active_chat",a1); save_open_chat(page, a1)
                    elif ctype=="resync":
                        try: save_chats(page.evaluate(CHATS_JS))
                        except Exception: pass
                        ac=get_state("active_chat")
                        if ac: save_open_chat(page, ac)
                    elif ctype=="recheck":
                        ok,why=self_check(page)
                        push_all("Teams", "✓ Tutto funziona" if ok else ("⚠️ Problema: "+why))
                    elif ctype=="react":
                        react_message(page,a1,a2)
                        ac=get_state("active_chat")
                        if ac: save_open_chat(page, ac)
                    done_command(cid)
                if tick % 3 == 0:
                    try:
                        chats = page.evaluate(CHATS_JS)
                        save_chats(chats)
                        set_state("last_scan_ts", str(int(time.time())))
                        for nm, pv in scan_new_messages(chats):
                            print("NEWMSG:", nm, "|", pv[:50], flush=True)
                            notify_msg(nm, pv)
                    except Exception as e: print("chats:", e, flush=True)
                if tick % 5 == 0:
                    update_health(page)
                ac=get_state("active_chat")
                if ac: save_open_chat(page, ac)
                # check programmato 2x/giorno
                slot=selfcheck_slot()
                if slot:
                    ok,why=self_check(page)
                    set_state(slot,"1")
                    push_all("Teams OK" if ok else "Teams — problema", "✓ Controllo automatico: tutto il giro funziona." if ok else ("⚠️ "+why))
                    print("SELFCHECK", ok, why, flush=True)
                tick+=1
            except Exception as e:
                print("loop:", e, flush=True); time.sleep(2)
                try: browser=pw.chromium.connect_over_cdp(CDP); ctx=browser.contexts[0]
                except Exception: pass
            time.sleep(1)

if __name__=="__main__":
    main()
