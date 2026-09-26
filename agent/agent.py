import os, re, time, json, sqlite3, urllib.request, hashlib, base64, signal
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
DB_PATH    = os.environ.get("DB_PATH", "/data/1/messages.db")
# slot dell'account (1-4) e database dell'app, condiviso fra gli account: dispositivi per le push, elenco account
ACCOUNT    = os.environ.get("ACCOUNT", "1")
APP_DB     = os.environ.get("APP_DB", "/data/app.db")
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
    // chat silenziata: Teams lo scrive sulla riga e mette la campanella barrata al posto dell'avatar
    const muted = e.getAttribute('data-item-type')==='muted-chat' || !!e.querySelector('[data-testid="muted-icon"]');
    const avi=e.querySelector('img.fui-Avatar__image');
    out.push({name:name.slice(0,60), preview:prev.slice(0,120), time:tm, unread:unread, mention:mention, muted:muted, avsrc:(avi&&avi.naturalWidth)?(avi.currentSrc||avi.src):''});
    if(out.length>=40) break;
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
  // corpo in HTML ridotto e sicuro: solo tag noti, colori validati, link http(s); il testo è sempre escapato
  const escH=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const COLOR=/^(rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)|#[0-9a-f]{3,8})$/i;
  const TAGS={B:'b',STRONG:'b',I:'i',EM:'i',U:'u',S:'s',STRIKE:'s',DEL:'s',CODE:'code',PRE:'pre',UL:'ul',OL:'ol',LI:'li',BLOCKQUOTE:'blockquote',P:'p',H1:'h',H2:'h',H3:'h',H4:'h'};
  const toHtml=n=>{
    if(n.nodeType===3) return escH(n.nodeValue);
    if(n.nodeType!==1 || n.matches(SKIP)) return '';
    const t=n.tagName;
    if(t==='BR') return '<br>';
    if(t==='IMG') return isEmoji(n)?escH(n.alt||''):'';
    if(/Mention/i.test(n.getAttribute('itemtype')||'')){
      const me=/Mentioned you/i.test((n.closest('[data-mention-type]')||n).getAttribute('aria-label')||'');
      return `<span class="mn${me?' me':''}">${escH(n.textContent||'')}</span>`;
    }
    let out=''; for(const c of n.childNodes) out+=toHtml(c);
    if(n.hasAttribute('data-mention-type')) return out;          // contenitore della menzione: inline
    if(t==='A'){ const h=n.getAttribute('href')||''; return /^https?:\/\//i.test(h)?`<a href="${escH(h)}" target="_blank" rel="noopener">${out}</a>`:out; }
    const st=n.style||{};
    if(st.color && COLOR.test(st.color.trim())) out=`<span style="color:${st.color.trim()}">${out}</span>`;
    if(st.backgroundColor && COLOR.test(st.backgroundColor.trim())) out=`<span style="background:${st.backgroundColor.trim()}">${out}</span>`;
    if(/^(bold|[6-9]00)$/.test(st.fontWeight||'')) out=`<b>${out}</b>`;
    if(st.fontStyle==='italic') out=`<i>${out}</i>`;
    if(/line-through/.test(st.textDecoration||'')) out=`<s>${out}</s>`;
    else if(/underline/.test(st.textDecoration||'')) out=`<u>${out}</u>`;
    const tag=TAGS[t];
    if(tag==='h') return `<div class="h">${out}</div>`;
    if(tag) return `<${tag}>${out}</${tag}>`;
    return /^(block|flex|grid|list-item|table)$/.test(getComputedStyle(n).display)?`<div>${out}</div>`:out;
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
    // reazioni presenti su Teams: una pill per emoji, col conteggio nel testo ("2 Like reactions.")
    const reactions=[...it.querySelectorAll('[data-tid="diverse-reaction-pill-button"]')].map(x=>({
      e:[...x.querySelectorAll('img')].map(i=>i.alt).join(''), n:parseInt((x.innerText||'').trim(),10)||1, mine:x.getAttribute('aria-pressed')==='true' })).filter(r=>r.e);
    const reacts=reactions.map(r=>r.e+(r.n>1?r.n:'')).join(' ');
    // stato dei miei messaggi: Teams mette l'icona "Seen" sull'ultimo letto dall'altra parte
    let status=''; if(mine){ const my=e.closest('.fui-ChatMyMessage')||it.querySelector('.fui-ChatMyMessage');
      const si=my&&my.querySelector('[class*="statusIcon"]'); status=si?(si.getAttribute('aria-label')||'').trim():''; }
    // Teams scrive "Edited" in un span dell'intestazione del messaggio
    const deleted=!!it.querySelector('[data-tid="message-tombstone"]');
    const edited=[...it.querySelectorAll('span')].some(x=>!x.closest('[id^="content-"]') && /^(Edited|Modificato)$/i.test((x.textContent||'').trim()));
    const avi=it.querySelector('[data-tid="message-avatar"] img.fui-Avatar__image, [data-tid="message-avatar"] img');
    const avsrc=(avi&&avi.naturalWidth)?(avi.currentSrc||avi.src):'';
    let html=bd?toHtml(bd):'';
    // contenitori vuoti (es. quello della GIF, estratta a parte) e paragrafi vuoti in testa o in coda
    for(let k=0;k<4;k++) html=html.replace(/<div>\s*<\/div>/g,'');
    html=html.replace(/^(\s|<div>|<p>[\s\u00a0]*<\/p>)+/,m=>m.replace(/<p>[\s\u00a0]*<\/p>/g,'')).replace(/(<p>[\s\u00a0]*<\/p>|\s)+(?=(<\/div>)*$)/,'').slice(0,20000);
    const mentionsMe=!!(bd && bd.querySelector('[data-mention-type][aria-label="Mentioned you"]'));
    out.push({mid:e.getAttribute('data-mid')||'', author:author.slice(0,60), text:text.slice(0,2000), mine:!!mine, reacts:reacts, quote:quote, images:images, files:files, reactions:reactions, status:status, edited:edited, html:html, mentionsMe:mentionsMe, avsrc:avsrc, deleted:deleted});
  }
  return out;
}
"""

# Feed Attività di Teams: reazioni ai miei messaggi, menzioni, risposte
ACTIVITY_JS = r"""() => [...document.querySelectorAll('[data-tid="activity-feed-list-item"]')].map(it=>{
  const id=((it.getAttribute('aria-labelledby')||'').match(/activity-feed-item-title-(\d+)/)||[])[1]||'';
  const tEl=it.querySelector('[data-tid="activity-feed-item-title"]');
  const title=tEl?(tEl.innerText||'').replace(/\s+/g,' ').trim():'';
  // text outside the title and outside buttons (item menu, "Call" and "Chat" of a missed call)
  const leaves=[...it.querySelectorAll('*')].filter(x=>x.children.length===0 && (x.textContent||'').trim() && !(tEl&&tEl.contains(x)) && !x.closest('button'))
    .map(x=>x.textContent.replace(/\s+/g,' ').trim());
  // riga dell'orario riconosciuta dal formato: prima c'è l'anteprima, dopo il luogo (chat, oppure team > canale)
  const TM=/^(\d{1,2}:\d{2}\s?(AM|PM)?|\d{1,2}\/\d{1,2}(\/\d{2,4})?|Yesterday|Ieri|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i;
  let ti=leaves.findIndex(x=>TM.test(x)); if(ti<0) ti=leaves.length;
  const tm=leaves[ti]||'', preview=leaves.slice(0,ti).join(' '), place=leaves.slice(ti+1);
  const emoji=[...it.querySelectorAll('img')].map(i=>i.alt||'').filter(Boolean).join('');
  // the person comes before the action ("Anna Rossi assigned you a task"), except in "Missed call from Anna Rossi"
  const call=title.match(/^Missed call from (.+)$/i);
  const actor=call?call[1].trim():title.replace(/\s+(reacted|mentioned|replied|liked|sent|posted|invited|scheduled|assigned|updated|added|removed|shared|commented|canceled|cancelled|accepted|declined|started|joined|changed|created|edited|forwarded)\b.*$/i,'').trim();
  let kind=call?'call':/reacted/i.test(title)?'reaction':/mentioned/i.test(title)?'mention':/repl/i.test(title)?'reply':/assigned you a task/i.test(title)?'task':/added you to/i.test(title)?'team':'message';
  // a channel is written "Team > Channel" on one line, or on two
  const channel=place.length>1 || /\s>\s/.test(place.join(' '));
  let chat=place.join(' › ').replace(/\s+>\s+/g,' › ');
  if(/^In chat with you$/i.test(chat) || call) chat=actor;               // 1:1: il luogo è la persona
  if(/\d{1,2}:\d{2}\s?(AM|PM)?\s*-\s*\d{1,2}:\d{2}/i.test(chat)) kind='meeting';  // invito a riunione
  const w=parseInt(getComputedStyle(tEl||it).fontWeight,10)||400;
  const avi=[...it.querySelectorAll('img')].find(i=>!i.alt && i.naturalWidth);
  return {id, title, kind, actor, emoji, preview:preview.slice(0,300), tm, chat, channel, unread:w>=600, avsrc:avi?(avi.currentSrc||avi.src):''};
})"""

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

def adbc():
    c = sqlite3.connect(APP_DB, timeout=8); c.execute("PRAGMA journal_mode=WAL"); return c

def db_init():
    # app.db belongs to the web app (users, teams_accounts, push_subscriptions): the agent only reads it
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    try:
        with dbc() as c:
            c.execute("CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, source TEXT, title TEXT, body TEXT)")
            # niente DROP: a ogni riavvio dell'agent la web app deve continuare a mostrare chat e messaggi
            c.execute("CREATE TABLE IF NOT EXISTS chats(name TEXT PRIMARY KEY, preview TEXT, pos INTEGER, ts INTEGER, tm TEXT, unread INTEGER, mention INTEGER)")
            cols = {r[1] for r in c.execute("PRAGMA table_info(chats)")}
            if "muted" not in cols: c.execute("ALTER TABLE chats ADD COLUMN muted INTEGER DEFAULT 0")
            if "av" not in cols: c.execute("ALTER TABLE chats ADD COLUMN av TEXT")
            c.execute("CREATE TABLE IF NOT EXISTS chat_messages(chat TEXT, idx INTEGER, mid TEXT, author TEXT, text TEXT, mine INTEGER, reacts TEXT, extra TEXT)")
            cols={r[1] for r in c.execute("PRAGMA table_info(chat_messages)")}
            if "extra" not in cols: c.execute("ALTER TABLE chat_messages ADD COLUMN extra TEXT")
            c.execute("CREATE TABLE IF NOT EXISTS commands(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, arg1 TEXT, arg2 TEXT, status TEXT DEFAULT 'pending')")
            c.execute("CREATE TABLE IF NOT EXISTS state(k TEXT PRIMARY KEY, v TEXT)")
            c.execute("CREATE TABLE IF NOT EXISTS readby(mid TEXT PRIMARY KEY, chat TEXT, label TEXT, names TEXT, ts INTEGER)")
            c.execute("CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY, pos INTEGER, kind TEXT, actor TEXT, title TEXT, emoji TEXT, preview TEXT, tm TEXT, chat TEXT, unread INTEGER, ts INTEGER)")
            acols = {r[1] for r in c.execute("PRAGMA table_info(activity)")}
            if "channel" not in acols: c.execute("ALTER TABLE activity ADD COLUMN channel INTEGER")
            if "av" not in acols: c.execute("ALTER TABLE activity ADD COLUMN av TEXT")
    except Exception as e: print("db_init:", e, flush=True)

def db_msg(title, body):
    try:
        with dbc() as c: c.execute("INSERT INTO messages(ts,source,title,body) VALUES(?,?,?,?)",(int(time.time()),"teams",title,body))
    except Exception as e: print("db_msg:", e, flush=True)

def save_chats(chats, replace=False):
    """Teams virtualizza la lista: si vedono solo le chat che entrano nella finestra (che cambia con chi guarda il desktop).
    Le chat visibili vanno in testa nell'ordine di Teams; quelle non visibili ora restano, nel loro ordine."""
    if not chats: return
    try:
        with dbc() as c:
            seen = {ch["name"] for ch in chats}
            old = [dict(name=r[0], preview=r[1], time=r[2], unread=r[3], mention=r[4], muted=r[5], av=r[6])
                   for r in c.execute("SELECT name,preview,tm,unread,mention,muted,av FROM chats ORDER BY pos")]
            oldav = {o["name"]: o["av"] for o in old if o["av"]}
            for ch in chats:                       # foto non ancora copiata in questo giro: resta quella nota
                if not ch.get("av") and oldav.get(ch["name"]): ch["av"] = oldav[ch["name"]]
            if not replace: chats = (list(chats) + [o for o in old if o["name"] not in seen])[:40]
            c.execute("DELETE FROM chats")
            for i,ch in enumerate(chats):
                c.execute("INSERT OR REPLACE INTO chats(name,preview,pos,ts,tm,unread,mention,muted,av) VALUES(?,?,?,?,?,?,?,?,?)",(ch["name"],ch.get("preview",""),i,int(time.time()),ch.get("time",""),1 if ch.get("unread") else 0,1 if ch.get("mention") else 0,1 if ch.get("muted") else 0,ch.get("av","")))
    except Exception as e: print("save_chats:", e, flush=True)

def save_chat_messages(chat, msgs):
    try:
        with dbc() as c:
            c.execute("DELETE FROM chat_messages WHERE chat=?",(chat,))
            for i,m in enumerate(msgs):
                extra={k:m[k] for k in ("quote","images","files","reactions","status","edited","readby","html","mentionsMe","av","deleted") if m.get(k)}
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
def set_cmd_result(cid, status):
    try:
        with dbc() as c: c.execute("UPDATE commands SET status=? WHERE id=?",(status,cid))
    except Exception as e: print("cmd result:", e, flush=True)

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

def acc_label():
    """Con più account la notifica dice di quale è: organizzazione, altrimenti email."""
    # accounts of the same owner: other users' accounts do not count
    try:
        with adbc() as c: many = c.execute("SELECT COUNT(*) FROM teams_accounts WHERE owner_id=(SELECT owner_id FROM teams_accounts WHERE slot=?)", (int(ACCOUNT),)).fetchone()[0] > 1
    except Exception: many = False
    if not many: return ""
    try: me = json.loads(get_state("me") or "{}")
    except Exception: me = {}
    return me.get("tenant") or me.get("email") or f"account {ACCOUNT}"

def push_targets():
    """Devices of the user who owns this slot."""
    try:
        with adbc() as c:
            return c.execute("SELECT p.endpoint, p.sub FROM push_subscriptions p JOIN teams_accounts a ON a.owner_id=p.user_id WHERE a.slot=?", (int(ACCOUNT),)).fetchall()
    except Exception: return []

def push_all(title, body):
    if webpush is None or not os.path.exists(VAPID_PRIVATE): return 0
    rows=push_targets()
    if not rows: return 0
    lb=acc_label(); title=(title or "TeamsRelay")+(f" · {lb}" if lb else "")
    n=0
    for ep,sub in rows:
        try:
            # acc: la notifica apre l'app su questo account
            webpush(subscription_info=json.loads(sub), data=json.dumps({"title":title,"body":(body or ""),"acc":int(ACCOUNT)}),
                    vapid_private_key=VAPID_PRIVATE, vapid_claims=dict(VAPID_CLAIMS)); n+=1
        except WebPushException as e:
            code=getattr(getattr(e,"response",None),"status_code",0)
            if code in (404,410):
                try:
                    with adbc() as c: c.execute("DELETE FROM push_subscriptions WHERE endpoint=?",(ep,))
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
        if "(you)" in name.lower() or ch.get("muted"):
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
    return len(push_targets())

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
    # solo per un account già entrato almeno una volta: quello appena aggiunto il login lo deve ancora fare
    if h.get("teams") == "login" and prev != "login" and get_state("me"):
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

# Teams web ora reindirizza da teams.microsoft.com a teams.cloud.microsoft
TEAMS_HOSTS = ("teams.microsoft.com", "teams.cloud.microsoft", "teams.live.com")
LOGIN_HOSTS = ("login.microsoftonline.com", "login.live.com", "login.microsoft.com")
# Outside Edge, Defender for Cloud Apps (Conditional Access App Control) proxies the session and appends
# its suffix to every host: teams.cloud.microsoft.mcas.ms
PROXY_SUFFIX = re.compile(r"\.mcas(-gov)?\.(ms|us)$")
def host_of(p):
    from urllib.parse import urlparse
    try: return PROXY_SUFFIX.sub("", urlparse(p.url or "").hostname or "")
    except Exception: return ""
def is_teams(p):
    return host_of(p) in TEAMS_HOSTS and "serviceworker" not in (p.url or "")

def teams_page(ctx):
    """La scheda di Teams; se manca, quella del login Microsoft (account appena aggiunto o sessione scaduta)."""
    login = None
    for p in ctx.pages:
        try:
            if is_teams(p): return p
            if host_of(p) in LOGIN_HOSTS and not login: login = p
        except Exception: continue
    return login

# Chi è loggato: nome, email e organizzazione dal profilo che Teams tiene in localStorage, foto dal pulsante del profilo
WHOAMI_JS = r"""()=>{ const g=k=>{try{return JSON.parse(localStorage.getItem(k)||'null')}catch(e){return null}};
  const u=g('tmp.auth.v1.GLOBAL.User.User'), p=(u&&u.item&&u.item.profile)||{};
  const tk=Object.keys(localStorage).find(k=>/^tmp\.auth\.v1\..*\.Tenants\.Tenants$/.test(k));
  const t=((g(tk)||{}).item)||[];
  const img=document.querySelector('[data-tid="me-control-avatar"] img');
  return {name:p.name||'', email:p.preferred_username||p.upn||'', tenant:(t.find(x=>x.tenantId===p.tid)||{}).tenantName||'',
          avsrc:(img&&img.naturalWidth)?(img.currentSrc||img.src):''}; }"""

def save_identity(page):
    try: me = page.evaluate(WHOAMI_JS)
    except Exception as e: print("whoami:", str(e).splitlines()[0][:120], flush=True); return
    if not me.get("email") and not me.get("name"): return
    me["av"] = avatar_file(page, me.pop("avsrc", ""), [1])
    try: old = json.loads(get_state("me") or "{}")
    except Exception: old = {}
    if not me["av"] and old.get("av"): me["av"] = old["av"]
    if me != old: print("account:", me.get("email"), me.get("tenant"), flush=True)
    set_state("me", json.dumps(me, ensure_ascii=False))

def known_chat(name):
    try:
        with dbc() as c: return c.execute("SELECT 1 FROM chats WHERE name=?", (name,)).fetchone() is not None
    except Exception: return False

def same_chat(cur, name):
    # The open title can differ from the list name (names are cut at 60 characters, suffixes such as
    # "(External)"), so a prefix still matches, unless the title is another chat of the list:
    # "Luca Bianchini" is not "Luca Bianchi".
    if not cur or not name: return False
    if cur == name: return True
    if not (cur.startswith(name) or name.startswith(cur)): return False
    return not known_chat(cur)

# Clicks the row of chat `name`. Row names are parsed as in CHATS_JS; the exact name wins, a prefix
# is used only when a single row matches it. No match or an ambiguous prefix: nothing is clicked.
OPEN_CHAT_ROW_JS = r"""(name) => {
  const SECT=/^(Chats|Chat|Favorites|Preferiti)\b/i;
  const STAT=/\b(Unread|Offline|Away|Available|Busy|Do not disturb|Be right back|Presence unknown|Out of office)\b/gi;
  const hd=s=>s.querySelector(':scope > :not([role="group"])')||s;
  const head=s=>(hd(s).innerText||'').replace(/\s+/g,' ').trim();
  // solo le chat (livello 2): l'header della sezione "Chats" contiene il testo della prima chat e cliccarlo la chiude
  const tis=[...document.querySelectorAll('[role="treeitem"][aria-level="2"][id^="menu"]')].filter(e=>{
    const s=e.parentElement && e.parentElement.closest('[role="treeitem"][aria-level="1"]'); return s && SECT.test(head(s)); });
  const rowName=e=>{
    const clean=(e.innerText||'').replace(/\s+/g,' ').trim().replace(/^(Favorites|Chats|Quick views|Recent|Drafts)\s+/i,'').replace(STAT,'').replace(/\s+/g,' ').trim();
    const n=clean.split(/\s+\d{1,2}:\d{2}|\s+\d{1,2}\/\d{1,2}|\s+You:/)[0].trim();
    return (n||clean.slice(0,40)).slice(0,60);
  };
  const names=tis.map(rowName);
  let i=names.indexOf(name);
  if(i<0){ const p=names.map((n,k)=>n.startsWith(name)?k:-1).filter(k=>k>=0); if(p.length===1) i=p[0]; }
  if(i<0) return false;
  // click sulla riga: l'unico pulsante dentro la riga è "More chat options" (menu con Hide, Remove chat history...)
  tis[i].click(); return true;
}"""

def open_chat(page, name):
    ok = page.evaluate(OPEN_CHAT_ROW_JS, name)
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

# Le foto profilo arrivano da un'API di Teams che vuole il suo token: fetch() viene rifiutata.
# Sono però già disegnate nella pagina e sono dello stesso dominio, quindi si copiano da un canvas.
GRAB_AVATAR_JS = r"""(src)=>{ const i=[...document.querySelectorAll('img')].find(x=>(x.currentSrc||x.src)===src && x.naturalWidth);
  if(!i) return null; const c=document.createElement('canvas'); c.width=i.naturalWidth; c.height=i.naturalHeight;
  try{ c.getContext('2d').drawImage(i,0,0); return c.toDataURL('image/png').split(',')[1]; }catch(e){ return null; } }"""

def avatar_file(page, src, budget=[0]):
    """Nome file della foto (in data/media) per l'URL `src`; la copia una volta sola. `budget` limita le copie per giro."""
    if not src: return ""
    fn = hashlib.sha1(src.encode()).hexdigest()[:16] + ".png"
    if os.path.exists(os.path.join(MEDIA_DIR, fn)): return fn
    if budget[0] <= 0: return ""
    budget[0] -= 1
    try: data = page.evaluate(GRAB_AVATAR_JS, src)
    except Exception: data = None
    if not data: return ""
    os.makedirs(MEDIA_DIR, exist_ok=True)
    with open(os.path.join(MEDIA_DIR, fn), "wb") as f: f.write(base64.b64decode(data))
    return fn

def attach_avatars(page, items, limit=8):
    budget = [limit]
    for it in items:
        it["av"] = avatar_file(page, it.pop("avsrc", ""), budget)
    return items
FILES_DIR = os.path.join(os.path.dirname(DB_PATH), "files")

def download_file(page, url, name):
    """Scarica un allegato SharePoint/OneDrive con la sessione del browser di Teams (dal telefono il link chiederebbe il login)."""
    from urllib.parse import urlparse
    host = urlparse(url).hostname or ""
    if not url.startswith("https://") or not host.endswith(".sharepoint.com"): return None
    ext = os.path.splitext(name or "")[1].lower()
    ext = ext if re.fullmatch(r"\.[a-z0-9]{1,8}", ext or "") else ""
    fn = hashlib.sha1(url.encode()).hexdigest()[:16] + ext
    path = os.path.join(FILES_DIR, fn)
    if os.path.exists(path): return fn
    os.makedirs(FILES_DIR, exist_ok=True)
    try:
        r = page.context.request.get(url + ("&" if "?" in url else "?") + "download=1", max_redirects=10, timeout=60000)
        ct = r.headers.get("content-type", "")
        if r.status != 200 or ct.startswith("text/html"): print("download:", r.status, ct, flush=True); return None
        body = r.body()
        if len(body) > 100e6: return None
        with open(path, "wb") as f: f.write(body)
        return fn
    except Exception as e:
        print("download:", str(e).splitlines()[0][:120], flush=True); return None

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
    attach_avatars(page, msgs)
    rb = readby_cache([m.get("mid", "") for m in msgs if m.get("mine")])
    for m in msgs:
        if m.get("mid") in rb: m["readby"] = rb[m["mid"]]
    return msgs

# ---- "Letto da" nei gruppi, raccolto in background ----
# Teams lo espone solo nel menu More options di ogni messaggio: l'agent lo legge quando è libero,
# un messaggio alla volta, e la web app lo mostra già pronto sotto il messaggio.
READBY_RECENT = 5        # quanti miei messaggi recenti tenere aggiornati per chat
READBY_EVERY  = 60       # secondi fra due letture dello stesso messaggio finché non l'hanno letto tutti

def readby_cache(mids):
    if not mids: return {}
    try:
        with dbc() as c:
            q = "SELECT mid,label,names FROM readby WHERE mid IN (%s)" % ",".join("?" * len(mids))
            return {r[0]: {"label": r[1], "names": json.loads(r[2] or "[]")} for r in c.execute(q, mids)}
    except Exception: return {}

def readby_done(label):
    m = re.match(r"Read by (\d+) of (\d+)", label or "")
    return bool(m) and m.group(1) == m.group(2)

def prefetch_readby(page, chat):
    """Aggiorna il "letto da" di un mio messaggio recente della chat aperta. Ritorna True se ha lavorato."""
    if not chat or get_state(f"chat_1to1:{chat}") == "1": return False
    try:
        with dbc() as c:
            mine = [r[0] for r in c.execute("SELECT mid FROM chat_messages WHERE chat=? AND mine=1 AND mid<>'' ORDER BY idx DESC LIMIT ?", (chat, READBY_RECENT))]
            known = {r[0]: (r[1], r[2]) for r in c.execute("SELECT mid,label,ts FROM readby WHERE chat=?", (chat,))}
    except Exception: return False
    now = int(time.time())
    todo = [mid for mid in mine if mid not in known or (not readby_done(known[mid][0]) and now - known[mid][1] > READBY_EVERY)]
    if not todo: return False
    mid = todo[0]
    res = read_receipts(page, chat, mid)
    if res is None: return True
    if not res.get("label"):
        set_state(f"chat_1to1:{chat}", "1")      # chat 1:1: basta lo stato Seen
        return True
    try:
        with dbc() as c:
            c.execute("INSERT OR REPLACE INTO readby(mid,chat,label,names,ts) VALUES(?,?,?,?,?)",
                      (mid, chat, res["label"], json.dumps(res.get("names") or [], ensure_ascii=False), now))
    except Exception as e: print("readby save:", e, flush=True)
    save_open_chat(page, chat)
    return True

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

def reply_message(page, chat, mid, text):
    """Risposta con citazione (Reply with quote) al messaggio `mid`. True quando il messaggio compare su Teams."""
    text = (text or "").strip()
    if not text or not clear_overlays(page) or not open_chat(page, chat): return False
    before = page.evaluate("""()=>document.querySelectorAll('[data-tid="chat-pane-message"]').length""")
    try:
        # sui messaggi degli altri "Reply with quote" è sulla barra, sui miei è nel menu More options
        mine = page.evaluate("""(mid)=>{const m=document.querySelector('[data-tid="chat-pane-message"][data-mid="'+mid+'"]'); return !!(m&&m.closest('.fui-ChatMyMessage'))}""", mid)
        if mine or not click_bar_button(page, mid, "message-actions-quoted-reply"):
            if not click_bar_button(page, mid, "message-actions-more"): print("reply: barra non trovata", mid, flush=True); return False
            page.locator('[role="menu"] [data-tid="message-actions-quoted-reply"]:visible').first.click(timeout=4000)
        # la citazione compare sopra il box di scrittura
        page.wait_for_function("""()=>[...document.querySelectorAll('[data-tid="close-quoted-reply"]')].some(x=>!x.closest('[data-tid="chat-pane-item"]'))""", timeout=4000)
        # Teams mette già il cursore dopo la citazione: un click sul box finirebbe sulla citazione e il testo andrebbe perso
        time.sleep(0.3)
        page.keyboard.insert_text(text); time.sleep(0.3)
        if text[:20] not in (page.evaluate("""()=>{const e=[...document.querySelectorAll('[data-tid="ckeditor"]')].find(x=>!x.closest('[data-tid="chat-pane-item"]')&&x.offsetParent!==null); return e?e.innerText:''}""") or ""):
            raise RuntimeError("testo non inserito nel box")
        # Invio: il pulsante cambia nome a seconda del layout (sendMessageCommands-send / newMessageCommands-send)
        page.keyboard.press("Enter")
    except Exception as e:
        print("reply:", str(e).splitlines()[0][:120], flush=True)
        try: page.locator('[data-tid="close-quoted-reply"]:visible').first.click(timeout=1500)   # niente citazioni lasciate nel box
        except Exception: pass
        return False
    finally:
        page.mouse.move(2, 2)
    for _ in range(20):
        time.sleep(0.3)
        ok = page.evaluate("""([n,t])=>{ const ms=[...document.querySelectorAll('[data-tid="chat-pane-message"]')]; if(ms.length<=n) return false;
          const it=ms[ms.length-1].closest('[data-tid="chat-pane-item"]'); return !!it.querySelector('[data-tid="quoted-reply-card"]') && (it.innerText||'').includes(t); }""", [before, text[:40]])
        if ok: return True
    print("reply: messaggio non comparso su Teams", mid, flush=True); return False

def delete_message(page, chat, mid):
    """Elimina un mio messaggio. Teams lo fa subito e lascia "Undo" per qualche secondo."""
    if not clear_overlays(page) or not open_chat(page, chat): return False
    try:
        if not click_bar_button(page, mid, "message-actions-more"): return False
        page.locator('[role="menu"] [data-tid="message-actions-delete"]:visible').first.click(timeout=4000)
    except Exception as e:
        print("delete:", str(e).splitlines()[0][:120], flush=True); clear_overlays(page); return False
    finally:
        page.mouse.move(2, 2)
    for _ in range(32):
        time.sleep(0.25)
        if page.evaluate("""(mid)=>{const m=document.querySelector('[data-tid="chat-pane-message"][data-mid="'+mid+'"]'); const it=m&&m.closest('[data-tid="chat-pane-item"]'); return !!(it&&it.querySelector('[data-tid="message-tombstone"]'))}""", mid): return True
    print("delete: nessun cambio su Teams", mid, flush=True); return False

def undo_delete(page, chat, mid):
    if not clear_overlays(page) or not open_chat(page, chat): return False
    pt = page.evaluate("""(mid)=>{const m=document.querySelector('[data-tid="chat-pane-message"][data-mid="'+mid+'"]'); const it=m&&m.closest('[data-tid="chat-pane-item"]');
      const b=it&&it.querySelector('[data-tid="message-undo-delete-btn"]'); if(!b) return null; b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};}""", mid)
    if not pt: return False
    page.mouse.click(pt["x"], pt["y"]); page.mouse.move(2, 2)
    for _ in range(16):
        time.sleep(0.25)
        if page.evaluate("""(mid)=>{const m=document.querySelector('[data-tid="chat-pane-message"][data-mid="'+mid+'"]'); const it=m&&m.closest('[data-tid="chat-pane-item"]'); return !!(it&&!it.querySelector('[data-tid="message-tombstone"]'))}""", mid): return True
    return False

# ---------------- REAZIONI E MODIFICA ----------------
# Le azioni di Teams compaiono solo con un hover vero del mouse: gli eventi sintetici via JS non bastano.
QUICK_REACTS    = {"like":"message-actions-like","heart":"message-actions-heart","laugh":"message-actions-laugh","surprised":"message-actions-surprised"}
EXPANDED_REACTS = {"cry":"emoticon-button-cry","angry":"emoticon-button-angry"}

def clear_overlays(page):
    """Chiude menu o finestre rimasti aperti sopra la chat, che intercetterebbero il mouse."""
    for _ in range(3):
        n = page.evaluate("""()=>[...document.querySelectorAll('[role="menu"],[role="dialog"],[role="alertdialog"]')].filter(e=>e.getClientRects().length).length""")
        if not n: return True
        page.keyboard.press("Escape"); time.sleep(0.4)
    return False

def hover_message(page, mid):
    """Porta il mouse sul messaggio finché Teams mostra la sua barra azioni."""
    m = page.locator(f'[data-tid="chat-pane-message"][data-mid="{mid}"]')
    if m.count() == 0: return False
    bar = page.locator('[data-tid="message-actions-container"]:visible')
    for _ in range(4):
        try:
            m.evaluate("e => e.scrollIntoView({block:'center'})")
            box = m.bounding_box()
            if not box: time.sleep(0.3); continue
            # movimento diretto del mouse: hover() di Playwright aspetta la fine delle animazioni di Teams (anche 10 s)
            page.mouse.move(2, 2); time.sleep(0.1)
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + min(box["height"] / 2, 20), steps=3)
            bar.first.wait_for(timeout=1500)
            return True
        except Exception:
            time.sleep(0.3)
    return False

