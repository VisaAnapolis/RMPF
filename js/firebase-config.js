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
//   IMPORTANTE: sem uma VAPID Key válida o getToken() retorna null e
//   nenhum token FCM é gerado/salvo.
//   Preferencialmente mantenha a chave no Firestore em app_config/vapid_key
//   (campo "value"), para evitar hardcode em repositório público.
const _FCM_VAPID_KEY = 'BIQDXzL0tE6YpIk_PLACEHOLDER_SUBSTITUA_PELA_CHAVE_VAPID_DO_FIREBASE_CONSOLE';
const _FCM_VAPID_PLACEHOLDER_FLAG = 'PLACEHOLDER_SUBSTITUA';

async function db_getVapidKey() {
  const snap = await window.db.collection('app_config').doc('vapid_key').get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return (data.value || '').trim() || null;
}

async function resolveVapidKey() {
  try {
    const fromFirestore = await db_getVapidKey();
    if (fromFirestore) return fromFirestore;
  } catch (e) {
    console.warn('[FCM] Falha ao ler app_config/vapid_key:', e);
  }

  const fromConst = (_FCM_VAPID_KEY || '').trim();
  if (!fromConst || fromConst.includes(_FCM_VAPID_PLACEHOLDER_FLAG)) return null;
  return fromConst;
}

/**
 * Solicita permissão de notificação, obtém o token FCM e o persiste
 * em usuarios/{email}.fcmTokens no Firestore.
 * Deve ser chamado uma vez após o login bem-sucedido.
 *
 * @param {string} email  E-mail do usuário autenticado
 */
window.initFCM = async function initFCM(email) {
  try {
    if (!email) return;
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    if (typeof firebase.messaging !== 'function') return; // SDK não carregado nesta página

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const vapidKey = await resolveVapidKey();
    if (!vapidKey) {
      console.warn('[FCM] VAPID Key ausente. Configure app_config/vapid_key (value) no Firestore ou substitua o placeholder em js/firebase-config.js.');
      return;
    }

    const messaging = firebase.messaging();

    // getToken() retorna um token atual ou gera um novo se expirado
    const token = await messaging.getToken({ vapidKey });
    if (!token) return;

    const userRef = window.db.collection('usuarios').doc(email);
    const snap = await userRef.get();
    const data = snap.exists ? (snap.data() || {}) : {};

    const existing = Array.isArray(data.fcmTokens)
      ? data.fcmTokens.filter(t => typeof t === 'string' && t.trim())
      : [];
    const legacy = (typeof data.fcm_token === 'string' ? data.fcm_token : '').trim();
    if (legacy) existing.push(legacy);
    if (!existing.includes(token)) existing.push(token);

    const deduped = [...new Set(existing)];
    const payload = { fcmTokens: deduped };
    if ('fcm_token' in data) {
      payload.fcm_token = firebase.firestore.FieldValue.delete();
    }

    // Persiste tokens sem sobrescrever os demais campos do usuário
    await userRef.set(payload, { merge: true });
  } catch (e) {
    console.warn('[FCM] initFCM erro:', e);
  }
};
