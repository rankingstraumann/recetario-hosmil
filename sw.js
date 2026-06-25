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

  // No interceptar llamadas a Supabase ni a CDNs externos:
  // estas requieren conexión en vivo y nunca deben ser cacheadas.
  const url = event.request.url;
  if (url.includes('supabase.co') ||
      url.includes('supabase.io') ||
      url.includes('jsdelivr.net') ||
      url.includes('googleapis.com')) return;

  // Para recursos estáticos propios: red primero, caché como fallback.
  // Si no hay caché disponible, responder con 503 en lugar de undefined
  // (undefined causa TypeError que colapsa otras peticiones en la sesión).
  event.respondWith(
    fetch(event.request).catch(function () {
      return caches.match(event.request).then(function (cached) {
        return cached || new Response('Recurso no disponible sin conexión.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        });
      });
    })
  );
});