BAR_BUTTON_JS = r"""([mid, tid]) => {
  // Teams disegna le barre azioni in un portal fuori dal messaggio e ne possono essere visibili più d'una:
  // si usa quella più vicina al messaggio richiesto.
  const m=document.querySelector('[data-tid="chat-pane-message"][data-mid="'+mid+'"]'); if(!m) return null;
  const r=m.getBoundingClientRect();
  const bars=[...document.querySelectorAll('[data-tid="message-actions-container"]')].filter(b=>b.offsetParent!==null);
  let best=null, bd=1e9;
  for(const b of bars){ const q=b.getBoundingClientRect(); const d=Math.abs((q.top+q.bottom)/2-(r.top+Math.min(r.height,40)/2)); if(d<bd){bd=d; best=b;} }
  if(!best || bd>120) return null;
  const btn=best.querySelector('[data-tid="'+tid+'"]'); if(!btn || btn.offsetParent===null) return null;
  const q=btn.getBoundingClientRect(); return {x:q.left+q.width/2, y:q.top+q.height/2};
}"""

def click_bar_button(page, mid, tid):
    """Hover sul messaggio e click sul pulsante `tid` della sua barra azioni."""
    for _ in range(3):
        if not hover_message(page, mid): return False
        pt = page.evaluate(BAR_BUTTON_JS, [mid, tid])
        if pt:
            page.mouse.click(pt["x"], pt["y"])   # salto diretto: il mouse non passa su altri messaggi
            return True
        time.sleep(0.3)
    return False

