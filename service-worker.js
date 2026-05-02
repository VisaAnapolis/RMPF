// ============================================================
// Service Worker — RMPF
// Estratégia: Network First (sempre busca a versão mais recente
// da rede; usa cache apenas como fallback offline).
//
// Resolve o problema de usuários presos em versões antigas
// especialmente em PWAs no iOS e Android.
// ============================================================

const CACHE_NAME = 'rmpf-v1.3.1';

// Assume controle imediatamente, sem aguardar abas serem fechadas
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// ── Network First: tenta a rede, cai para cache apenas se offline ──
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (event.request.url.startsWith('chrome-extension://')) return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});
