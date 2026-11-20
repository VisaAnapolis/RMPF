// ============================================================
// Service Worker — RMPF
// Estratégia: Network First (sempre busca a versão mais recente
// da rede; usa cache apenas como fallback offline).
//
// Resolve o problema de usuários presos em versões antigas
// especialmente em PWAs no iOS e Android.
// ============================================================

const CACHE_NAME = 'rmpf-v1.45.2';

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

  // Scripts e estilos: revalida no servidor (cache: 'no-cache') em vez de
  // aceitar a cópia do cache HTTP do navegador. O GitHub Pages permite guardar
  // cada arquivo por 10 min; sem isto, logo após uma publicação a página nova
  // podia rodar com um js/utils.js antigo ("Can't find variable"). Com ETag,
  // a revalidação custa só um 304 quando nada mudou. Navegações ficam como
  // estavam (passar opções a um request "navigate" muda o seu modo).
  const req = event.request.mode === 'navigate'
    ? event.request
    : new Request(event.request, { cache: 'no-cache' });

  event.respondWith(
    fetch(req)
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