def my_reactions(page, mid):
    return page.evaluate(r"""(mid)=>{ const m=document.querySelector('[data-tid="chat-pane-message"][data-mid="'+mid+'"]'); if(!m) return [];
      const it=m.closest('[data-tid="chat-pane-item"]')||m;
      return [...it.querySelectorAll('[data-tid="diverse-reaction-pill-button"][aria-pressed="true"]')].map(x=>(x.getAttribute('aria-labelledby')||'').split('-')[1]||''); }""", mid)

def react_message(page, chat, mid, emoji):
    """Mette (o toglie, se già messa) una reazione. Ritorna True se lo stato su Teams è cambiato."""
    if emoji not in QUICK_REACTS and emoji not in EXPANDED_REACTS: return False
    if not clear_overlays(page): print("react: finestra aperta sopra la chat", flush=True); return False
    if not open_chat(page, chat): return False
    before = my_reactions(page, mid)
    try:
        tid = QUICK_REACTS.get(emoji, "expanded-reactions-picker-entry")
        if not click_bar_button(page, mid, tid): print("react: pulsante non trovato", mid, tid, flush=True); return False
        if emoji in EXPANDED_REACTS:
            page.locator(f'[data-tid="{EXPANDED_REACTS[emoji]}"]:visible').first.click(timeout=4000)
    except Exception as e:
        print("react:", str(e).splitlines()[0][:120], flush=True); page.keyboard.press("Escape"); return False
    finally:
        page.mouse.move(2, 2)
    for _ in range(12):
        time.sleep(0.25)
        if my_reactions(page, mid) != before: return True
    print("react: nessun cambio su Teams", mid, emoji, flush=True); return False

