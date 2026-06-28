// js/visa-auto-import.js
// Importação automática das inspeções do VISA para TODOS os fiscais.
//
// Substitui o clique manual no botão "Importar Inspeções do CVS": roda em
// sessão de Administrador, ao carregar a página e a cada ~10 min enquanto o
// admin estiver logado. Só dispara a importação pesada quando o CSV mudou de
// fato — comparando o SHA do último commit que tocou data/inspecoes.csv com o
// estado salvo em app_config/import_state. O lock distribuído (visa_import_locks)
// evita execuções concorrentes entre vários admins.

const VISA_AUTO_IMPORT_INTERVALO_MS = 10 * 60 * 1000; // 10 min
const VISA_AUTO_IMPORT_ARQUIVO      = 'data/inspecoes.csv';

let _visaAutoRodando = false;
let _visaAutoTimer   = null;

// ── Toast discreto (canto inferior direito) ──────────────
function _visaAutoToast(msg, type) {
  let wrap = document.getElementById('visa-auto-toast');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'visa-auto-toast';
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
function _visaAutoToastHide(delayMs) {
  const wrap = document.getElementById('visa-auto-toast');
  if (!wrap) return;
  setTimeout(() => { wrap.style.display = 'none'; wrap.innerHTML = ''; }, delayMs || 6000);
}

// Verifica se o CSV de inspeções mudou desde a última importação automática e,
// em caso afirmativo, importa para todos os fiscais na competência aberta.
async function verificarEImportarVISA(user) {
  if (_visaAutoRodando) return;
  if (!user || user.perfil !== 'Administrador') return;
  if (typeof window.importarInspecoesVISA !== 'function' ||
      typeof window.visaMesAberto !== 'function') return;

  _visaAutoRodando = true;
  try {
    // 1. Competência aberta
    let mes, ano;
    try {
      ({ mes, ano } = await window.db_getProximaCompetencia());
    } catch (_) {
      const now = new Date();
      mes = now.getMonth() + 1; ano = now.getFullYear();
    }
    if (!window.visaMesAberto(mes, ano)) return;

    // 2. SHA atual do CSV (request barato; lança se não houver token)
    let shaAtual;
    try {
      shaAtual = await window.fetchGitHubFileCommitSha(VISA_AUTO_IMPORT_ARQUIVO);
    } catch (e) {
      // Token ausente/expirado ou falha de rede — não quebra a página.
      console.warn('[VISA auto-import] Não foi possível obter o SHA do CSV:', e.message);
      return;
    }
    if (!shaAtual) return;

    // 3. Comparar com o estado salvo
    let state = {};
    try { state = await window.db_getImportState(); } catch (_) {}
    const st = state && state.visa;
    if (st && st.commit_sha === shaAtual && Number(st.mes) === Number(mes) && Number(st.ano) === Number(ano)) {
      return; // já importado para esta versão do CSV — nada a fazer
    }

    // 4. Importar todos os fiscais
    _visaAutoToast('🔄 Atualizando inspeções do VISA (todos os fiscais)…', 'info');
    const allFiscais = await window.db_getTodosFiscais();
    const onProgress = (m, t) => _visaAutoToast(m, t);
    const onProgressBar = (atual, total) => {
      if (!total) return;
      const pct = Math.round((atual / total) * 100);
      _visaAutoToast(`🔄 Importando inspeções do VISA… ${pct}%`, 'info');
    };

    try {
      const r = await window.importarInspecoesVISA({
        fiscalEmail: null, mes, ano, allFiscais, onProgress, onProgressBar,
      });
      // 5. Persistir o novo SHA só após sucesso
      await window.db_setImportState({
        visa: { commit_sha: shaAtual, mes: Number(mes), ano: Number(ano), imported_at: new Date().toISOString() },
      });
      const total = r ? ((r.criados || 0) + (r.atualizados || 0)) : 0;
      _visaAutoToast(`✅ Inspeções do VISA atualizadas (${total} lançamento(s) afetado(s)).`, 'ok');
      _visaAutoToastHide(6000);
    } catch (e) {
      // Outro admin já está importando (lock) — sai em silêncio.
      const msg = String(e && e.message || '');
      if (/andamento/i.test(msg)) {
        _visaAutoToastHide(2000);
        return;
      }
      console.warn('[VISA auto-import] Falha na importação automática:', msg);
      _visaAutoToast('⚠️ Falha ao atualizar inspeções do VISA automaticamente.', 'warn');
      _visaAutoToastHide(8000);
    }
  } finally {
    _visaAutoRodando = false;
  }
}

// Inicia o auto-import: roda 1x ao carregar e agenda o polling periódico.
// Só tem efeito para perfil Administrador.
function iniciarAutoImportVISA(user) {
  if (!user || user.perfil !== 'Administrador') return;
  if (_visaAutoTimer) return; // já iniciado nesta página
  // Primeira execução logo após o carregamento.
  verificarEImportarVISA(user);
  _visaAutoTimer = setInterval(() => verificarEImportarVISA(user), VISA_AUTO_IMPORT_INTERVALO_MS);
}

window.verificarEImportarVISA = verificarEImportarVISA;
window.iniciarAutoImportVISA  = iniciarAutoImportVISA;
