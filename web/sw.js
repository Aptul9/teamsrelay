self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = { title: 'Teams', body: '' };
  try { d = event.data.json(); } catch { try { d.body = event.data.text(); } catch { /* no payload */ } }
  event.waitUntil(self.registration.showNotification(d.title || 'Teams', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'teams-' + Date.now(),
    data: d
  }));
});

// the notification opens the app on the chat it comes from
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const chat = (event.notification.data || {}).chat || '';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cl => {
    for (const c of cl) {
      if ('focus' in c) { if (chat) c.postMessage({ chat }); return c.focus(); }
    }
    if (clients.openWindow) return clients.openWindow(chat ? '/#chat=' + encodeURIComponent(chat) : '/');
  }));
});