def read_receipts(page, chat, mid):
    """Chi ha letto un mio messaggio: voce "Read by X of Y" del menu More options e il suo sottomenu coi nomi."""
    if not clear_overlays(page) or not open_chat(page, chat): return None
    try:
        rr = page.locator('[data-tid="message-actions-read-receipt"]:visible').first
        found = menu_seen = False
        for _ in range(2):
            if not click_bar_button(page, mid, "message-actions-more"):
                if menu_seen: break
                return None
            try: page.locator('[role="menu"]:visible').first.wait_for(timeout=3000)
            except Exception: clear_overlays(page); continue
            menu_seen = True
            try: rr.wait_for(timeout=1500); found = True; break
            except Exception: clear_overlays(page); time.sleep(0.5)
        if not found:
            # menu aperto ma senza "Read by": chat 1:1, dove basta lo stato Seen
            return {"label": "", "names": []} if menu_seen else None
        label = (rr.inner_text() or "").strip()
        rr.hover(); time.sleep(1.0)
        names = page.evaluate(r"""()=>{ const ms=[...document.querySelectorAll('[role="menu"]')].filter(m=>m.getClientRects().length && !m.querySelector('[data-tid="message-actions-read-receipt"]'));
          return ms.flatMap(m=>[...m.querySelectorAll('[role="menuitem"]')].map(x=>(x.innerText||'').trim()).filter(Boolean)); }""")
        return {"label": label, "names": names}
    except Exception as e:
        print("readby:", str(e).splitlines()[0][:120], flush=True); return None
    finally:
        clear_overlays(page); page.mouse.move(2, 2)

