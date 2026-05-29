// js/firebase-config.js
// Firebase Compat SDK — initialized once, sets globals used by all pages
//
// NOTE: Firebase API keys are designed to be public (client-side) — access is
// controlled entirely by Firestore Security Rules (see firestore.rules).
// See: https://firebase.google.com/docs/projects/api-keys

const firebaseConfig = {
  apiKey: "AIzaSyDo473puJesZ9rr3IBoX5AWczCIMuKBTrg",
  authDomain: "visam-3a30b.firebaseapp.com",
  projectId: "visam-3a30b",
  storageBucket: "visam-3a30b.firebasestorage.app",
  messagingSenderId: "308899251430",
  appId: "1:308899251430:web:0053cdbd0bed7f0de76727"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

window.db           = firebase.firestore();
window.auth         = firebase.auth();
window.googleProvider = new firebase.auth.GoogleAuthProvider();
window.googleProvider.setCustomParameters({ prompt: 'select_account' });

// ── Firebase Cloud Messaging — captura de token FCM ──────────────────────────
// Requer que o SDK firebase-messaging-compat.js seja carregado ANTES deste
// arquivo nas páginas que precisam de notificações (ex.: dashboard.html).
// Após o login (requireAuth) cada página deve chamar window.initFCM(email).
//
// VAPID Key (Web Push Certificate):
//   Obtenha em Firebase Console → Project Settings → Cloud Messaging →
//   Web Push certificates → Key pair.
//   Cole o valor abaixo ou armazene em app_config/vapid_key no Firestore.
const _FCM_VAPID_KEY = 'BIQDXzL0tE6YpIk_PLACEHOLDER_SUBSTITUA_PELA_CHAVE_VAPID_DO_FIREBASE_CONSOLE';

/**
 * Solicita permissão de notificação, obtém o token FCM e o persiste
 * em usuarios/{email}.fcm_token no Firestore.
 * Deve ser chamado uma vez após o login bem-sucedido.
 *
 * @param {string} email  E-mail do usuário autenticado
 */
window.initFCM = async function initFCM(email) {
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    if (typeof firebase.messaging !== 'function') return; // SDK não carregado nesta página

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const messaging = firebase.messaging();

    // getToken() retorna um token atual ou gera um novo se expirado
    const token = await messaging.getToken({ vapidKey: _FCM_VAPID_KEY });
    if (!token) return;

    // Persiste o token no documento do usuário (fire-and-forget)
    window.db.collection('usuarios').doc(email).update({ fcm_token: token })
      .catch(e => console.warn('[FCM] Falha ao salvar token:', e));
  } catch (e) {
    console.warn('[FCM] initFCM erro:', e);
  }
};
