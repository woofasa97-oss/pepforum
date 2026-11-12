/* global self */
/* Pepforums service worker: web push only. Nothing is cached or intercepted —
   private pages and API responses must always come from the server. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    return;
  }
  const title = typeof data.title === 'string' ? data.title.slice(0, 120) : 'Pepforums';
  let url = '/notifications';
  try {
    const candidate = new URL(data.url || '/notifications', self.location.origin);
    if (candidate.origin === self.location.origin) url = candidate.pathname + candidate.search + candidate.hash;
  } catch {
    /* keep default */
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body.slice(0, 240) : '',
      icon: '/icon.png',
      tag: typeof data.tag === 'string' ? data.tag : 'pepforum',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/notifications';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => 'focus' in w);
      if (open) {
        open.navigate(url);
        return open.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
