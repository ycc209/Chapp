/*
 * Chapp's service worker: only the lock-screen notification when a timer ends (server/push.ts sends it at the end
 * time, so it arrives with the page closed or the phone locked). It caches nothing and handles no fetches, so the
 * app and Vite's dev server behave exactly as without it.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Timer-Done: "Incubation done · 30 min at 37 °C" / "Cool the plate to room temperature, then read at 562 nm."
self.addEventListener('push', event => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : '' };
  }
  const title = message.title || 'Time’s up';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: message.body || '',
      icon: '/chapp/chapp.webp',
      badge: '/chapp/chapp.webp',
      tag: message.tag || 'chapp-timer',
      renotify: true,
      requireInteraction: true,
      vibrate: [300, 120, 300, 120, 300],
      data: { url: message.url || '/' },
    }),
  );
});

// Open Chapp: bring an open window to the read step, or open one there.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
      const open = windows.find(w => new URL(w.url).origin === self.location.origin);
      if (open) return open.focus().then(w => (w && 'navigate' in w ? w.navigate(url) : w));
      return self.clients.openWindow(url);
    }),
  );
});
