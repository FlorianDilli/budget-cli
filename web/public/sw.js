// Cache only the built shell and its declared assets, never runtime requests.
const PREFIX = 'moonli-shell-';
const CACHE = PREFIX + (new URL(self.location.href).searchParams.get('v') || 'initial');
const base = self.registration.scope;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const response = await fetch(new URL('index.html', base), { cache: 'no-store' });
    if (!response.ok) throw new Error('Cannot load app shell');
    const html = await response.clone().text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => new URL(match[1], base))
      .filter((url) => url.origin === self.location.origin && url.pathname.startsWith(new URL(base).pathname + 'assets/'))
      .map((url) => url.href);
    const cache = await caches.open(CACHE);
    await cache.put(new URL('index.html', base), response);
    await cache.addAll([...new Set([...assets, new URL('logo.svg', base).href, new URL('manifest.webmanifest', base).href])]);
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key)),
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search) return;
  const scope = new URL(base).pathname;
  if (!url.pathname.startsWith(scope)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then((cache) => cache.match(new URL('index.html', base)))));
  } else {
    event.respondWith(caches.open(CACHE).then((cache) => cache.match(event.request)).then((response) => response || fetch(event.request)));
  }
});
