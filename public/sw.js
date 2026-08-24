/*
 * Male Cyber Fighters progressive web app service worker.
 *
 * The arena is realtime, so navigations and API/socket requests always use
 * the network. Static assets can be reused while the app is being opened on
 * a poor connection, without serving stale chat or account data.
 */
const CACHE_NAME = 'cyber-fights-app-shell-v2';
const STATIC_ASSETS = [
  '/manifest.webmanifest',
  '/images/mcf.png',
  '/images/mcf-192.png',
  '/images/mcf-512.png',
  '/css/mobile.css',
  '/css/desktop.css',
  '/js/pwa-install.js',
  '/js/image-proxy.js',
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
  if (url.pathname === '/img') return;

  if (request.mode === 'navigate' || url.pathname.startsWith('/api/')) {
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