PILL_JS = r"""([mid, emo]) => {
  const m=document.querySelector('[data-tid="chat-pane-message"][data-mid="'+mid+'"]'); if(!m) return null;
  const it=m.closest('[data-tid="chat-pane-item"]')||m;
  const b=[...it.querySelectorAll('[data-tid="diverse-reaction-pill-button"]')].find(x=>[...x.querySelectorAll('img')].some(i=>i.alt===emo));
  if(!b) return {found:false};
  const r=b.getBoundingClientRect(); return {found:true, x:r.left+r.width/2, y:r.top+r.height/2, pressed:b.getAttribute('aria-pressed')==='true'};
}"""

def toggle_pill(page, chat, mid, emo):
    """Click sulla reazione `emo` sotto il messaggio, come in Teams: se è mia la toglie, altrimenti aggiunge la stessa."""
    if not emo or not clear_overlays(page) or not open_chat(page, chat): return False
    m = page.locator(f'[data-tid="chat-pane-message"][data-mid="{mid}"]')
    if m.count() == 0: return False
    m.evaluate("e => e.scrollIntoView({block:'center'})"); time.sleep(0.4)
    pt = page.evaluate(PILL_JS, [mid, emo])
    if not pt or not pt.get("found"): print("pill: reazione non trovata", mid, emo, flush=True); return False
    was = pt["pressed"]
    page.mouse.click(pt["x"], pt["y"]); page.mouse.move(2, 2)
    for _ in range(12):
        time.sleep(0.25)
        now = page.evaluate(PILL_JS, [mid, emo])
        if now and ((not now.get("found")) or now.get("pressed") != was): return True
    clear_overlays(page)
    print("pill: nessun cambio su Teams", mid, emo, flush=True); return False

