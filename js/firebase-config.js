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
// Mantido null por padrão para evitar hardcode de chave pública em repositório.
// Produção deve preferir app_config/vapid_key (campo "value") no Firestore.
const _FCM_VAPID_KEY = null;
const _FCM_VAPID_PLACEHOLDER_FLAGS = ['PLACEHOLDER_SUBSTITUA'];

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
  if (!fromConst || _FCM_VAPID_PLACEHOLDER_FLAGS.some(flag => fromConst === flag || fromConst.includes(flag))) return null;
  return fromConst;
}

// ── Banner de lembrete de notificações ───────────────────────────────────────
// Exibido quando o usuário negou a permissão de notificação e 15 dias se
// passaram desde o último lembrete. O browser não permite re-exibir o diálogo
// nativo após negação, então orientamos o usuário a habilitar manualmente.

const _FCM_REMINDER_KEY   = 'fcmReminderLastShown';
const _FCM_REMINDER_DAYS  = 15;

function _fcmReminder_shouldShow() {
  try {
    const last = parseInt(localStorage.getItem(_FCM_REMINDER_KEY) || '0', 10);
    const elapsed = Date.now() - last;
    return elapsed >= _FCM_REMINDER_DAYS * 24 * 60 * 60 * 1000;
  } catch (e) {
    return true; // se localStorage não disponível, exibe por segurança
  }
}

function _fcmReminder_markShown() {
  try { localStorage.setItem(_FCM_REMINDER_KEY, String(Date.now())); } catch (e) { /* noop */ }
}

function maybeShowFCMReminderBanner() {
  if (!_fcmReminder_shouldShow()) return;
  if (document.getElementById('fcm-reminder-banner')) return; // já visível

  _fcmReminder_markShown();

  const banner = document.createElement('div');
  banner.id = 'fcm-reminder-banner';
  banner.style.cssText = [
    'position:fixed', 'bottom:16px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:9999', 'max-width:480px', 'width:calc(100% - 32px)',
    'background:#fff', 'border:1.5px solid var(--amar,#b45309)',
    'border-radius:10px', 'box-shadow:0 4px 18px rgba(0,0,0,.18)',
    'padding:14px 16px 12px', 'display:flex', 'align-items:flex-start',
    'gap:10px', 'font-size:.9rem', 'color:#78350f',
  ].join(';');

  banner.innerHTML = `
    <span style="font-size:1.3rem;flex-shrink:0;margin-top:1px">🔔</span>
    <div style="flex:1">
      <strong>Ativar notificações push</strong>
      <p style="margin:4px 0 8px">
        Você desativou as notificações. Para recebê-las, habilite manualmente
        nas configurações do navegador:
        <em>ícone de cadeado na barra de endereço → Notificações → Permitir</em>.
      </p>
      <button id="fcm-reminder-close"
        style="background:var(--amar,#b45309);color:#fff;border:none;border-radius:6px;
               padding:5px 14px;cursor:pointer;font-size:.85rem">
        Entendido
      </button>
    </div>
    <button aria-label="Fechar"
      style="background:none;border:none;cursor:pointer;font-size:1.1rem;
             color:#78350f;padding:0 2px;flex-shrink:0"
      id="fcm-reminder-x">✕</button>`;

  const dismiss = () => banner.remove();
  document.body.appendChild(banner);
  document.getElementById('fcm-reminder-close').addEventListener('click', dismiss);
  document.getElementById('fcm-reminder-x').addEventListener('click', dismiss);
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
    if (!email) {
      console.warn('[FCM] initFCM chamado sem email.');
      return;
    }
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    if (typeof firebase.messaging !== 'function') return; // SDK não carregado nesta página

    // Se a permissão já foi negada pelo browser, não é possível exibir o
    // diálogo nativo novamente — sugerimos reativar a cada 15 dias.
    if (Notification.permission === 'denied') {
      maybeShowFCMReminderBanner();
      return;
    }

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
      ? [...new Set(data.fcmTokens.filter(t => typeof t === 'string' && t.trim()))]
      : [];
    const legacy = (typeof data.fcm_token === 'string' ? data.fcm_token : '').trim();
    if (legacy && !existing.includes(legacy)) existing.push(legacy);
    if (!existing.includes(token)) existing.push(token);

    const payload = {
      fcmTokens: existing,
    };

    // Persiste tokens sem sobrescrever os demais campos do usuário
    await userRef.set(payload, { merge: true });
  } catch (e) {
    console.warn('[FCM] initFCM erro:', e);
  }
};
