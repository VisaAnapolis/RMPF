// js/visa-auto-import.js
// Importação automática das inspeções do VISA para TODOS os fiscais.
//
// Substitui o clique manual no botão "Importar Inspeções do CVS": roda em
// sessão de Administrador, ao carregar a página e a cada ~10 min enquanto o
// admin estiver logado. Só dispara a importação pesada quando algum dos CSVs
// mudou de fato — comparando o SHA do último commit que tocou
// data/inspecoes.csv e data/inspecoes_cnae.csv (CNAEs extras informados pelo
// fiscal) com o estado salvo em app_config/import_state. O lock distribuído
// (visa_import_locks) evita execuções concorrentes entre vários admins.

const VISA_AUTO_IMPORT_INTERVALO_MS = 10 * 60 * 1000; // 10 min
const VISA_AUTO_IMPORT_ARQUIVO      = 'data/inspecoes.csv';
const VISA_AUTO_IMPORT_ARQUIVO_CNAE = 'data/inspecoes_cnae.csv';

// TODOS os arquivos que alteram o resultado da importação. Antes só os dois
// primeiros eram vigiados, então mudança em requerimento/oficio/taxa/cnae/
// fiscais extras não disparava reimportação nenhuma — e o Firestore ficava
// desatualizado em relação ao WCVS sem ninguém perceber.
const VISA_AUTO_IMPORT_ARQUIVOS = [
  'data/inspecoes.csv',
  'data/inspecoes_cnae.csv',
  'data/inspecoes_fiscais.csv',
  'data/requerimento.csv',
  'data/oficio.csv',
  'data/denuncia.csv',
  'data/tramitacao.csv',
  'data/cnae.csv',
  'data/regulados.csv',
  'data/taxa.csv',
];

let _visaAutoRodando = false;
let _visaAutoTimer   = null;

// Mapa { caminho: blobSha } dos arquivos vigiados. Uma única chamada lista o
// diretório inteiro; se a rota falhar, cai no SHA de commit por arquivo.
async function visaBlobShasAtuais() {
  let todos = null;
  try {
    todos = await window.fetchGitHubDirBlobShas('data');
  } catch (e) {
    console.warn('[VISA auto-import] Listagem do diretório falhou, usando SHA por arquivo:', e.message);
  }
  const out = {};
  if (todos) {
    for (const p of VISA_AUTO_IMPORT_ARQUIVOS) if (todos[p]) out[p] = todos[p];
    return out;
  }
  for (const p of VISA_AUTO_IMPORT_ARQUIVOS) {
    try {
      const s = await window.fetchGitHubFileCommitSha(p);
      if (s) out[p] = s;
    } catch (_) { /* arquivo ausente/erro pontual não bloqueia os demais */ }
  }
  return out;
}

function visaShasMudaram(anterior, atual) {
  const a = anterior || {}, b = atual || {};
  const chaves = new Set(Object.keys(a).concat(Object.keys(b)));
  for (const k of chaves) if ((a[k] || null) !== (b[k] || null)) return true;
  return false;
}

