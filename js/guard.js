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

        if (!snap.exists || snap.data().status === 'Inativo') {
          await firebase.auth().signOut();
          window.location.href = 'index.html';
          return;
        }

        window.currentUser = {
          uid:   user.uid,
          email: user.email,
          ...snap.data()
        };

        // Fire-and-forget: register device access data
        (async () => {
          try {
            const isPWA = window.matchMedia('(display-mode: standalone)').matches;
            const ua    = navigator.userAgent;

            // Detect browser
            let navegador = 'Desconhecido', versaoNavegador = '';
            if (/Edg\//.test(ua))                          { navegador = 'Edge';    versaoNavegador = (ua.match(/Edg\/([\d.]+)/)    ||[])[1]||''; }
            else if (/OPR\//.test(ua))                     { navegador = 'Opera';   versaoNavegador = (ua.match(/OPR\/([\d.]+)/)    ||[])[1]||''; }
            else if (/Chrome\//.test(ua))                  { navegador = 'Chrome';  versaoNavegador = (ua.match(/Chrome\/([\d.]+)/) ||[])[1]||''; }
            else if (/Firefox\//.test(ua))                 { navegador = 'Firefox'; versaoNavegador = (ua.match(/Firefox\/([\d.]+)/)||[])[1]||''; }
            else if (/Safari\//.test(ua))                  { navegador = 'Safari';  versaoNavegador = (ua.match(/Version\/([\d.]+)/)||[])[1]||''; }

            // Detect OS
            let versaoSO = 'Desconhecido';
            if      (/Windows NT ([\d.]+)/.test(ua))  versaoSO = 'Windows '  + RegExp.$1;
            else if (/Android ([\d.]+)/.test(ua))     versaoSO = 'Android '  + RegExp.$1;
            else if (/iPhone|iPad|iPod/.test(ua))     versaoSO = 'iOS '      + ((ua.match(/OS ([\d_]+)/)||[])[1]||'').replace(/_/g,'.');
            else if (/Mac OS X ([\d_]+)/.test(ua))    versaoSO = 'macOS '    + RegExp.$1.replace(/_/g,'.');
            else if (/Linux/.test(ua))                versaoSO = 'Linux';

            const novoDispositivo = {
              appVersion:     window.APP_VERSION || '',
              navegador,
              versaoNavegador,
              versaoSO,
              isPWA,
              modoAcesso:     isPWA ? 'PWA' : 'Navegador',
              siteOrigem:     window.location.hostname,
              coletadoEm:     firebase.firestore.Timestamp.now(),
            };

            const atual     = snap.data().dispositivos || [];
            const atualizado = [novoDispositivo, ...atual].slice(0, 10);

            await firebase.firestore()
              .collection('usuarios')
              .doc(user.email)
              .update({
                ultimoAcesso:   firebase.firestore.FieldValue.serverTimestamp(),
                appVersionLast: window.APP_VERSION || '',
                dispositivos:   atualizado,
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

  // Convenience wrapper — call page init once auth resolves
  window.requireAuth = function (callback) {
    window.authReady.then(callback).catch(() => {
      window.location.href = 'index.html';
    });
  };
})();
