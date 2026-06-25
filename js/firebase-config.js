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

// ── Banner promocional de notificações ───────────────────────────────────────
// Exibido quando o usuário ainda não tomou decisão sobre notificações push
// (permission === 'default'). Oferece um convite amigável para ativar antes de
// exibir o diálogo nativo do browser, explicando o benefício de acompanhar a
// pontuação em tempo real. Reexibido a cada 7 dias se dispensado.

const _FCM_PROMO_KEY  = 'fcmPromoLastShown';
const _FCM_PROMO_DAYS = 7;
let   _fcmPromoShownThisSession = false;

function _fcmPromo_shouldShow() {
  if (_fcmPromoShownThisSession) return false;
  try {
    const last = parseInt(localStorage.getItem(_FCM_PROMO_KEY) || '0', 10);
    if (!last) return true;
    return (Date.now() - last) >= _FCM_PROMO_DAYS * 24 * 60 * 60 * 1000;
  } catch (e) {
    return true;
  }
}

function _fcmPromo_markShown() {
  try { localStorage.setItem(_FCM_PROMO_KEY, String(Date.now())); } catch (e) { /* noop */ }
}

/**
 * Exibe um banner convidando o usuário a ativar notificações push.
 * Só exibe quando Notification.permission === 'default' e o throttle permitir.
 *
 * @param {string} email  E-mail do usuário autenticado (passado ao initFCM ao clicar em Ativar)
 */
function maybeShowFCMPromoBanner(email) {
  if (!email || typeof email !== 'string') return;
  if (Notification.permission !== 'default') return;
  if (!_fcmPromo_shouldShow()) return;
  if (document.getElementById('fcm-promo-banner')) return;

  _fcmPromoShownThisSession = true;
  _fcmPromo_markShown();

  const banner = document.createElement('div');
  banner.id = 'fcm-promo-banner';
  banner.style.cssText = [
    'position:fixed', 'bottom:16px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:9999', 'max-width:480px', 'width:calc(100% - 32px)',
    'background:#fff', 'border:1.5px solid #1565c0',
    'border-radius:10px', 'box-shadow:0 4px 18px rgba(0,0,0,.18)',
    'padding:14px 16px 12px', 'display:flex', 'align-items:flex-start',
    'gap:10px', 'font-size:.9rem', 'color:#0d3a7a',
  ].join(';');

  banner.innerHTML = `
    <span style="font-size:1.3rem;flex-shrink:0;margin-top:1px">🔔</span>
    <div style="flex:1">
      <strong>Ativar notificações</strong>
      <p style="margin:4px 0 8px">
        Ative as notificações para acompanhar sua pontuação e ser avisado sobre
        homologações e novidades em tempo real.
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="fcm-promo-btn"
          style="background:#1565c0;color:#fff;border:none;border-radius:6px;
                 padding:5px 14px;cursor:pointer;font-size:.85rem">
          Ativar 🔔
        </button>
        <button id="fcm-promo-close"
          style="background:none;border:1px solid #1565c0;color:#1565c0;
                 border-radius:6px;padding:5px 14px;cursor:pointer;font-size:.85rem">
          Agora não
        </button>
      </div>
    </div>
    <button aria-label="Fechar"
      style="background:none;border:none;cursor:pointer;font-size:1.1rem;
             color:#0d3a7a;padding:0 2px;flex-shrink:0"
      id="fcm-promo-x">✕</button>`;

  document.body.appendChild(banner);

  const dismiss = () => banner.remove();
  document.getElementById('fcm-promo-close')?.addEventListener('click', dismiss);
  document.getElementById('fcm-promo-x')?.addEventListener('click', dismiss);
  document.getElementById('fcm-promo-btn')?.addEventListener('click', async () => {
    dismiss();
    if (typeof window.initFCM === 'function' && email) {
      await window.initFCM(email, true); // _skipPromo=true → vai direto ao requestPermission
    }
  });
}

// ── Banner de lembrete de notificações ───────────────────────────────────────
// Exibido quando o usuário negou a permissão de notificação e 15 dias se
// passaram desde o último lembrete. O browser não permite re-exibir o diálogo
// nativo após negação, então orientamos o usuário a habilitar manualmente.