// Persiste o estado da importação (SHAs + competência) e o histórico de
// execuções. Extraído do fluxo automático para que a importação MANUAL também
// registre — sem isso o auto-import redisparava logo depois de um import manual.
async function registrarImportStateVisa(r, mes, ano, blobShas, opts) {
  opts = opts || {};
  let state = opts.state;
  if (!state) {
    try { state = await window.db_getImportState(); } catch (_) { state = {}; }
  }
  const runEntry = {
    tipo: opts.tipo || 'visa', ts: new Date().toISOString(),
    dur_s: opts.dur_s != null ? opts.dur_s : null,
    leituras: opts.leituras != null ? opts.leituras : null,
    criados: (r && r.criados) || 0, atualizados: (r && r.atualizados) || 0,
    ignorados: (r && r.ignorados) || 0, excluidos: (r && r.excluidos) || 0,
    reabertos: (r && r.reabertos) || 0,
    reabertos_orfaos: (r && r.reabertos_orfaos) || 0,
    reabertos_incompat: (r && r.reabertos_incompat) || 0,
    erros: (r && r.erros) || 0,
    mes: Number(mes), ano: Number(ano),
    csv_sha: String((blobShas && blobShas[VISA_AUTO_IMPORT_ARQUIVO]) || '').slice(0, 10),
  };
  const runs = (Array.isArray(state.runs) ? state.runs : []).concat(runEntry).slice(-60);
  const patch = { runs };
  // Só carimba a competência/SHAs quando os SHAs foram de fato apurados; um
  // import manual de mês diverso não pode marcar a competência aberta como
  // "já importada".
  if (blobShas) {
    patch.visa = {
      blob_shas: blobShas,
      mes: Number(mes), ano: Number(ano),
      imported_at: new Date().toISOString(),
    };
  }
  await window.db_setImportState(patch);
}

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

    // 2. SHAs atuais de TODOS os CSVs que a importação consome (1 request)
    let blobShas;
    try {
      blobShas = await visaBlobShasAtuais();
    } catch (e) {
      // Token ausente/expirado ou falha de rede — não quebra a página.
      console.warn('[VISA auto-import] Não foi possível obter os SHAs dos CSVs:', e.message);
      return;
    }
    if (!blobShas || !blobShas[VISA_AUTO_IMPORT_ARQUIVO]) return;

    // 3. Comparar com o estado salvo. Estado no formato antigo (commit_sha /
    //    commit_sha_cnae) conta como "mudou": dispara uma importação extra,
    //    idempotente, e já grava o formato novo.
    let state = {};
    try { state = await window.db_getImportState(); } catch (_) {}
    const st = state && state.visa;
    if (st && st.blob_shas && !visaShasMudaram(st.blob_shas, blobShas) &&
        Number(st.mes) === Number(mes) && Number(st.ano) === Number(ano)) {
      return; // já importado para esta versão dos CSVs — nada a fazer
    }

    // 4. Importar todos os fiscais
    _visaAutoMsg('🔄 Atualizando inspeções do VISA (todos os fiscais)…', 'info');
    const allFiscais = await window.db_getTodosFiscais();
    const onProgress = (m, t) => _visaAutoMsg(m, t);
    const onProgressBar = (atual, total) => _visaAutoProgress(atual, total);

    // Medição da execução (painel Custo & Leituras): leituras via delta do
    // contador de sessão (js/firebase-config.js) + duração + resultados.
    const _runT0 = Date.now();
    const _runR0 = (typeof window.rmReadsSession === 'function') ? window.rmReadsSession() : 0;
    if (typeof window.rmSetReadContext === 'function') window.rmSetReadContext('import_visa');

    try {
      const r = await window.importarInspecoesVISA({
        fiscalEmail: null, mes, ano, allFiscais, onProgress, onProgressBar,
      });
      // 5. Persistir os novos SHAs só após sucesso — junto com o histórico de
      // execuções (runs, últimos 60) que alimenta o painel de monitoramento.
      await registrarImportStateVisa(r, mes, ano, blobShas, {
        tipo: 'visa', dur_s: Math.round((Date.now() - _runT0) / 1000),
        leituras: (typeof window.rmReadsSession === 'function') ? (window.rmReadsSession() - _runR0) : null,
        state,
      });
      const total = r ? ((r.criados || 0) + (r.atualizados || 0)) : 0;
      const reab = r ? ((r.reabertos || 0) + (r.reabertos_orfaos || 0) + (r.reabertos_incompat || 0)) : 0;
      _visaAutoProgressHide();
      _visaAutoMsg(`✅ Inspeções do VISA atualizadas (${total} lançamento(s) afetado(s)).`, 'ok');
      if (reab) {
        _visaAutoMsg(`🔄 ${reab} lançamento(s) reaberto(s) para nova homologação — confira na Conferência.`, 'warn');
      }
      _visaAutoToastHide(reab ? 12000 : 6000);
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
    if (typeof window.rmSetReadContext === 'function') window.rmSetReadContext(null);
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
window.visaBlobShasAtuais       = visaBlobShasAtuais;
window.registrarImportStateVisa = registrarImportStateVisa;
