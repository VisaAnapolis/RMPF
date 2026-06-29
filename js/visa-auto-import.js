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
// Painel com DUAS regiões independentes: uma barra de PROGRESSO persistente
// (atualizada de forma barata, sem reconstruir o DOM) e uma PILHA de MENSAGENS
// que acumula os últimos avisos. Antes ambas dividiam um único slot
// (wrap.innerHTML): isso (a) reconstruía todo o overlay a cada registro do CSV
// — caro, reflow síncrono — e (b) fazia o progresso e os avisos se
// sobrescreverem. Espelha o padrão do botão manual de parametrização
// (mostrarProgresso + log das últimas mensagens).
let _visaAutoMsgs    = [];   // HTML das últimas mensagens (via alerta())
let _visaAutoLastPct = -1;   // evita tocar o DOM quando o % arredondado não muda

function _visaAutoEls() {
  let wrap = document.getElementById('visa-auto-toast');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'visa-auto-toast';
    wrap.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:9999;max-width:360px;' +
      'display:flex;flex-direction:column;gap:6px';
    wrap.innerHTML =
      '<div id="visa-auto-progress" class="progress-wrap" style="display:none;margin-bottom:0">' +
        '<div class="progress-header">' +
          '<span class="progress-label" id="visa-auto-progress-label">Processando…</span>' +
          '<span class="progress-pct" id="visa-auto-progress-pct">0%</span>' +
        '</div>' +
        '<div class="progress-track"><div class="progress-fill" id="visa-auto-progress-fill"></div></div>' +
      '</div>' +
      '<div id="visa-auto-msgs" class="visa-auto-msgs"></div>';
    document.body.appendChild(wrap);
  }
  return {
    wrap,
    prog:  document.getElementById('visa-auto-progress'),
    label: document.getElementById('visa-auto-progress-label'),
    pct:   document.getElementById('visa-auto-progress-pct'),
    fill:  document.getElementById('visa-auto-progress-fill'),
    msgs:  document.getElementById('visa-auto-msgs'),
  };
}

// Barra de progresso (azul) — só mexe no DOM quando o % arredondado muda.
function _visaAutoProgress(atual, total) {
  if (!total) return;
  const els = _visaAutoEls();
  els.wrap.style.display = '';
  const pct = Math.round((atual / total) * 100);
  if (pct === _visaAutoLastPct) return;
  _visaAutoLastPct = pct;
  els.prog.style.display = '';
  els.fill.style.width   = pct + '%';
  els.pct.textContent    = pct + '%';
  els.label.textContent  = `Importando inspeções do VISA ${atual} de ${total}…`;
}

// Oculta apenas a barra de progresso (mantém as mensagens visíveis).
function _visaAutoProgressHide() {
  _visaAutoLastPct = -1;
  const p = document.getElementById('visa-auto-progress');
  if (p) p.style.display = 'none';
}

// Pilha de mensagens (avisos/infos) — acrescenta mantendo as últimas 6.
function _visaAutoMsg(msg, type) {
  const els = _visaAutoEls();
  els.wrap.style.display = '';
  const html = (typeof alerta === 'function')
    ? alerta(type || 'info', msg)
    : `<div class="alert">${msg}</div>`;
  _visaAutoMsgs.push(html);
  if (_visaAutoMsgs.length > 6) _visaAutoMsgs = _visaAutoMsgs.slice(-6);
  els.msgs.innerHTML = _visaAutoMsgs.join('');
  els.msgs.scrollTop = els.msgs.scrollHeight;
}

// Oculta o painel inteiro e zera o estado das duas regiões.
function _visaAutoToastHide(delayMs) {
  const wrap = document.getElementById('visa-auto-toast');
  if (!wrap) return;
  setTimeout(() => {
    wrap.style.display = 'none';
    _visaAutoMsgs = [];
    _visaAutoLastPct = -1;
    const m = document.getElementById('visa-auto-msgs');     if (m) m.innerHTML = '';
    const p = document.getElementById('visa-auto-progress'); if (p) p.style.display = 'none';
  }, delayMs || 6000);
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
    _visaAutoMsg('🔄 Atualizando inspeções do VISA (todos os fiscais)…', 'info');
    const allFiscais = await window.db_getTodosFiscais();
    const onProgress = (m, t) => _visaAutoMsg(m, t);
    const onProgressBar = (atual, total) => _visaAutoProgress(atual, total);

    try {
      const r = await window.importarInspecoesVISA({
        fiscalEmail: null, mes, ano, allFiscais, onProgress, onProgressBar,
      });
      // 5. Persistir o novo SHA só após sucesso
      await window.db_setImportState({
        visa: { commit_sha: shaAtual, mes: Number(mes), ano: Number(ano), imported_at: new Date().toISOString() },
      });
      const total = r ? ((r.criados || 0) + (r.atualizados || 0)) : 0;
      _visaAutoProgressHide();
      _visaAutoMsg(`✅ Inspeções do VISA atualizadas (${total} lançamento(s) afetado(s)).`, 'ok');
      _visaAutoToastHide(6000);
    } catch (e) {
      // Outro admin já está importando (lock) — sai em silêncio.
      const msg = String(e && e.message || '');
      if (/andamento/i.test(msg)) {
        _visaAutoToastHide(2000);
        return;
      }
      console.warn('[VISA auto-import] Falha na importação automática:', msg);
      _visaAutoProgressHide();
      _visaAutoMsg('⚠️ Falha ao atualizar inspeções do VISA automaticamente.', 'warn');
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