const _FCM_REMINDER_KEY   = 'fcmReminderLastShown';
const _FCM_REMINDER_DAYS  = 15;
let   _fcmReminderShownThisSession = false; // evita re-exibição se localStorage falhar

function _fcmReminder_shouldShow() {
  if (_fcmReminderShownThisSession) return false;
  try {
    const last = parseInt(localStorage.getItem(_FCM_REMINDER_KEY) || '0', 10);
    if (!last) return true; // primeira vez — mostra uma vez e registra
    const elapsed = Date.now() - last;
    return elapsed >= _FCM_REMINDER_DAYS * 24 * 60 * 60 * 1000;
  } catch (e) {
    return true;
  }
}

function _fcmReminder_markShown() {
  try { localStorage.setItem(_FCM_REMINDER_KEY, String(Date.now())); } catch (e) { /* noop */ }
}

function maybeShowFCMReminderBanner() {
  if (!_fcmReminder_shouldShow()) return;
  if (document.getElementById('fcm-reminder-banner')) return; // já visível

  _fcmReminderShownThisSession = true;
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
  document.getElementById('fcm-reminder-close')?.addEventListener('click', dismiss);
  document.getElementById('fcm-reminder-x')?.addEventListener('click', dismiss);
}

// ── Service Worker dedicado do FCM (escopo isolado do RMPF) ──────────────────
// O RMPF e o VISA são servidos na MESMA origem (visaanapolis.github.io) e usam
// o MESMO projeto Firebase. Se o getToken() for chamado sem
// serviceWorkerRegistration, o SDK registra/usa o firebase-messaging-sw.js da
// RAIZ da origem — que pertence ao app VISA — e o token gerado fica atrelado ao
// service worker do VISA. Resultado: pushes do RMPF eram exibidos pelo SW do
// VISA (com identidade de "OS do VISA").
//
// Para evitar isso, registramos o firebase-messaging-sw.js do próprio RMPF em
// um escopo dedicado dentro de /RMPF/ e passamos esse registro ao getToken().
// O escopo é distinto do service-worker.js principal (que controla /RMPF/),
// evitando que um sobrescreva o outro.
const _FCM_SW_PATH  = './firebase-messaging-sw.js';
const _FCM_SW_SCOPE = './firebase-cloud-messaging-push-scope';

async function _registerFcmServiceWorker() {
  // Reaproveita um registro existente no escopo dedicado, se houver.
  try {
    const existing = await navigator.serviceWorker.getRegistration(_FCM_SW_SCOPE);
    if (existing && existing.active && existing.active.scriptURL.endsWith('firebase-messaging-sw.js')) {
      return existing;
    }
  } catch (e) { /* segue para registrar */ }
  return navigator.serviceWorker.register(_FCM_SW_PATH, { scope: _FCM_SW_SCOPE });
}

/**
 * Solicita permissão de notificação, obtém o token FCM (vinculado ao service
 * worker do RMPF) e o persiste em campos EXCLUSIVOS do RMPF no Firestore:
 *   - usuarios/{email}.rmpf_fcmTokens        (array de tokens deste app)
 *   - usuarios/{email}.rmpf_notifPermissao   ('granted' | 'denied' | 'default')
 *   - usuarios/{email}.rmpf_notifAtualizadoEm (timestamp da última atualização)
 *
 * A coleção `usuarios` é compartilhada entre RMPF, VISA e AUDITORIA; portanto
 * NUNCA tocamos em campos de outros apps (ex.: fcm_token do VISA). Todos os
 * campos gravados aqui usam o prefixo `rmpf_` e a escrita é feita com
 * { merge: true } para não sobrescrever os demais campos do documento.
 *
 * Detecção no login: como guard.js chama initFCM a cada autenticação, se o
 * usuário ainda não possui token específico do RMPF (rmpf_fcmTokens vazio) e a
 * permissão não foi negada, a autorização de notificação é solicitada e o token
 * é gerado/persistido.
 *
 * Deve ser chamado uma vez após o login bem-sucedido.
 *
 * @param {string} email  E-mail do usuário autenticado
 */
