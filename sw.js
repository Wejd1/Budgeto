// Service worker: aplikacja otwiera się bez internetu. Dane z Google NIE są tu cache'owane
// (trzyma je aplikacja w localStorage). Po zmianie plików podbij VERSION.
const VERSION = 'budzet-v1.2.0';
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/auth.js',
  'js/budget.js',
  'js/config.js',
  'js/demo.js',
  'js/format.js',
  'js/planned.js',
  'js/schema.js',
  'js/seed.js',
  'js/sheets.js',
  'js/store.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Najpierw sieć (żeby zawsze mieć najnowszą wersję), a gdy jej brak — kopia z pamięci.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
