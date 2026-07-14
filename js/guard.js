// js/guard.js
// Auth guard — must be loaded AFTER firebase-config.js
// Sets window.currentUser and exposes window.authReady (Promise)

(function () {
  let _idleTimer = null;
  // Timeout de inatividade por MODO, não por tipo de tela: 30 min só quando o
  // navegador foi marcado como "computador compartilhado" (rmpfEhCompartilhado,
  // definido em firebase-config.js — carregado antes deste arquivo); demais
  // dispositivos (celular, tablet e desktop PESSOAL) usam 8h. Antes o critério
  // era mobile×desktop, e desktop pessoal era deslogado a cada 30 min parado.
  // Override via window.IDLE_TIMEOUT_MS.
  const _compartilhado = (typeof window.rmpfEhCompartilhado === 'function') && window.rmpfEhCompartilhado();
  const IDLE_MS = (typeof window.IDLE_TIMEOUT_MS === 'number')
    ? window.IDLE_TIMEOUT_MS
    : (_compartilhado ? 30 * 60 * 1000 : 8 * 60 * 60 * 1000);

  function resetIdle() {
    clearTimeout(_idleTimer);
    _idleTimer = setTimeout(() => {
      // Mesma regra do "Sair": em computador compartilhado encerra também a
      // sessão do Google no navegador (ver window.sharedLogout em firebase-config.js).
      if (typeof window.sharedLogout === 'function') {
        window.sharedLogout();
      } else {
        firebase.auth().signOut().then(() => { window.location.href = 'index.html'; });
      }
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
        // 2 tentativas: engasgo transitório de rede não pode derrubar a página —
        // antes, uma falha única devolvia ao index, que (pior ainda) deslogava.
        let snap = null;
        for (let tentativa = 1; tentativa <= 2; tentativa++) {
          try {
            snap = await firebase.firestore()
              .collection('usuarios')
              .doc(user.email)
              .get();
            break;
          } catch (e) {
            if (tentativa === 2) throw e;
            await new Promise(r => setTimeout(r, 800));
          }
        }

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

        // Fire-and-forget: atualiza último acesso e dados do dispositivo
        (async () => {
          try {
            const ua = navigator.userAgent;
            const isPWA = window.matchMedia('(display-mode: standalone)').matches;
            let navegador = 'Desconhecido', versaoNavegador = '';
            if      (/Edg\//.test(ua))     { navegador = 'Edge';    versaoNavegador = (ua.match(/Edg\/([\d.]+)/)    ||[])[1]||''; }
            else if (/OPR\//.test(ua))     { navegador = 'Opera';   versaoNavegador = (ua.match(/OPR\/([\d.]+)/)    ||[])[1]||''; }
            else if (/Chrome\//.test(ua))  { navegador = 'Chrome';  versaoNavegador = (ua.match(/Chrome\/([\d.]+)/) ||[])[1]||''; }
            else if (/Firefox\//.test(ua)) { navegador = 'Firefox'; versaoNavegador = (ua.match(/Firefox\/([\d.]+)/)||[])[1]||''; }
            else if (/Safari\//.test(ua))  { navegador = 'Safari';  versaoNavegador = (ua.match(/Version\/([\d.]+)/)||[])[1]||''; }
            let so = 'Desconhecido';
            if      (/Windows NT ([\d.]+)/.test(ua))  so = 'Windows '  + RegExp.$1;
            else if (/Android ([\d.]+)/.test(ua))     so = 'Android '  + RegExp.$1;
            else if (/iPhone|iPad|iPod/.test(ua))     so = 'iOS '      + ((ua.match(/OS ([\d_]+)/)||[])[1]||'').replace(/_/g,'.');
            else if (/Mac OS X ([\d_]+)/.test(ua))    so = 'macOS '    + RegExp.$1.replace(/_/g,'.');
            else if (/Linux/.test(ua))                so = 'Linux';
            await firebase.firestore()
              .collection('usuarios')
              .doc(user.email)
              .update({
                rmpf_ultimoAcesso:    firebase.firestore.FieldValue.serverTimestamp(),
                rmpf_ultimoLogin:     firebase.firestore.FieldValue.serverTimestamp(),
                rmpf_appVersion:      window.APP_VERSION || '',
                // rmpf_userAgent removido: nunca foi lido por nenhum app
                // (auditoria jul/2026); limpar-lixo-usuarios.js apaga o legado
                rmpf_navegador:       navegador,
                rmpf_versaoNavegador: versaoNavegador,
                rmpf_so:              so,
                rmpf_modoAcesso:      isPWA ? 'PWA' : 'Navegador',
                rmpf_tamanhoTela:     screen.width + 'x' + screen.height,
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

        // Injeta o botão fixo "Ativar 🔔" no cabeçalho (gesto manual de opt-in)
        if (typeof window.ensureFCMOptInButton === 'function') {
          window.ensureFCMOptInButton(user.email);
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
