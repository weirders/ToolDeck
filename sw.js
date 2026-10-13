/* ToolDeck service worker — offline shell for the deck (scope /ToolDeck/). Tools in the iframe are
   covered by their own sw.js, not this one.
   Same template in every SFHA tool repo; see ToolDeck/OFFLINE.md.

   - Same-origin GETs (this page, sync.v1.js): network-first, so a fresh
     version always wins when online; after 4 s without an answer (bad Wi-Fi) or offline, the
     cached copy is served. The page and sync layer are pre-cached on install.
   - CDN scripts/styles/fonts/workers (versioned URLs): cache-first.
   - Everything else (APIs, model downloads, POSTs) passes straight through.

   Cache Storage is shared by every tool on weirders.github.io, so this worker only ever
   touches caches whose name starts with its own PREFIX. */
const PREFIX = 'tooldeck-';
const CACHE = PREFIX + 'v2';
const PRECACHE = ['./', './index.html', './sync.v1.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './icons/icon.svg'];
const NET_TIMEOUT = 4000;
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
const CDN_TYPES = new Set(['script', 'style', 'font', 'worker', 'sharedworker']);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.allSettled(PRECACHE.map(u => c.add(new Request(u, {cache: 'reload'})))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) return e.respondWith(networkFirst(req, e));
  if (CDN.test(req.url) && (CDN_TYPES.has(req.destination) || /\.(m?js|css|woff2?)(\?|$)/.test(url.pathname)))
    return e.respondWith(cacheFirst(req));
});

function store(req, res) {
  if (!res || !(res.ok || res.type === 'opaque')) return Promise.resolve();
  const copy = res.clone();
  return caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
}

function fromCache(req) {
  const nav = req.mode === 'navigate';
  return caches.match(req, {ignoreSearch: nav, cacheName: CACHE})
    .then(hit => hit || (nav ? caches.match('./', {cacheName: CACHE}) : undefined));
}

function networkFirst(req, e) {
  const net = fetch(req);
  // keep the worker alive until the fresh copy is stored, even if the cache answered first
  e.waitUntil(net.then(res => store(req, res)).catch(() => {}));
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => fromCache(req).then(finish), NET_TIMEOUT);
    net.then(res => { clearTimeout(timer); finish(res.clone()); })
      .catch(() => {
        clearTimeout(timer);
        fromCache(req).then(hit => { if (hit) finish(hit); else if (!done) { done = true; resolve(Response.error()); } });
      });
  });
}

function cacheFirst(req) {
  return caches.match(req, {cacheName: CACHE})
    .then(hit => hit || fetch(req).then(res => store(req, res).then(() => res)));
}
