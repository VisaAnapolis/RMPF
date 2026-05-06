// js/guard.js
// Auth guard — must be loaded AFTER firebase-config.js
// Sets window.currentUser and exposes window.authReady (Promise)

(function () {
  let _idleTimer = null;
  // Idle timeout in milliseconds — override window.IDLE_TIMEOUT_MS before loading guard.js if needed
  const IDLE_MS = (typeof window.IDLE_TIMEOUT_MS === 'number') ? window.IDLE_TIMEOUT_MS : 30 * 60 * 1000;

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

        if (!snap.exists || (snap.data().status || '').toLowerCase() === 'inativo') {
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
        resolve(window.currentUser);
      } catch (e) {
        console.error('Auth guard error:', e);
        window.location.href = 'index.html';
      }
    });
  });

  // Convenience wrapper — call page init once auth resolves.
  // NOTE: authReady only ever resolves (never rejects) — the outer .catch handles
  // unexpected failures obtaining the Promise itself.  Page-level errors thrown by
  // callback are caught separately so they do NOT redirect the user away.
  window.requireAuth = function (callback) {
    window.authReady.then(user => {
      Promise.resolve(callback(user)).catch(e => {
        console.error('[requireAuth] Page init error:', e);
      });
    }).catch(() => {
      window.location.href = 'dashboard.html';
    });
  };
})();
