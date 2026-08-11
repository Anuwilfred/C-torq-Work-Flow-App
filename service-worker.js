// Bumping CACHE_NAME forces the app shell to refresh on next load.
const CACHE_NAME = 'ctorq-workflow-v3.62';
const SUPABASE_SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';

// RELIABILITY FIX #3: an installed app (tapped from the home screen / Start
// Menu icon) opens through this service worker on every single launch, not
// just on refresh. The previous version made every launch wait on the real
// network before showing anything — fine on good wifi, but on a weaker
// mobile signal that's exactly "sometimes opens fast, sometimes doesn't":
// the open time was really just however long that one network request took
// at that moment, with nothing shown until it finished.
//
// Below is stale-while-revalidate for the app shell: if we already have a
// cached copy, show it INSTANTLY — same speed, every time, on any network —
// while a fresh copy downloads quietly in the background and replaces the
// cache for the next launch. Only the very first-ever visit (nothing cached
// yet) has to wait on the network, same as any ordinary website.

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

  // App shell (HTML/JS/CSS): stale-while-revalidate. Cached copy (if any)
  // is returned immediately so the app opens instantly and consistently;
  // the network response — whenever it lands — silently updates the cache
  // for the next launch. If nothing is cached yet (first-ever visit), we
  // have no choice but to wait for the network.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const networkUpdate = fetch(event.request)
        .then((res) => {
          cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        // Don't wait on the network — update the cache in the background
        // and hand back what we already have right now.
        event.waitUntil(networkUpdate);
        return cached;
      }
      const fresh = await networkUpdate;
      return fresh || caches.match('./index.html');
    })
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
