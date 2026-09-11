const CACHE_NAME = 'vienna-rail-shell-v1';

self.addEventListener('install', (event) => {
  const scope = self.registration.scope;
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([
    scope,
    `${scope}index.html`,
    `${scope}manifest.webmanifest`,
    `${scope}favicon.svg`,
    `${scope}icons/pwa-192.svg`,
    `${scope}icons/pwa-512.svg`,
  ])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
  )));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Navigation prefers fresh HTML so a deployment becomes visible promptly;
  // the cached shell keeps the installed app opening during a brief outage.
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request).then((cached) => cached || caches.match(`${self.registration.scope}index.html`))));
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok && url.pathname.includes('/assets/')) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    }
    return response;
  })));
});
