// Service worker: precache the app shell so the catalog opens with no
// connection. Metadata lookups stay network-only; covers and fonts are cached
// as they're fetched.

const VERSION = 'stacks-v20';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/db.js',
  'js/lookup.js',
  'js/scanner.js',
  'js/locations.js',
  'js/sync.js',
  'js/value.js',
  'js/identify.js',
  'js/lock.js',
  'vendor/zxing.min.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const CACHEABLE_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'covers.openlibrary.org',
  'coverartarchive.org',
  'archive.org', // Cover Art Archive redirects resolve here
  'books.google.com',
];

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  if (url.origin === location.origin) {
    // App shell: cache-first, refresh in the background.
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const refresh = fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        }).catch(() => hit);
        return hit || refresh;
      })
    );
    return;
  }

  if (CACHEABLE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
    // Covers and fonts: cache-first, fetched once.
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      }))
    );
  }
  // Everything else (API lookups): straight to the network.
});
