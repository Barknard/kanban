/* Simple Kanban service worker — offline app shell.
 *
 * The whole app is one HTML file plus a handful of images, so the shell list can be
 * written by hand. Strategy is network-first for the document (a deploy is picked up on
 * the next online load) and cache-first for the images (they only change when the
 * version below does).
 *
 * CACHE is a fingerprint of the shell files, written by tools/sync-sw-version.mjs — do
 * NOT edit it by hand. A hand-maintained version string was forgotten exactly once and
 * every returning visitor kept getting the previous page while the server served the
 * new one. `npm test` fails if this is out of date.
 */
const CACHE = 'simple-kanban-d4a19847a9b8';
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
      // cache:'no-cache' revalidates with the server instead of accepting the browser's
      // HTTP-cached copy. GitHub Pages sends index.html with a ten-minute max-age, so a
      // plain fetch here is "network-first" in name only — it returns the same stale
      // page the user is trying to escape.
      fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' })
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
