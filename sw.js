/* Simple Kanban service worker — offline app shell.
 *
 * The whole app is one HTML file plus a handful of images, so the shell list can be
 * written by hand. Strategy is network-first for the document (a deploy is picked up on
 * the next online load) and cache-first for the images (they only change when the
 * version below does).
 *
 * Bump CACHE whenever index.html or any listed asset changes, otherwise installed
 * copies keep serving the old shell.
 */
const CACHE = 'simple-kanban-v1.1.0';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './simple-kanban-logo.gif',
  './favicon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // cache:'no-store' so a reinstall can't re-cache a stale copy out of the browser's
      // own HTTP cache — the usual cause of a half-updated app.
      Promise.all(SHELL.map((u) =>
        fetch(u, { cache: 'no-store' })
          .then((r) => (r && r.ok ? c.put(u, r.clone()) : null))
          .catch(() => null)
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  e.respondWith(
    caches.match(request).then((hit) =>
      hit || fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
    )
  );
});
