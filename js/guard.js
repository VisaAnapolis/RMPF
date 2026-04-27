// js/guard.js
// Auth guard — must be loaded AFTER firebase-config.js
// Sets window.currentUser and exposes window.authReady (Promise)

(function () {
  let _idleTimer = null;
  const IDLE_MS = 30 * 60 * 1000; // 30 minutes

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
