// LocalHire service worker: receives Web Push messages and shows them as system notifications.
// It does no caching and no offline handling; it exists only for push. Served from the site root so its scope covers the app.
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Only same-origin, relative app paths are ever opened from a notification.
const safeUrl = (u) => (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? u : '/pages/notifications.html');

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'LocalHire', body: event.data ? event.data.text() : '' }; }
  const title = String(data.title || 'LocalHire').slice(0, 100);
  event.waitUntil((async () => {
    // If the person is already looking at LocalHire, the in-app notification is enough: do not also pop a system one.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((c) => c.visibilityState === 'visible' && c.focused)) return;
    await self.registration.showNotification(title, {
      body: String(data.body || '').slice(0, 160),
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: '/favicon.ico',
      data: { url: safeUrl(data.url), bookingId: data.bookingId || null }
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(safeUrl(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if (w.url.startsWith(self.location.origin) && 'focus' in w) {
        await w.focus();
        if ('navigate' in w) { try { await w.navigate(target); } catch (e) { /* cross-origin or detached */ } }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

// The browser rotated or invalidated the subscription: tell any open page so it can subscribe again.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => ws.forEach((w) => w.postMessage({ type: 'push-subscription-changed' }))));
});
