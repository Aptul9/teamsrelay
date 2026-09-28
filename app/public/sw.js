self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// lines of a chat kept in its notification
const LINES = 5;

// pushes arriving together (a phone back online) are shown one after the other: two of one chat read and write
// the same notification
let queue = Promise.resolve();

self.addEventListener('push', event => {
  let d = { title: 'TeamsRelay', body: '' };
  try { d = event.data.json(); } catch (_) { try { d.body = event.data.text(); } catch (__) {} }
  const shown = queue.then(() => show(d));
  queue = shown.catch(() => undefined);
  event.waitUntil(Promise.all([shown, badge(d)]));
});

// While a window of the installed app is on screen, the app keeps the number of what waits on its icon (App.tsx). With
// none on screen a push puts a dot there, until the app shows the number again; a call that ended adds nothing. Pushes
// of the local relay (no acc) put none: its page never takes a dot away.
async function badge(d) {
  if (!d.acc || d.call === 'ended' || !self.navigator || !self.navigator.setAppBadge) return;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (windows.some(w => w.visibilityState === 'visible')) return;
  try { await self.navigator.setAppBadge(); } catch (_) {}
}

// A chat has one notification: a new message replaces it, alerts again and keeps the last lines. A line it already
// holds (the same push sent again) changes nothing. A push without a tag (checks, missed calls, session expired) gets
// a notification of its own. What alerts rings the bell of the app when a window of it plays one, quietly then.
async function show(d) {
  const title = d.title || 'TeamsRelay';
  const base = { icon: '/static/icon-192.png', badge: '/static/icon-192.png' };
  if (d.call) return showCall(title, d, base);
  if (!d.tag) {
    const quiet = await bellRung();
    return self.registration.showNotification(title, { ...base, body: d.body || '', tag: 'teams-' + Date.now(), data: d, ...(quiet && { silent: true }) });
  }
  const [shown] = await self.registration.getNotifications({ tag: d.tag });
  const before = (shown && shown.data && shown.data.lines) || [];
  const again = !!d.body && before.includes(d.body);
  const lines = again ? before : [...before, d.body || ''].filter(Boolean).slice(-LINES);
  const quiet = !again && (await bellRung());
  return self.registration.showNotification(title, { ...base, body: lines.join('\n'), tag: d.tag, renotify: !again, data: { ...d, lines }, ...(quiet && { silent: true }) });
}

// milliseconds a window of the app has to say whether it played the bell
const BELL_WAIT = 500;

// A page cannot give a notification a sound of its own: while a window of the app is open, its page rings the bell of
// messages (App.tsx) and the notification comes quiet. The windows are asked one at a time, the ones on screen first,
// until one plays it: one bell per message. With no window, or none that plays it in time (a tab not clicked since it
// loaded may play no sound, a page the browser froze does not answer), the notification keeps the sound of the device.
async function bellRung() {
  let windows = [];
  try {
    windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  } catch (_) {}
  const order = [...windows.filter(w => w.visibilityState === 'visible'), ...windows.filter(w => w.visibilityState !== 'visible')];
  for (const w of order) if (await askBell(w)) return true;
  return false;
}

// No account in the message: one with an account switches the account on screen
function askBell(w) {
  return new Promise(resolve => {
    let ch;
    try {
      ch = new MessageChannel();
    } catch (_) {
      return resolve(false);
    }
    let timer;
    const done = played => {
      clearTimeout(timer);
      ch.port1.onmessage = null;
      ch.port1.close();
      resolve(played);
    };
    timer = setTimeout(() => done(false), BELL_WAIT);
    ch.port1.onmessage = e => done(!!(e.data && e.data.played));
    try {
      w.postMessage({ type: 'bell' }, [ch.port2]);
    } catch (_) {
      done(false);
    }
  });
}

// An incoming call has one notification per account. While it rings it stays on screen, vibrates and alerts again at
// every push (the agent pushes every few seconds); the Open button keeps it on screen on Windows, which ignores
// requireInteraction without a button. When the call stops the same notification turns quiet. A late push (a retry,
// or a push service that delivers out of order) changes nothing: one of an older call (ts), or a ringing one of a
// call already ended, shows the notification there again, quiet. The sound is the device's: a page cannot choose it.
async function showCall(title, d, base) {
  const tag = d.tag || 'call';
  const [shown] = await self.registration.getNotifications({ tag });
  const old = shown && shown.data;
  if (old && old.call && ((old.ts || 0) > (d.ts || 0) || (old.ts === d.ts && old.call === 'ended' && d.call === 'ringing'))) {
    return self.registration.showNotification(shown.title, { ...base, ...callOptions(old, false), body: shown.body, tag });
  }
  return self.registration.showNotification(title, { ...base, ...callOptions(d, d.call === 'ringing'), body: d.body || '', tag });
}

// alert: sound, vibration and again when replaced; a call still ringing stays on screen with its button either way,
// Answer first where the account can answer from the app (answer)
function callOptions(d, alert) {
  const ringing = d.call === 'ringing';
  const open = { action: 'open', title: 'Open' };
  return {
    data: d,
    timestamp: d.ts || Date.now(),
    renotify: alert,
    requireInteraction: ringing,
    silent: !alert,
    ...(ringing && { actions: d.answer ? [{ action: 'answer', title: 'Answer' }, open] : [open] }),
    ...(alert && { vibrate: [500, 250, 500, 250, 500] }),
  };
}

// Answer: the server queues the answer of that call (ts = since), then the remote desktop of the account opens for its
// sound; a call that no longer rings, or a server out of reach, opens the app on the account
function answerCall(d) {
  return fetch('/api/call/answer?a=' + d.acc, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ since: d.ts }),
  })
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null)
    .then(j => clients.openWindow(j && j.desktop ? j.desktop : '/?a=' + d.acc));
}

// the notification opens the app on the account it comes from (acc = slot, web app), or on its chat (local relay)
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const d = event.notification.data || {};
  if (event.action === 'answer' && d.acc && d.call === 'ringing') {
    event.waitUntil(answerCall(d));
    return;
  }
  const acc = d.acc;
  const chat = acc ? '' : d.chat || '';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cl => {
    for (const c of cl) {
      if ('focus' in c) {
        if (acc) c.postMessage({ acc });
        else if (chat) c.postMessage({ chat });
        return c.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(acc ? '/?a=' + acc : chat ? '/#chat=' + encodeURIComponent(chat) : '/');
  }));
});
