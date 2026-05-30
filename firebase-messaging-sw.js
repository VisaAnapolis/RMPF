// firebase-messaging-sw.js
// Service Worker para receber notificações push em background via Firebase Cloud Messaging.
//
// Este arquivo é registrado AUTOMATICAMENTE pelo SDK firebase-messaging-compat.js
// quando o usuário concede permissão de notificações.
// Deve estar na raiz do site (mesmo escopo do service-worker.js principal).

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            'AIzaSyDo473puJesZ9rr3IBoX5AWczCIMuKBTrg',
  authDomain:        'visam-3a30b.firebaseapp.com',
  projectId:         'visam-3a30b',
  storageBucket:     'visam-3a30b.firebasestorage.app',
  messagingSenderId: '308899251430',
  appId:             '1:308899251430:web:0053cdbd0bed7f0de76727',
});

const messaging = firebase.messaging();

// Exibe a notificação quando o app está em background ou fechado
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || 'RMPF', {
    body:  body  || '',
    icon:  '/icons/favicon-192.png',
    badge: '/icons/favicon-192.png',
    data:  { url: payload.data?.link || '/dashboard.html' },
  });
});

// Abre/foca a aba correta ao clicar na notificação
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data || {}).url || '/dashboard.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
