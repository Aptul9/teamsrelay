// TeamsRelay app: the chats the relay reads from Teams, one chat, and send, reply, react, edit, delete. Messages are
// always inserted as text, never as HTML. The token of the relay stays in this browser (localStorage).
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REACTIONS = [["like", "👍"], ["heart", "❤️"], ["laugh", "😂"], ["surprised", "😮"], ["cry", "😢"], ["angry", "😠"]];
const TOKEN_KEY = "teamsrelay-token";

const saved = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  },
  set(v) {
    try {
      localStorage.setItem(TOKEN_KEY, v);
    } catch {
      // storage refused (private window): the token lasts for this visit
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      // nothing stored
    }
  },
};

let token = saved.get();
let state = null;
let current = "";
let compose = null;
const media = new Map();

class Unauthorized extends Error {}
// no answer at all: what was sent may or may not have reached the relay
class Offline extends Error {}

async function api(path, { method = "GET", body } = {}) {
  let r;
  try {
    r = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Offline("The relay does not answer: check the connection");
  }
  if (r.status === 401) throw new Unauthorized("Wrong token");
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `The relay answered ${r.status}`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false && c !== ""));
  return e;
}

let toastTimer = 0;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

function show(view) {
  for (const v of ["signin", "list", "chat"]) $(v).hidden = v !== view;
}

// A wrong token signs out; anything else is shown
function failed(e) {
  if (e instanceof Unauthorized) {
    token = "";
    saved.clear();
    show("signin");
    return;
  }
  toast(e.message);
}

// ---- sign-in

$("token-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = $("token").value.trim();
  try {
    await api("/api/state");
    saved.set(token);
    $("token").value = "";
    $("signin-error").textContent = "";
    start();
  } catch (err) {
    $("signin-error").textContent = err instanceof Unauthorized ? "Wrong token" : err.message;
  }
});

// ---- chats

function statusLine(h, me) {
  if (!h || h.agent !== "ok") return "The relay is not reading Teams";
  if (h.browser === "down") return "The relay browser does not start";
  if (h.teams === "login") return "Teams signed out: sign in again in the relay window";
  if (h.teams === "loading") return "Teams is loading";
  if (h.watcher === "stale") return "Chat list not read for over a minute";
  return me.email || "Connected";
}

async function refresh() {
  try {
    state = await api("/api/state");
  } catch (e) {
    if (e instanceof Unauthorized) return failed(e);
    $("status-dot").className = "dot red";
    $("status-text").textContent = "Relay not reachable";
    return;
  }
  const h = state.health;
  $("status-dot").className = `dot ${h.overall || ""}`;
  $("me-name").textContent = state.me.name || "TeamsRelay";
  $("status-text").textContent = statusLine(h, state.me);
  renderChats();
  renderPush();
}

