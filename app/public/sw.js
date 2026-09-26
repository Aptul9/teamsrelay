self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// lines of a chat kept in its notification
const LINES = 5;

self.addEventListener('push', event => {
  let d = { title: 'TeamsRelay', body: '' };
  try { d = event.data.json(); } catch (_) { try { d.body = event.data.text(); } catch (__) {} }
  event.waitUntil(show(d));
});

// A chat has one notification: a new message replaces it, alerts again and keeps the last lines. A push without a
// tag (checks, session expired) gets a notification of its own.
async function show(d) {
  const title = d.title || 'TeamsRelay';
  const base = { icon: '/static/icon-192.png', badge: '/static/icon-192.png' };
  if (!d.tag) return self.registration.showNotification(title, { ...base, body: d.body || '', tag: 'teams-' + Date.now(), data: d });
  const [shown] = await self.registration.getNotifications({ tag: d.tag });
  const lines = [...((shown && shown.data && shown.data.lines) || []), d.body || ''].filter(Boolean).slice(-LINES);
  return self.registration.showNotification(title, { ...base, body: lines.join('\n'), tag: d.tag, renotify: true, data: { ...d, lines } });
}

// the notification opens the app on the account it comes from (acc = slot)
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const acc = (event.notification.data || {}).acc;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cl => {
    for (const c of cl) {
      if ('focus' in c) { if (acc) c.postMessage({ acc }); return c.focus(); }
    }
    if (clients.openWindow) return clients.openWindow(acc ? '/?a=' + acc : '/');
  }));
});
