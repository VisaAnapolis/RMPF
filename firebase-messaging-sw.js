// firebase-messaging-sw.js
// Service Worker para receber notificações push em background via Firebase Cloud Messaging.
//
// Registrado por js/firebase-config.js em escopo dedicado do RMPF
// (./firebase-cloud-messaging-push-scope), para que o token FCM fique atrelado
// a ESTE service worker e não ao do VISA na raiz da origem.
//
// IMPORTANTE: este SW vive em /RMPF/, mas a origem (visaanapolis.github.io) tem
// o VISA na raiz. Por isso todos os caminhos abaixo são prefixados com /RMPF/ —
// um caminho absoluto como /dashboard.html ou /icons/... abriria o app VISA.

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
  const notif = payload.notification || {};
  const data  = payload.data || {};
  const title = notif.title || data.title || 'RMPF';
  const body  = notif.body  || data.body  || '';
  const url   = data.link || '/RMPF/dashboard.html';
  self.registration.showNotification(title, {
    body,
    icon:  '/RMPF/icons/rmpf-192.png',
    badge: '/RMPF/icons/rmpf-192.png',
    data:  { url },
  });
});

// Abre/foca a aba correta ao clicar na notificação
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data || {}).url || '/RMPF/dashboard.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