window.initFCM = async function initFCM(email, _skipPromo = false) {
  try {
    if (!email) {
      console.warn('[FCM] initFCM chamado sem email.');
      return;
    }
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    if (typeof firebase.messaging !== 'function') return; // SDK não carregado nesta página

    const userRef = window.db.collection('usuarios').doc(email);

    /** Grava o estado de permissão do RMPF sem afetar campos de outros apps. */
    const salvarPermissao = async (estado) => {
      try {
        await userRef.set({
          rmpf_notifPermissao:    estado,
          rmpf_notifAtualizadoEm: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (e) {
        console.warn('[FCM] Falha ao salvar estado de permissão:', e);
      }
    };

    /**
     * Registra um diagnóstico do registro de token em rmpf_notifDiag.
     * Permite a um administrador descobrir, direto no Firestore, POR QUE um
     * usuário que "aceitou" não recebe push — sem precisar do console de cada
     * navegador. Valores típicos: 'ok', 'vapid_key_ausente', 'token_null',
     * 'permissao_negada', 'permissao_default', 'erro:<mensagem>'.
     */
    const salvarDiag = async (motivo) => {
      try {
        await userRef.set({
          rmpf_notifDiag:         motivo,
          rmpf_notifDiagEm:       firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (e) {
        console.warn('[FCM] Falha ao salvar diagnóstico:', e);
      }
    };

    // Se a permissão já foi negada pelo browser, não é possível exibir o
    // diálogo nativo novamente — sugerimos reativar a cada 15 dias.
    if (Notification.permission === 'denied') {
      await salvarPermissao('denied');
      await salvarDiag('permissao_negada');
      maybeShowFCMReminderBanner();
      return;
    }

    // Se o usuário ainda não decidiu, exibe o banner promocional convidando-o
    // a ativar notificações. O clique em "Ativar" chama initFCM novamente com
    // _skipPromo=true para ir diretamente ao requestPermission nativo.
    if (Notification.permission === 'default' && !_skipPromo) {
      maybeShowFCMPromoBanner(email);
      return;
    }

    const permission = await Notification.requestPermission();
    await salvarPermissao(permission);
    if (permission !== 'granted') {
      await salvarDiag('permissao_' + permission);
      return;
    }

    const vapidKey = await resolveVapidKey();
    if (!vapidKey) {
      console.warn('[FCM] VAPID Key ausente. O usuário concedeu permissão, mas '
        + 'getToken() NÃO será chamado e rmpf_fcmTokens ficará vazio. '
        + 'Configure app_config/vapid_key (campo "value") no Firestore.');
      await salvarDiag('vapid_key_ausente');
      return;
    }

    const messaging = firebase.messaging();

    // Registra (ou reaproveita) o service worker do RMPF em escopo dedicado e
    // o usa para gerar o token — garantindo que o token pertença ao SW do RMPF
    // e não ao SW do VISA na raiz da origem.
    const swReg = await _registerFcmServiceWorker();

    // getToken() retorna um token atual ou gera um novo se expirado
    const token = await messaging.getToken({ vapidKey, serviceWorkerRegistration: swReg });
    if (!token) {
      console.warn('[FCM] getToken() retornou null/vazio — token não gerado. '
        + 'rmpf_fcmTokens não será atualizado.');
      await salvarDiag('token_null');
      return;
    }

    const snap = await userRef.get();
    const data = snap.exists ? (snap.data() || {}) : {};

    // Campo exclusivo do RMPF. NÃO migra data.fcmTokens (legado, possivelmente
    // atrelado ao SW do VISA) nem data.fcm_token (campo do VISA / AUDITORIA).
    const existing = Array.isArray(data.rmpf_fcmTokens)
      ? [...new Set(data.rmpf_fcmTokens.filter(t => typeof t === 'string' && t.trim()))]
      : [];
    if (!existing.includes(token)) existing.push(token);

    // Persiste tokens sem sobrescrever os demais campos do usuário
    await userRef.set({ rmpf_fcmTokens: existing }, { merge: true });
    await salvarDiag('ok');
  } catch (e) {
    console.warn('[FCM] initFCM erro:', e);
    try {
      await window.db.collection('usuarios').doc(email).set({
        rmpf_notifDiag:   'erro:' + (e && e.message ? e.message : String(e)),
        rmpf_notifDiagEm: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (_) { /* noop */ }
  }
};
