// ============================================================
// Service Worker — RMPF
// Estratégia: Network First (sempre busca a versão mais recente
// da rede; usa cache apenas como fallback offline).
//
// Resolve o problema de usuários presos em versões antigas
// especialmente em PWAs no iOS e Android.
// ============================================================

const CACHE_NAME = 'rmpf-v1.25.2';

// Assume controle imediatamente, sem aguardar abas serem fechadas
self.addEventListener('install', () => self.skipWaiting());

// Ao ativar, remove caches de versões anteriores e assume o controle das abas.
// Sem esta limpeza, um firebase-config.js antigo poderia permanecer no cache de
// uma versão passada e ser servido offline, mantendo o usuário no código velho.
self.addEventListener('activate', (e) => e.waitUntil(
  (async () => {
    const nomes = await caches.keys();
    await Promise.all(
      nomes.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })()
));

// ── Network First: tenta a rede, cai para cache apenas se offline ──
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (event.request.url.startsWith('chrome-extension://')) return;

  // Não interceptar requisições cross-origin (ex: api.github.com, Firebase) —
  // essas chamadas são autenticadas/dinâmicas e não devem ser cacheadas.
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

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
        return caches.match(event.request).then((cached) => {
          return cached || Response.error();
        });
      })
  );
});
