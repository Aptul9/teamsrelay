self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = { title: 'TeamsRelay', body: '' };
  try { d = event.data.json(); } catch (_) { try { d.body = event.data.text(); } catch (__) {} }
  event.waitUntil(self.registration.showNotification(d.title || 'TeamsRelay', {
    body: d.body || '',
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
    tag: 'teams-' + Date.now(),
    data: d
  }));
});

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
