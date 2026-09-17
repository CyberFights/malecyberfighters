/*
 * Male Cyber Fighters progressive web app service worker.
 *
 * The arena is realtime, so navigations, API/socket requests, and the
 * live JS/CSS that build chat UI always use the network. Only icons and
 * the offline page are reused from cache.
 */
const CACHE_NAME = 'cyber-fights-app-shell-v5';
const STATIC_ASSETS = [
  '/manifest.webmanifest',
  '/images/mcf-180.png',
  '/images/mcf-192.png',
  '/images/mcf-512.png',
  '/offline.html'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function isLiveAsset(pathname) {
  return pathname.startsWith('/js/')
    || pathname.startsWith('/css/')
    || pathname === '/sw.js';
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Do not cache the live application document. The server chooses the
  // desktop/mobile stylesheet from the request and the page contains live
  // updates, auth UI and realtime chat.
  // Proxied remote images (/img?u=...) are already cached by the HTTP layer and
  // would otherwise grow the app-shell cache without bound.
  // Clips (GIFs / short videos) are large media files — HTTP headers cache
  // them, so keep them out of the app-shell cache as well.
  if (url.pathname === '/img' || url.pathname.startsWith('/clips/')) return;

  if (
    request.mode === 'navigate'
    || url.pathname.startsWith('/api/')
    || isLiveAsset(url.pathname)
  ) {
    event.respondWith(
      fetch(request).catch(() => {
        if (request.mode === 'navigate') return caches.match('/offline.html');
        return Response.error();
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        return response;
      });
    })
  );
});

/* ----------------------------------------------------------------------
   Push notifications.

   The server only pushes when a DM reaches no live socket of the member's —
   the tab is closed, the laptop asleep — which is exactly when a notification
   is worth interrupting for. The payload carries who wrote and nothing else:
   never the message text, because a notification body can appear on a lock
   screen and is relayed through a third-party push service.
   ---------------------------------------------------------------------- */
self.addEventListener('push', event => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (err) {
      // Not JSON: fall back to the raw text rather than dropping the alert.
      payload = { title: 'Male Cyber Fighters', body: event.data.text() };
    }
  }

  const title = payload.title || 'Male Cyber Fighters';
  const options = {
    body: payload.body || 'You have a new notification.',
    icon: '/images/mcf-192.png',
    badge: '/images/mcf-180.png',
    // Same sender replaces its own unread notification instead of stacking one
    // per message.
    tag: payload.tag || 'mcf-push',
    renotify: false,
    data: payload.data || { url: '/' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // Bring an existing window forward rather than opening a second arena.
        for (const client of clientList) {
          if (client.url && new URL(client.url).origin === self.location.origin && 'focus' in client) {
            client.navigate(target);
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      })
  );
});
