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
  event.waitUntil(shown);
});

// A chat has one notification: a new message replaces it, alerts again and keeps the last lines. A line it already
// holds (the same push sent again) changes nothing. A push without a tag (checks, session expired) gets a
// notification of its own.
async function show(d) {
  const title = d.title || 'TeamsRelay';
  const base = { icon: '/static/icon-192.png', badge: '/static/icon-192.png' };
  if (d.call) return showCall(title, d, base);
  if (!d.tag) return self.registration.showNotification(title, { ...base, body: d.body || '', tag: 'teams-' + Date.now(), data: d });
  const [shown] = await self.registration.getNotifications({ tag: d.tag });
  const before = (shown && shown.data && shown.data.lines) || [];
  const again = !!d.body && before.includes(d.body);
  const lines = again ? before : [...before, d.body || ''].filter(Boolean).slice(-LINES);
  return self.registration.showNotification(title, { ...base, body: lines.join('\n'), tag: d.tag, renotify: !again, data: { ...d, lines } });
}

// An incoming call has one notification per account. While it rings it stays on screen, vibrates and alerts again at
// every push (the agent pushes every few seconds); the Open button keeps it on screen on Windows, which ignores
// requireInteraction without a button. When the call stops the same notification turns quiet. The sound is the
// device's: a web page cannot choose it.
function showCall(title, d, base) {
  const ringing = d.call === 'ringing';
  return self.registration.showNotification(title, {
    ...base,
    body: d.body || '',
    tag: d.tag || 'call',
    data: d,
    timestamp: d.ts || Date.now(),
    renotify: ringing,
    requireInteraction: ringing,
    silent: !ringing,
    ...(ringing && { vibrate: [500, 250, 500, 250, 500], actions: [{ action: 'open', title: 'Open' }] }),
  });
}

// the notification opens the app on the account it comes from (acc = slot, web app), or on its chat (local relay)
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const d = event.notification.data || {};
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
