/* Offline cache: the whole game is static files, so a cache-first worker
 * makes it installable and fully playable with no connection (co-op still
 * needs the network, single-player doesn't). Bump CACHE to ship an update. */
const CACHE = 'phantom-arena-v4';
const ASSETS = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg',
  'js/settings.js', 'js/audio.js', 'js/input.js', 'js/geometry.js',
  'js/renderer.js', 'js/hud.js', 'js/game.js', 'js/net.js', 'js/main.js',
  'js/vendor/peerjs.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
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
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // ignoreSearch so invite links (index.html?join=CODE) hit the cached shell
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) =>
      hit ||
      fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
    )
  );
});
