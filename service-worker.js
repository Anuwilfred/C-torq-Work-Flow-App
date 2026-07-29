// Bumping CACHE_NAME forces the app shell to refresh on next load.
const CACHE_NAME = 'ctorq-workflow-v3.25';
const SUPABASE_SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';

// RELIABILITY FIX #2: the previous version raced every app-shell request
// against a 4-second timeout and fell back to the cached copy if it lost
// that race — on an ordinary "just a bit slow" mobile connection (not
// actually offline), that timeout fires constantly, silently serving an
// old/possibly-mismatched cached file even though the real, current file
// was still on its way over the network. That's almost certainly what was
// causing "click the email link = works, plain refresh = blank": the
// email link often opens a fresh context, while a refresh in the same tab
// kept getting raced against that timeout and losing.
//
// Below, there is no artificial timeout at all. The app shell (HTML/JS/CSS)
// always tries the real network first, however long that takes, and only
// falls back to the cache if the request genuinely fails (actually
// offline). This matches how an ordinary website behaves — a slow load
// instead of a broken one — which is what "reliable" actually means here.

const SHELL_ASSETS = ['./', './index.html', './styles.css', './app.js', './config.js'];

const STATIC_ASSETS = [
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './notify.mp3',
  SUPABASE_SDK_URL,
];

async function cacheEach(cache, urls) {
  await Promise.allSettled(
    urls.map((url) => cache.add(url).catch((err) => {
      console.warn('[SW] failed to pre-cache (continuing anyway):', url, err);
    }))
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cacheEach(cache, [...SHELL_ASSETS, ...STATIC_ASSETS]))
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

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const reqUrl = event.request.url;
  const url = new URL(reqUrl);
  const isAppShell = url.origin === self.location.origin;
  const isSupabaseSdk = reqUrl === SUPABASE_SDK_URL;
  if (!isAppShell && !isSupabaseSdk) return; // don't touch Supabase auth/API/Edge Function calls

  const isStatic = STATIC_ASSETS.some((a) => reqUrl === a || reqUrl.endsWith(a.replace('./', '')));

  if (isStatic) {
    // Static/immutable files: cache-first (fast, works offline), backfilling
    // the cache from the network the first time any file is missing.
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return res;
      }))
    );
    return;
  }

  // App shell (HTML/JS/CSS): always network first, no timeout race. Only
  // falls back to the cached copy if the fetch genuinely fails (no
  // connection at all), so a refresh always shows the latest deployed
  // version whenever there's any network at all, slow or not.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});

// ---------- Push notifications (WhatsApp-style system alerts) ----------
// Fired by the browser's push service when send-push sends a message. This
// runs even if the app/tab is fully closed, as long as the browser/OS allows
// background push for this site (works on Android + desktop Chrome/Edge;
// on iPhone this only fires if the app was added to the Home Screen).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'Aeon Teams Chat';
  const options = {
    body: data.body || 'You have a new message',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: data.url || './' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