def edit_message(page, chat, mid, text):
    """Modifica un mio messaggio. Ritorna True se il testo su Teams è quello nuovo."""
    text = (text or "").strip()
    if not text: return False
    if not clear_overlays(page): print("edit: finestra aperta sopra la chat", flush=True); return False
    if not open_chat(page, chat): return False
    item = page.locator(f'[data-tid="chat-pane-item"]:has([data-mid="{mid}"])')
    try:
        if not click_bar_button(page, mid, "message-actions-edit"): print("edit: pulsante non trovato", mid, flush=True); return False
        ed = item.locator('[data-tid="ckeditor"]').first
        ed.wait_for(timeout=4000); ed.click()
        page.keyboard.press("Control+A"); page.keyboard.press("Delete")
        page.keyboard.insert_text(text); time.sleep(0.2)
        item.locator('[data-tid="newMessageCommands-send"]').first.click(timeout=3000)
    except Exception as e:
        print("edit:", str(e).splitlines()[0][:120], flush=True)
        # annulla l'editor rimasto aperto senza toccare il messaggio
        try:
            item.locator('[data-tid="newMessageCommands-discard-draft"]').first.click(timeout=2000)
            page.locator('[data-tid="messagedraft-discard-confirm"]').click(timeout=2000)
        except Exception: pass
        return False
    finally:
        page.mouse.move(2, 2)
    for _ in range(16):
        time.sleep(0.25)
        cur = page.evaluate("""(mid)=>{const b=document.querySelector('#content-'+mid); return b?b.innerText.trim():null}""", mid)
        if cur is not None and cur.replace("\u00a0", " ").strip() == text: return True
    print("edit: testo non aggiornato su Teams", mid, flush=True); return False

