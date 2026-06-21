// Service worker mínimo: solo habilita que el navegador ofrezca "Instalar app".
// No cachea datos (las cotizaciones requieren conexión en vivo a Supabase),
// así que siempre sirve la versión más nueva desde la red.
self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(function () {
      return caches.match(event.request);
    })
  );
});
