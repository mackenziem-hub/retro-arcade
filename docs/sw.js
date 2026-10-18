// Offline support. The menu loads fresh when online (so updates arrive) and from cache when offline.
// Emulator cores and box art are kept after the first use, so games run with no internet.
const SHELL = 'arcade-shell-v1', ASSETS = 'arcade-assets-v1';
const SHELL_FILES = ['./', 'index.html', 'play.html', 'store.js', 'phone.js', 'style.css', 'phone.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // Network first, cache fallback.
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  } else if (url.hostname === 'cdn.emulatorjs.org' || url.hostname === 'thumbnails.libretro.com') {
    // Versioned emulator files and box art never change: cache first.
    e.respondWith(caches.open(ASSETS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
  }
});