SCROLL_ACTIVITY_JS = r"""()=>{ let e=document.querySelector('[data-tid="activity-feed-list-item"]');
  while(e && !(e.scrollHeight>e.clientHeight+5 && /auto|scroll/.test(getComputedStyle(e).overflowY))) e=e.parentElement;
  if(!e) return false; const b=e.scrollTop; e.scrollTop=b+e.clientHeight*0.8; return e.scrollTop>b; }"""

def read_activity(page):
    """Legge il feed Attività di Teams e torna alla chat aperta prima. Ritorna il numero di voci lette o None."""
    active = get_state("active_chat")
    items = None
    try:
        clear_overlays(page)
        page.locator('button[aria-label^="Activity"]:visible').first.click(timeout=4000)
        page.locator('[data-tid="activity-feed-list-item"]').first.wait_for(timeout=8000)
        time.sleep(0.5)
        # anche questa lista è virtualizzata: si scorre e si accumula per id
        acc, order = {}, []
        for _ in range(6):
            for a in page.evaluate(ACTIVITY_JS):
                k = a.get("id") or (a.get("title", "") + a.get("tm", ""))
                if k not in acc: order.append(k)
                acc[k] = a
            if len(order) >= 40: break
            moved = page.evaluate(SCROLL_ACTIVITY_JS)
            if not moved: break
            time.sleep(0.6)
        items = attach_avatars(page, [acc[k] for k in order][:40], limit=40)
    except Exception as e:
        print("activity:", str(e).splitlines()[0][:120], flush=True)
    finally:
        # si torna sempre a Chat: il resto dell'agent lavora sulla vista chat
        try:
            page.locator('button[aria-label^="Chat"]:visible').first.click(timeout=4000)
            page.locator('[role="treeitem"][aria-level="2"]').first.wait_for(timeout=8000)
            if active: open_chat(page, active)
        except Exception as e: print("activity back:", str(e).splitlines()[0][:120], flush=True)
    if not items: return None
    try:
        with dbc() as c:
            c.execute("DELETE FROM activity")
            for i, a in enumerate(items):
                c.execute("INSERT OR REPLACE INTO activity(id,pos,kind,actor,title,emoji,preview,tm,chat,channel,unread,ts,av) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (a.get("id") or f"x{i}", i, a.get("kind",""), a.get("actor",""), a.get("title",""), a.get("emoji",""), a.get("preview",""), a.get("tm",""), a.get("chat",""), 1 if a.get("channel") else 0, 1 if a.get("unread") else 0, int(time.time()), a.get("av","")))
        set_state("activity_ts", str(int(time.time())))
    except Exception as e: print("activity save:", e, flush=True)
    return len(items)

SCROLL_CHATS_JS = r"""(to)=>{ let e=document.querySelector('[role="treeitem"][aria-level="2"]');
  while(e && !(e.scrollHeight>e.clientHeight+5 && /auto|scroll/.test(getComputedStyle(e).overflowY))) e=e.parentElement;
  if(!e) return false; const b=e.scrollTop; e.scrollTop = (to==='top') ? 0 : b+e.clientHeight*0.8; return e.scrollTop!==b; }"""

def scan_chats_full(page):
    """Scorre tutta la lista chat di Teams (virtualizzata) e la salva completa e in ordine, poi torna in cima."""
    try:
        page.evaluate(SCROLL_CHATS_JS, "top"); time.sleep(0.4)
        acc, order = {}, []
        for _ in range(8):
            for ch in attach_avatars(page, page.evaluate(CHATS_JS), limit=20):
                if ch["name"] not in acc: order.append(ch["name"])
                acc[ch["name"]] = ch
            if len(order) >= 40 or not page.evaluate(SCROLL_CHATS_JS, "down"): break
            time.sleep(0.5)
        page.evaluate(SCROLL_CHATS_JS, "top")
        if not order: return
        save_chats([acc[n] for n in order][:40], replace=True)   # un'unica transazione: la lista non resta mai vuota
        set_state("last_scan_ts", str(int(time.time())))
    except Exception as e: print("chats full:", str(e).splitlines()[0][:120], flush=True)

def scan_chats(page):
    try:
        chats = page.evaluate(CHATS_JS)
        if not chats: return
        attach_avatars(page, chats)
        save_chats(chats)
        set_state("last_scan_ts", str(int(time.time())))
        for nm, pv in scan_new_messages(chats):
            print("NEWMSG:", nm, "|", pv[:50], flush=True)
            notify_msg(nm, pv)
    except Exception as e: print("chats:", e, flush=True)

def selfcheck_slot():
    now = datetime.now()
    slot = "am" if 8 <= now.hour < 11 else ("pm" if 17 <= now.hour < 20 else None)
    if not slot: return None
    key = "hc_" + now.strftime("%Y%m%d") + "_" + slot
    return None if get_state(key) == "1" else key

def main():
    # PID 1 nel container: senza handler SIGTERM viene ignorato e "docker stop" aspetta il timeout
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
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
        no_page_since=None
        while True:
            try:
                page=teams_page(ctx)
                if not page:
                    set_state("health", json.dumps({"cdp":"ok","teams":"loading","overall":"yellow","ts":int(time.time())}))
                    no_page_since = no_page_since or time.time()
                    # dopo un reload di Teams una connessione CDP può non vedere più la scheda: si riparte puliti
                    # (Docker riavvia il container, restart: unless-stopped)
                    if time.time() - no_page_since > 60:
                        print("scheda Teams non visibile da 60 s: riavvio l'agent", flush=True); os._exit(1)
                    time.sleep(3); continue
                no_page_since = None
                # login Microsoft in corso (account appena aggiunto o sessione scaduta): c'è solo da segnalarlo
                if not is_teams(page):
                    if tick % 5 == 0: update_health(page)
                    tick+=1; time.sleep(1); continue
                # dopo un reload Teams riparte senza chat aperta: si riapre quella in uso nella web app
                ac0 = get_state("active_chat")
                if ac0 and not page.evaluate(OPEN_CHAT_JS): open_chat(page, ac0)
                if page.evaluate(HOOK_JS)=="installed": print("hook ok", flush=True)
                for m in page.evaluate(DRAIN_JS):
                    t,b=m.get("title",""),m.get("body","")
                    if t==HEALTHTAG: continue
                    if re.match(r"(Nice job|Notifications are now on)", t or "", re.I): continue
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
                    elif ctype=="activity":
                        n=read_activity(page)
                        set_cmd_result(cid, "done" if n is not None else "failed")
                    elif ctype=="download":
                        try: args=json.loads(a2 or "{}")
                        except Exception: args={}
                        fn=download_file(page,a1,args.get("name",""))
                        if fn: set_state(f"cmd_result:{cid}", json.dumps({"f": fn}))
                        set_cmd_result(cid, "done" if fn else "failed")
                    elif ctype in ("reply","delete","undodelete"):
                        try: args=json.loads(a2 or "{}")
                        except Exception: args={}
                        if ctype=="reply": ok=reply_message(page,a1,args.get("mid",""),args.get("text",""))
                        elif ctype=="delete": ok=delete_message(page,a1,args.get("mid",""))
                        else: ok=undo_delete(page,a1,args.get("mid",""))
                        # prima si salva il nuovo stato, poi si conferma: la web app rilegge appena vede "done"
                        set_state("active_chat",a1); save_open_chat(page, a1)
                        set_cmd_result(cid, "done" if ok else "failed")
                    elif ctype in ("react","edit"):
                        # arg1 = chat, arg2 = JSON {mid, emoji|text}
                        try: args=json.loads(a2 or "{}")
                        except Exception: args={}
                        if ctype=="react" and args.get("pill"): ok=toggle_pill(page,a1,args.get("mid",""),args["pill"])
                        elif ctype=="react": ok=react_message(page,a1,args.get("mid",""),args.get("emoji",""))
                        else: ok=edit_message(page,a1,args.get("mid",""),args.get("text",""))
                        # prima si salva il nuovo stato, poi si conferma: la web app rilegge appena vede "done"
                        set_state("active_chat",a1); save_open_chat(page, a1)
                        set_cmd_result(cid, "done" if ok else "failed")
                    if ctype not in ("react","edit","download","activity","reply","delete","undodelete"): done_command(cid)
                    # i comandi possono durare secondi: la lista chat non deve restare ferma nel frattempo
                    scan_chats(page)
                # finché Teams non è connesso (login da fare o sessione scaduta) non c'è nulla da scorrere o leggere
                try: teams_ok = json.loads(get_state("health") or "{}").get("teams") == "ok"
                except Exception: teams_ok = False
                if tick % 300 == 1 and teams_ok: scan_chats_full(page)
                elif tick % 3 == 0: scan_chats(page)
                if tick % 150 == 5 and teams_ok: read_activity(page)
                if teams_ok and (tick % 300 == 7 or not get_state("me")): save_identity(page)
                if tick % 5 == 0:
                    update_health(page)
                ac=get_state("active_chat")
                if ac: save_open_chat(page, ac)
                if ac and teams_ok and tick % 2 == 0 and not pending_commands(): prefetch_readby(page, ac)
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
                try:
                    try: browser.close()        # chiude solo la connessione CDP, non il browser
                    except Exception: pass
                    browser=pw.chromium.connect_over_cdp(CDP); ctx=browser.contexts[0]
                except Exception: pass
            time.sleep(1)

if __name__=="__main__":
    main()
