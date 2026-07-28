// Bumping CACHE_NAME forces the app shell to refresh on next load.
const CACHE_NAME = 'ctorq-workflow-v3.24';
const SUPABASE_SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';

// RELIABILITY FIX: this used to be one flat ASSETS list cached with
// cache.addAll(), which is all-or-nothing — if even ONE file failed to
// load during install (a slow/unreachable CDN request, a brief network
// blip, anything), the whole install() step rejected and the new service
// worker was thrown away. The device would then keep running whatever
// version it had before (or nothing at all), which is exactly why the app
// felt unpredictable: it opened fine on some devices/sessions and not
// others, purely depending on whether every single asset happened to
// succeed on that one attempt. Below, every file is cached individually so
// one failure can't take down the rest.

// The app shell — HTML/JS/CSS that actually changes when we deploy updates.
const SHELL_ASSETS = ['./', './index.html', './styles.css', './app.js', './config.js'];

// Static/rarely-changing files — icons, the manifest, and the Supabase SDK
// (pinned to an exact version number in its URL, so that URL never changes).
const STATIC_ASSETS = [
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './notify.mp3',
  SUPABASE_SDK_URL,
];

const NETWORK_TIMEOUT_MS = 4000;

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

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

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

  // App shell (HTML/JS/CSS): network-first with a short timeout, so anyone
  // online always gets the latest deployed version immediately instead of a
  // possibly-stale or broken cached copy. Falls back to the cached copy only
  // if the network is slow/unreachable, so the app still opens offline.
  event.respondWith(
    withTimeout(fetch(event.request), NETWORK_TIMEOUT_MS)
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
