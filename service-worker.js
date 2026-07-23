// Bumping CACHE_NAME forces the app shell to refresh on next load.
const CACHE_NAME = 'ctorq-workflow-v3.4';
const SUPABASE_SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  SUPABASE_SDK_URL
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// App shell (+ the pinned Supabase SDK script): cache-first, so the app
// opens instantly with no connection. Everything else — Supabase auth/API
// calls, Edge Function calls — goes straight to the network untouched.
// (Logging in and syncing still need a real connection; only opening the
// app and queuing an entry work fully offline.)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const isAppShell = url.origin === self.location.origin;
  const isSupabaseSdk = event.request.url === SUPABASE_SDK_URL;
  if (!isAppShell && !isSupabaseSdk) return; // don't touch auth/API calls

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
