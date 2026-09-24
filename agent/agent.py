import os, time, json, sqlite3, urllib.request
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
  const out=[];
  for (const e of items.slice(-40)){
    const mine = !!e.querySelector('.fui-ChatMyMessage') || (e.className||'').indexOf('MyMessage')>-1 || !!e.closest('.fui-ChatMyMessage');
    let author='';
    const an=e.querySelector('[data-tid="message-author-name"]'); if(an) author=(an.innerText||'').trim();
    if(!author){ const al=e.getAttribute('aria-label')||''; const mm=al.match(/^([^,]+),/); if(mm) author=mm[1].trim(); }
    let text=''; const bd=e.querySelector('[id^="content-"]')||e.querySelector('[data-tid="messageBodyContent"]'); if(bd) text=(bd.innerText||'').trim();
    if(!text) text=(e.innerText||'').replace(/\s+/g,' ').trim().slice(0,500);
    let reacts=''; try{ const rc=[...e.querySelectorAll('[aria-label*="reaction" i]')]; reacts=rc.map(x=>(x.getAttribute('aria-label')||'').trim()).filter(Boolean).join(' | ').slice(0,160); }catch(_){}
    out.push({mid:e.getAttribute('data-mid')||'', author:author.slice(0,60), text:text.slice(0,800), mine:!!mine, reacts:reacts});
  }
  return out;
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
            c.execute("CREATE TABLE chat_messages(chat TEXT, idx INTEGER, mid TEXT, author TEXT, text TEXT, mine INTEGER, reacts TEXT)")
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
                c.execute("INSERT INTO chat_messages(chat,idx,mid,author,text,mine,reacts) VALUES(?,?,?,?,?,?,?)",(chat,i,m.get("mid",""),m.get("author",""),m.get("text",""),1 if m.get("mine") else 0,m.get("reacts","")))
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

def open_chat(page, name):
    ok = page.evaluate("""(name) => {
      const clean=s=>(s||'').replace(/\\s+/g,' ').replace(/^(Favorites|Chats|Quick views|Recent|Drafts)\\s+/i,'').trim();
      const tis=[...document.querySelectorAll('[role="treeitem"][id^="menu"]')];
      let t=tis.find(e => clean(e.innerText).startsWith(name));
      if(!t) t=tis.find(e => clean(e.innerText).indexOf(name)>-1);
      if(t){ (t.querySelector('a,[role=button]')||t).click(); return true; }
      return false;
    }""", name)
    if ok:
        # attende che i messaggi della chat siano presenti (max ~3s) invece di uno sleep fisso
        try: page.wait_for_selector('[data-tid="chat-pane-message"]', timeout=3000)
        except Exception: time.sleep(1.2)
        time.sleep(0.4)
    return ok

def read_open_messages(page):
    try: return page.evaluate(MSGS_JS)
    except Exception as e: print("read msgs:", e, flush=True); return []

def do_send(page, name, text):
    if not open_chat(page, name): return False
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
                        if open_chat(page,a1): set_state("active_chat",a1); save_chat_messages(a1, read_open_messages(page))
                    elif ctype=="send":
                        do_send(page,a1,a2); set_state("active_chat",a1); save_chat_messages(a1, read_open_messages(page))
                    elif ctype=="resync":
                        try: save_chats(page.evaluate(CHATS_JS))
                        except Exception: pass
                        ac=get_state("active_chat")
                        if ac: save_chat_messages(ac, read_open_messages(page))
                    elif ctype=="recheck":
                        ok,why=self_check(page)
                        push_all("Teams", "✓ Tutto funziona" if ok else ("⚠️ Problema: "+why))
                    elif ctype=="react":
                        react_message(page,a1,a2)
                        ac=get_state("active_chat")
                        if ac: save_chat_messages(ac, read_open_messages(page))
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
                if ac: save_chat_messages(ac, read_open_messages(page))
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
