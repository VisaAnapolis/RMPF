// js/guard.js
// Auth guard — must be loaded AFTER firebase-config.js
// Sets window.currentUser and exposes window.authReady (Promise)

(function () {
  let _idleTimer = null;
  // Dispositivos móveis são pessoais (não compartilhados): usa timeout maior (8h).
  // Desktops compartilhados mantêm 30 min. Override via window.IDLE_TIMEOUT_MS.
  const _isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || window.matchMedia('(pointer: coarse)').matches;
  const IDLE_MS = (typeof window.IDLE_TIMEOUT_MS === 'number')
    ? window.IDLE_TIMEOUT_MS
    : (_isMobile ? 8 * 60 * 60 * 1000 : 30 * 60 * 1000);

  function resetIdle() {
    clearTimeout(_idleTimer);
    _idleTimer = setTimeout(() => {
      firebase.auth().signOut().then(() => {
        window.location.href = 'index.html';
      });
    }, IDLE_MS);
  }

  function attachIdleListeners() {
    ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(ev => {
      document.addEventListener(ev, resetIdle, { passive: true });
    });
    resetIdle();
  }

  window.authReady = new Promise((resolve) => {
    firebase.auth().onAuthStateChanged(async (user) => {
      if (!user) {
        window.location.href = 'index.html';
        return;
      }
      try {
        const snap = await firebase.firestore()
          .collection('usuarios')
          .doc(user.email)
          .get();

        if (!snap.exists || snap.data().ativo === false) {
          await firebase.auth().signOut();
          window.location.href = 'index.html';
          return;
        }

        window.currentUser = {
          uid:   user.uid,
          email: user.email,
          ...snap.data()
        };

        // Fire-and-forget: atualiza último acesso e versão do RMPF
        (async () => {
          try {
            await firebase.firestore()
              .collection('usuarios')
              .doc(user.email)
              .update({
                rmpf_ultimoAcesso: firebase.firestore.FieldValue.serverTimestamp(),
                rmpf_appVersion:   window.APP_VERSION || '',
              });
          } catch (e) {
            console.warn('Falha ao registrar acesso:', e);
          }
        })();

        attachIdleListeners();

        // Solicita permissão e captura token FCM para notificações push (fire-and-forget)
        if (typeof window.initFCM === 'function') {
          window.initFCM(user.email).catch(() => {});
        }

        resolve(window.currentUser);
      } catch (e) {
        console.error('Auth guard error:', e);
        window.location.href = 'index.html';
      }
    });
  });

  // Convenience wrapper — call page init once auth resolves
  window.requireAuth = function (callback) {
   window.authReady.then(user => {
  Promise.resolve(callback(user)).catch(e => console.error('[requireAuth] Page init error:', e));
}).catch(() => { location.href = 'dashboard.html'; });
  };
})();
