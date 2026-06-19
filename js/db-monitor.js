// js/db-monitor.js
// Monitor de leituras do Firestore — visível apenas para Administrador.
// Faz monkey-patch no window.db interceptando chamadas .get() para contar
// documentos retornados. Não gera leituras adicionais no Firestore.

(function () {
  const STORAGE_KEY = 'rmpf_reads_session';
  const DETAIL_KEY  = 'rmpf_reads_detail';

  // ── Helpers de persistência ──────────────────────────────

  function getTotal() {
    return parseInt(sessionStorage.getItem(STORAGE_KEY) || '0', 10);
  }

  function getDetail() {
    try { return JSON.parse(sessionStorage.getItem(DETAIL_KEY) || '{}'); } catch (e) { return {}; }
  }

  function addReads(collection, count) {
    const total = getTotal() + count;
    sessionStorage.setItem(STORAGE_KEY, String(total));

    const detail = getDetail();
    detail[collection] = (detail[collection] || 0) + count;
    sessionStorage.setItem(DETAIL_KEY, JSON.stringify(detail));

    return total;
  }

  function resetCounters() {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(DETAIL_KEY);
  }

  // ── Monkey-patch do Firestore ────────────────────────────
  // Aguarda window.db estar disponível antes de interceptar.

  function patchDb() {
    const db = window.db;
    if (!db) return;

    // Guarda a referência original de collection()
    const origCollection = db.collection.bind(db);

    db.collection = function (path) {
      const colRef = origCollection(path);
      return patchCollectionRef(colRef, path);
    };
  }

  function patchCollectionRef(colRef, collectionName) {
    // Intercepta .get() direto na coleção (getFechamentosTodos, etc.)
    const origGet = colRef.get.bind(colRef);
    colRef.get = async function () {
      const snap = await origGet(...arguments);
      const count = snap.docs ? snap.docs.length : (snap.exists ? 1 : 0);
      addReads(collectionName, count);
      updateBadge();
      return snap;
    };

    // Intercepta .where() para encadear novo patch
    const origWhere = colRef.where.bind(colRef);
    colRef.where = function () {
      const q = origWhere(...arguments);
      return patchQuery(q, collectionName);
    };

    // Intercepta .orderBy()
    const origOrderBy = colRef.orderBy.bind(colRef);
    colRef.orderBy = function () {
      const q = origOrderBy(...arguments);
      return patchQuery(q, collectionName);
    };

    // Intercepta .limit()
    const origLimit = colRef.limit.bind(colRef);
    colRef.limit = function () {
      const q = origLimit(...arguments);
      return patchQuery(q, collectionName);
    };

    // Intercepta .doc() para capturar leituras de documento único
    const origDoc = colRef.doc.bind(colRef);
    colRef.doc = function () {
      const docRef = origDoc(...arguments);
      return patchDocRef(docRef, collectionName);
    };

    return colRef;
  }

  function patchQuery(q, collectionName) {
    const origGet = q.get.bind(q);
    q.get = async function () {
      const snap = await origGet(...arguments);
      const count = snap.docs ? snap.docs.length : (snap.exists ? 1 : 0);
      addReads(collectionName, count);
      updateBadge();
      return snap;
    };

    // Encadeia para suportar .where().where(), .where().orderBy(), .where().limit()
    const origWhere = q.where ? q.where.bind(q) : null;
    if (origWhere) {
      q.where = function () {
        return patchQuery(origWhere(...arguments), collectionName);
      };
    }

    const origOrderBy = q.orderBy ? q.orderBy.bind(q) : null;
    if (origOrderBy) {
      q.orderBy = function () {
        return patchQuery(origOrderBy(...arguments), collectionName);
      };
    }

    const origLimit = q.limit ? q.limit.bind(q) : null;
    if (origLimit) {
      q.limit = function () {
        return patchQuery(origLimit(...arguments), collectionName);
      };
    }

    return q;
  }

  function patchDocRef(docRef, collectionName) {
    const origGet = docRef.get.bind(docRef);
    docRef.get = async function () {
      const snap = await origGet(...arguments);
      addReads(collectionName, 1);
      updateBadge();
      return snap;
    };
    return docRef;
  }

  // ── Badge UI ─────────────────────────────────────────────

  let badge    = null;
  let popup    = null;
  let enabled  = false;

  function createBadge() {
    if (badge) return;

    badge = document.createElement('div');
    badge.id = 'db-monitor-badge';
    badge.className = 'nao-imprimir';
    badge.setAttribute('aria-label', 'Monitor de leituras Firestore');
    Object.assign(badge.style, {
      position:     'fixed',
      bottom:       '16px',
      right:        '16px',
      zIndex:       '9999',
      padding:      '6px 12px',
      borderRadius: '999px',
      fontSize:     '0.78rem',
      fontWeight:   '600',
      cursor:       'pointer',
      boxShadow:    '0 2px 8px rgba(0,0,0,.25)',
      userSelect:   'none',
      transition:   'background .3s',
    });

    popup = document.createElement('div');
    popup.id = 'db-monitor-popup';
    popup.className = 'nao-imprimir';
    Object.assign(popup.style, {
      position:     'fixed',
      bottom:       '52px',
      right:        '16px',
      zIndex:       '10000',
      background:   '#fff',
      border:       '1px solid #ccc',
      borderRadius: '10px',
      padding:      '14px 16px',
      minWidth:     '220px',
      boxShadow:    '0 4px 16px rgba(0,0,0,.18)',
      fontSize:     '0.82rem',
      display:      'none',
    });

    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopup();
    });

    document.addEventListener('click', () => {
      if (popup.style.display !== 'none') popup.style.display = 'none';
    });

    document.body.appendChild(badge);
    document.body.appendChild(popup);

    updateBadge();
  }

  function colorForTotal(total) {
    if (total >= 5000) return { bg: '#c62828', color: '#fff' };
    if (total >= 1000) return { bg: '#f9a825', color: '#333' };
    return { bg: '#2e7d32', color: '#fff' };
  }

  function updateBadge() {
    if (!enabled || !badge) return;
    const total = getTotal();
    const { bg, color } = colorForTotal(total);
    badge.style.background = bg;
    badge.style.color = color;
    badge.textContent = `📖 ${total} leituras`;
  }

  function togglePopup() {
    if (popup.style.display !== 'none') {
      popup.style.display = 'none';
      return;
    }
    renderPopup();
    popup.style.display = 'block';
  }

  function renderPopup() {
    const total  = getTotal();
    const detail = getDetail();

    const rows = Object.entries(detail)
      .sort((a, b) => b[1] - a[1])
      .map(([col, n]) => `<tr><td style="padding:2px 8px 2px 0">${col}</td><td style="text-align:right;font-weight:600">${n}</td></tr>`)
      .join('');

    popup.innerHTML = `
      <strong style="display:block;margin-bottom:8px">📊 Leituras da sessão</strong>
      <table style="width:100%;border-collapse:collapse">
        ${rows || '<tr><td colspan="2" style="color:#888">Nenhuma leitura ainda</td></tr>'}
        <tr style="border-top:1px solid #eee">
          <td style="padding-top:6px;font-weight:700">Total</td>
          <td style="padding-top:6px;text-align:right;font-weight:700">${total}</td>
        </tr>
      </table>
      <button id="db-monitor-reset" style="
        margin-top:10px;width:100%;padding:5px 0;border:1px solid #ccc;
        border-radius:6px;background:#f5f5f5;cursor:pointer;font-size:.78rem">
        Zerar
      </button>`;

    document.getElementById('db-monitor-reset').addEventListener('click', (e) => {
      e.stopPropagation();
      resetCounters();
      popup.style.display = 'none';
      updateBadge();
    });
  }

  // ── API pública ──────────────────────────────────────────

  window.dbMonitor = {
    /**
     * Ativa o monitor. Só exibe o badge se perfil === 'Administrador'.
     * @param {string} perfil  Perfil do usuário atual (ex: 'Administrador', 'Fiscal').
     */
    enable(perfil) {
      if (perfil !== 'Administrador') return;
      enabled = true;
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createBadge);
      } else {
        createBadge();
      }
    },
  };

  // ── Inicialização do patch ───────────────────────────────
  // window.db pode ainda não existir quando este script carrega (depende do
  // firebase-config.js e firestore.js). Aguarda o DOMContentLoaded para
  // garantir que todos os scripts síncronos já foram executados.

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchDb);
  } else {
    patchDb();
  }
})();