const initials = (name) =>
  name
    .replace(/\(.*?\)/g, "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

function renderChats() {
  const rows = state.chats.map((c) => {
    const button = el(
      "button",
      { class: `chat-row${c.unread ? " unread" : ""}`, type: "button" },
      el("span", { class: "avatar", "aria-hidden": "true" }, initials(c.name) || "?"),
      el("span", { class: "chat-name" }, c.name),
      el("span", { class: "chat-time" }, c.time),
      el("span", { class: "chat-preview" }, c.preview),
      el("span", { class: "chat-flags" }, c.muted ? "muted" : "", c.unread ? el("span", { class: "badge", "aria-label": "unread" }) : ""),
    );
    button.addEventListener("click", () => (location.hash = `chat=${encodeURIComponent(c.name)}`));
    return el("li", {}, button);
  });
  $("chats").replaceChildren(...rows);
  $("chats-empty").hidden = rows.length > 0;
}

// ---- one chat

async function openChat(name) {
  const fresh = current !== name;
  current = name;
  show("chat");
  $("chat-name").textContent = name;
  if (fresh) {
    setCompose(null);
    $("messages").replaceChildren();
    $("chat-state").textContent = "";
  }
  const shown = await loadMessages();
  if (shown?.open) return;
  // Teams opens the chat and the relay saves what it shows; the messages saved before are shown meanwhile
  $("chat-state").textContent = "Opening in Teams...";
  try {
    await command({ type: "open", chat: name });
  } catch (e) {
    failed(e);
  }
  if (current !== name) return;
  // open ends done even when Teams could not show the chat: what counts is the chat Teams has open now
  const after = await loadMessages();
  if (current === name) $("chat-state").textContent = after?.open ? "" : "Teams did not open this chat: messages may be old";
}

function closeChat() {
  current = "";
  setCompose(null);
  show("list");
  refresh();
}

async function loadMessages() {
  const chat = current;
  if (!chat) return null;
  try {
    const r = await api(`/api/messages?chat=${encodeURIComponent(chat)}`);
    if (r.chat === current) renderMessages(r.messages);
    return r;
  } catch (e) {
    if (e instanceof Unauthorized) failed(e);
    return null;
  }
}

// Runs `change` and keeps the last message in view if it was: the list shrinks when the compose box grows
function keepBottom(change) {
  const box = $("messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  change();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderMessages(list) {
  keepBottom(() => $("messages").replaceChildren(...list.map(messageItem)));
}

function messageItem(m) {
  const li = el("li", { class: `msg${m.mine ? " mine" : ""}${m.deleted ? " deleted" : ""}${m.mentionsMe ? " mentions" : ""}`, tabindex: "0" });
  if (!m.mine && m.author) li.append(el("div", { class: "author" }, m.author));
  if (m.quote) li.append(el("blockquote", {}, `${m.quote.author}: ${m.quote.text}`));
  if (m.deleted) li.append(el("div", { class: "text" }, "Message deleted"));
  else if (m.text) li.append(el("div", { class: "text" }, m.text));
  for (const image of m.images) li.append(imageItem(image));
  for (const f of m.files) li.append(el("div", { class: "file" }, `File: ${f.name}`));
  const meta = [m.reactions.map((r) => `${r.e}${r.n > 1 ? r.n : ""}`).join(" "), m.edited ? "Edited" : "", m.mine ? m.status : ""].filter(Boolean);
  if (meta.length) li.append(el("div", { class: "meta" }, meta.join(" · ")));
  const act = () => openSheet(m);
  li.addEventListener("click", act);
  li.addEventListener("keydown", (e) => e.key === "Enter" && act());
  return li;
}

// Images saved by the relay come with the token, as a blob; others stay a link (the page loads nothing from outside)
function imageItem(image) {
  if (!image.f) return image.url ? el("a", { class: "ext", href: image.url, target: "_blank", rel: "noopener noreferrer" }, "Image (opens outside the app)") : "";
  const img = el("img", { alt: "Image", width: String(image.w || 320), height: String(image.h || 240) });
  const known = media.get(image.f);
  if (known) img.src = known;
  else
    fetch(`/media/${image.f}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!b) return;
        const url = URL.createObjectURL(b);
        media.set(image.f, url);
        img.src = url;
      })
      .catch(() => undefined);
  return img;
}

// ---- actions

// Keys of the commands whose outcome is not known yet, by command. A command sent again after its answer got lost
// (the app tries again by itself, or the same text is sent again) carries the same key: the relay queues it once.
// Once the outcome is known the key goes: the same text sent again later is a new message.
const keys = new Map();
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

// Queues the command and waits for Teams: done, failed, unconfirmed (it may have reached Teams), or pending or
// running when it takes too long
async function command(body) {
  const what = JSON.stringify(body);
  if (!keys.has(what)) keys.set(what, newKey());
  const key = keys.get(what);
  let r = null;
  for (let attempt = 1; !r; attempt++) {
    try {
      r = await api("/api/cmd", { method: "POST", body: { ...body, key } });
    } catch (e) {
      if (!(e instanceof Offline) || attempt === 3) throw e;
      await sleep(1500);
    }
  }
  let { id, status } = r;
  const end = Date.now() + 90_000;
  while ((status === "pending" || status === "running") && Date.now() < end) {
    await sleep(1500);
    try {
      ({ status } = await api(`/api/cmd/${id}`));
    } catch (e) {
      if (!(e instanceof Offline)) throw e;
    }
  }
  if (status === "done" || status === "failed" || status === "unconfirmed") keys.delete(what);
  return status;
}

async function act(label, body) {
  closeSheet();
  toast(`${label}...`);
  try {
    const status = await command(body);
    toast(
      status === "done"
        ? `${label}: done`
        : status === "failed"
          ? `${label}: not applied on Teams`
          : status === "unconfirmed"
            ? `${label}: Teams did not confirm it, check the chat before trying again`
            : `${label}: still waiting for Teams`,
    );
  } catch (e) {
    failed(e);
  }
  await loadMessages();
}

function setCompose(next) {
  compose = next;
  keepBottom(() => {
    $("compose-context").hidden = !next;
    if (!next) return;
    const snippet = (next.m.text || "").slice(0, 80);
    $("compose-label").textContent = next.kind === "reply" ? `Reply to ${next.m.author || "you"}: ${snippet}` : "Edit message";
    if (next.kind === "edit") $("text").value = next.m.text;
    autosize();
  });
  if (next) $("text").focus();
}

function openSheet(m) {
  $("sheet-text").textContent = m.deleted ? "Message deleted" : m.text || (m.images.length ? "Image" : "");
  const mine = new Set(m.reactions.filter((r) => r.mine).map((r) => r.e));
  $("sheet-reactions").replaceChildren(
    ...(m.deleted
      ? []
      : REACTIONS.map(([name, emoji]) => {
          const b = el("button", { type: "button", class: mine.has(emoji) ? "mine" : "", "aria-label": `React ${name}` }, emoji);
          b.addEventListener("click", () => act("Reaction", { type: "react", chat: current, mid: m.mid, emoji: name }));
          return b;
        })),
  );
  const actions = [];
  const add = (label, run, cls = "") => {
    const b = el("button", { type: "button", class: cls }, label);
    b.addEventListener("click", run);
    actions.push(b);
  };
  if (!m.deleted) {
    add("Reply", () => {
      closeSheet();
      setCompose({ kind: "reply", m });
    });
    if (m.text) add("Copy text", () => navigator.clipboard?.writeText(m.text).then(() => toast("Copied")).finally(closeSheet));
  }
  if (m.mine && !m.deleted) {
    add("Edit", () => {
      closeSheet();
      setCompose({ kind: "edit", m });
    });
    add("Delete", () => act("Delete", { type: "delete", chat: current, mid: m.mid }), "danger");
  }
  if (m.mine && m.deleted) add("Undo delete", () => act("Undo", { type: "undodelete", chat: current, mid: m.mid }));
  $("sheet-actions").replaceChildren(...actions);
  $("sheet").hidden = false;
}

function closeSheet() {
  $("sheet").hidden = true;
}

$("sheet-cancel").addEventListener("click", closeSheet);
$("sheet").addEventListener("click", (e) => e.target === $("sheet") && closeSheet());
$("back").addEventListener("click", () => (location.hash = ""));
$("compose-cancel").addEventListener("click", () => {
  if (compose?.kind === "edit") $("text").value = "";
  setCompose(null);
});

function autosize() {
  const t = $("text");
  t.style.height = "auto";
  t.style.height = `${t.scrollHeight}px`;
}
$("text").addEventListener("input", () => keepBottom(autosize));
$("text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("composer").requestSubmit();
});

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("text").value;
  if (!text.trim() || !current) return;
  const body =
    compose?.kind === "reply"
      ? { type: "reply", chat: current, mid: compose.m.mid, text }
      : compose?.kind === "edit"
        ? { type: "edit", chat: current, mid: compose.m.mid, text }
        : { type: "send", chat: current, text };
  $("send").disabled = true;
  try {
    const status = await command(body);
    // unconfirmed: it may be in the chat already, the text goes so that it is not sent twice by mistake
    if (status === "done" || status === "unconfirmed") {
      $("text").value = "";
      setCompose(null);
      autosize();
    }
    if (status === "unconfirmed") toast("Teams did not confirm the message: check the chat before sending it again");
    else if (status === "failed") toast("Not sent on Teams: the text is still here");
    else if (status !== "done") toast("Still waiting for Teams: sending it again does not send it twice");
  } catch (err) {
    failed(err);
  } finally {
    $("send").disabled = false;
  }
  await loadMessages();
});

// ---- notifications

const bytes = (b64) => {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const sameKey = (buffer, b64) => !!buffer && bytes(b64).join() === new Uint8Array(buffer).join();
const iphoneTab = () => /iPhone|iPad/i.test(navigator.userAgent) && !window.matchMedia("(display-mode: standalone)").matches && !navigator.standalone;

async function subscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function renderPush() {
  const on = !!(await subscription().catch(() => null)) && Notification.permission === "granted";
  $("push-btn").textContent = on ? "Notifications on" : "Notifications";
  $("push-btn").classList.toggle("on", on);
}

async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || iphoneTab()) {
    throw new Error(iphoneTab() ? 'On iPhone notifications reach only the installed app: Share, "Add to Home Screen", then open it from there.' : "This browser cannot receive push notifications.");
  }
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked in the browser settings.");
  const { key } = await api("/api/vapid");
  if (!key) throw new Error("Push is off on the relay: run npm run relay:setup there.");
  let sub = await reg.pushManager.getSubscription();
  // subscribed with keys the relay no longer has: it would never receive anything
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
  const r = await api("/api/push", { method: "POST", body: sub.toJSON() });
  toast(`Notifications on (${r.devices} device${r.devices === 1 ? "" : "s"})`);
}

$("push-btn").addEventListener("click", async () => {
  try {
    await enablePush();
  } catch (e) {
    failed(e);
  }
  renderPush();
});

// ---- menu

$("menu-btn").addEventListener("click", () => {
  $("sheet-text").textContent = state?.me?.email ? `Teams account: ${state.me.email}` : "TeamsRelay";
  $("sheet-reactions").replaceChildren();
  const item = (label, run, cls = "") => {
    const b = el("button", { type: "button", class: cls }, label);
    b.addEventListener("click", run);
    return b;
  };
  $("sheet-actions").replaceChildren(
    item("Test notification (full check, answer as a push)", () => act("Check", { type: "recheck" })),
    item("Read the chats again", () => act("Resync", { type: "resync" })),
    item(
      "Sign out of this app",
      () => {
        closeSheet();
        token = "";
        saved.clear();
        show("signin");
      },
      "danger",
    ),
  );
  $("sheet").hidden = false;
});

// ---- start

function route() {
  const m = /^#chat=(.+)$/.exec(location.hash);
  if (m) openChat(decodeURIComponent(m[1]));
  else closeChat();
}

let started = false;
function start() {
  if (!started) {
    started = true;
    window.addEventListener("hashchange", route);
    // the notification tapped while the app is open names its chat
    navigator.serviceWorker?.addEventListener("message", (e) => {
      if (e.data?.chat) location.hash = `chat=${encodeURIComponent(e.data.chat)}`;
    });
    setInterval(() => {
      if (document.hidden || !token) return;
      if (current) loadMessages();
      else refresh();
    }, 4000);
    document.addEventListener("visibilitychange", () => !document.hidden && token && (current ? loadMessages() : refresh()));
    // keeps the service worker of this page current; it only shows notifications
    navigator.serviceWorker?.register("/sw.js").catch(() => undefined);
  }
  route();
}

if (token) start();
else show("signin");
