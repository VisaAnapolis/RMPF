// js/sim-auto-import.js
// Importação automática das auditorias do SIM para TODOS os fiscais.
//
// Substitui o clique manual no botão "Importar Auditorias do SIM" (antes nas
// telas do fiscal): roda em sessão de Administrador, ao carregar a página e a
// cada ~10 min enquanto o admin estiver logado. Como a fonte é o Firestore
// (coleção `ordens_servico`) e não há SHA de commit como no VISA, a detecção de
// mudança usa uma assinatura leve da competência aberta — quantidade de OS
// concluídas + maior `updatedAt` — comparada com o estado salvo em
// app_config/import_state. O lock distribuído (sim_import_locks) evita
// execuções concorrentes entre vários admins.

const SIM_AUTO_IMPORT_INTERVALO_MS = 10 * 60 * 1000; // 10 min

let _simAutoRodando = false;
let _simAutoTimer   = null;

// ── Toast discreto (canto inferior direito) ──────────────
function _simAutoToast(msg, type) {
  let wrap = document.getElementById('sim-auto-toast');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'sim-auto-toast';
    wrap.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:9999;max-width:360px;' +
      'display:flex;flex-direction:column;gap:6px';
    document.body.appendChild(wrap);
  }
  const html = (typeof alerta === 'function')
    ? alerta(type || 'info', msg)
    : `<div class="alert">${msg}</div>`;
  wrap.innerHTML = html;
  wrap.style.display = '';
}
function _simAutoToastHide(delayMs) {
  const wrap = document.getElementById('sim-auto-toast');
  if (!wrap) return;
  setTimeout(() => { wrap.style.display = 'none'; wrap.innerHTML = ''; }, delayMs || 6000);
}

// Normaliza statusOs (tolerante a caixa/acentuação) — mesmo critério do
// sim-import.js para identificar "concluida".
function _simNormStatus(v) {
  return String(v || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
}

// Converte um valor de data/Timestamp em milissegundos (0 se inválido).
function _simToMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

// Assinatura leve da competência: { qtd, maxUpdatedMs } das OS concluídas.
async function _simAssinatura(mes, ano) {
  const ordens = await window.db_getOrdensServicoConcluidas(mes, ano, null);
  let qtd = 0, maxUpdatedMs = 0;
  for (const o of (ordens || [])) {
    if (_simNormStatus(o.statusOs) !== 'concluida') continue;
    qtd++;
    const ms = _simToMillis(o.updatedAt);
    if (ms > maxUpdatedMs) maxUpdatedMs = ms;
  }
  return { qtd, maxUpdatedMs };
}

// Verifica se há auditorias novas/alteradas desde a última importação automática
// e, em caso afirmativo, importa para todos os fiscais na competência aberta.
async function verificarEImportarSIM(user) {
  if (_simAutoRodando) return;
  if (!user || user.perfil !== 'Administrador') return;
  if (typeof window.importarAuditoriasSIM !== 'function' ||
      typeof window.simMesAberto !== 'function') return;

  _simAutoRodando = true;
  try {
    // 1. Competência aberta
    let mes, ano;
    try {
      ({ mes, ano } = await window.db_getProximaCompetencia());
    } catch (_) {
      const now = new Date();
      mes = now.getMonth() + 1; ano = now.getFullYear();
    }
    if (!window.simMesAberto(mes, ano)) return;

    // 2. Assinatura atual da competência (read barato; reaproveita a query de import)
    let sig;
    try {
      sig = await _simAssinatura(mes, ano);
    } catch (e) {
      console.warn('[SIM auto-import] Não foi possível obter as ordens concluídas:', e.message);
      return;
    }

    // 3. Comparar com o estado salvo
    let state = {};
    try { state = await window.db_getImportState(); } catch (_) {}
    const st = state && state.sim;
    if (st && Number(st.mes) === Number(mes) && Number(st.ano) === Number(ano) &&
        Number(st.qtd) === sig.qtd && Number(st.max_updated) === sig.maxUpdatedMs) {
      return; // nada mudou desde a última importação — nada a fazer
    }

    // 4. Importar todos os fiscais
    _simAutoToast('🔄 Atualizando auditorias do SIM (todos os fiscais)…', 'info');
    const allFiscais = await window.db_getTodosFiscais();
    const onProgress = (m, t) => _simAutoToast(m, t);
    const onProgressBar = (atual, total) => {
      if (!total) return;
      const pct = Math.round((atual / total) * 100);
      _simAutoToast(`🔄 Importando auditorias do SIM… ${pct}%`, 'info');
    };

    try {
      const r = await window.importarAuditoriasSIM({
        fiscalEmail: null, mes, ano, allFiscais, onProgress, onProgressBar,
      });
      // 5. Persistir a nova assinatura só após sucesso
      await window.db_setImportState({
        sim: {
          qtd: sig.qtd, max_updated: sig.maxUpdatedMs,
          mes: Number(mes), ano: Number(ano), imported_at: new Date().toISOString(),
        },
      });
      const total = r ? ((r.criados || 0) + (r.atualizados || 0)) : 0;
      _simAutoToast(`✅ Auditorias do SIM atualizadas (${total} lançamento(s) afetado(s)).`, 'ok');
      _simAutoToastHide(6000);
    } catch (e) {
      // Outro admin já está importando (lock) — sai em silêncio.
      const msg = String(e && e.message || '');
      if (/andamento/i.test(msg)) {
        _simAutoToastHide(2000);
        return;
      }
      console.warn('[SIM auto-import] Falha na importação automática:', msg);
      _simAutoToast('⚠️ Falha ao atualizar auditorias do SIM automaticamente.', 'warn');
      _simAutoToastHide(8000);
    }
  } finally {
    _simAutoRodando = false;
  }
}

// Inicia o auto-import: roda 1x ao carregar e agenda o polling periódico.
// Só tem efeito para perfil Administrador.
function iniciarAutoImportSIM(user) {
  if (!user || user.perfil !== 'Administrador') return;
  if (_simAutoTimer) return; // já iniciado nesta página
  // Primeira execução logo após o carregamento.
  verificarEImportarSIM(user);
  _simAutoTimer = setInterval(() => verificarEImportarSIM(user), SIM_AUTO_IMPORT_INTERVALO_MS);
}

window.verificarEImportarSIM = verificarEImportarSIM;
window.iniciarAutoImportSIM  = iniciarAutoImportSIM;
