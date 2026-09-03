const CACHE_NAME = 'holistica-cache-v3';
const APP_SHELL = [
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { cache: 'no-store' }).then((res) => cache.put(url, res))
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Network-first for navigation (so updates show up fast), cache-first for the rest
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Ne jamais intercepter les requêtes vers d'autres sites (Stripe, PayPal, etc.)
  // — sinon les redirections de paiement externes se cassent (page blanche).
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      // cache: 'no-store' force un vrai aller-retour réseau, en ignorant le cache HTTP
      // du navigateur — sans ça, Safari peut renvoyer une version périmée d'index.html
      // même en "network-first", ce qui bloquait les mises à jour chez certaines utilisatrices.
      fetch(request, { cache: 'no-store' })
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return res;
        })
        .catch(() => cached);
    })
  );
});
