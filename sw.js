// Service worker de Vitrina — mínimo y seguro.
// Regla de oro: nunca cachear /api/* (stock, precios y pedidos siempre deben ser datos frescos).
const CACHE = 'vitrina-shell-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // no tocar POST/DELETE (crear pedido, guardar config, etc.)

  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return; // datos siempre frescos, nunca cacheados

  // Navegación (abrir la app / instalada desde el ícono): red primero, con respaldo en caché si no hay señal
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('/')))
    );
    return;
  }

  // Recursos estáticos (fuentes, librerías, íconos): caché primero, para que cargue rápido
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }))
  );
});
