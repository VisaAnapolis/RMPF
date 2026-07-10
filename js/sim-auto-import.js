// js/sim-auto-import.js
// Importação automática das auditorias do SIM para TODOS os fiscais.
//
// Substitui o clique manual no botão "Importar Auditorias do SIM" (antes nas
// telas do fiscal): roda em sessão de Administrador, ao carregar a página e a
// cada ~10 min enquanto o admin estiver logado. Como a fonte é o Firestore
// (coleção `ordens_servico`) e não há SHA de commit como no VISA, a detecção de
// mudança usa um "watermark" de 1 leitura: o maior `updatedAt` da coleção
// (`db_getMaxUpdatedOrdemServico`), comparado com o valor salvo em
// app_config/import_state.sim. Só quando esse watermark avança é que a
// importação do mês é executada — evitando reler todas as OS a cada ciclo. O
// lock distribuído (sim_import_locks) evita execuções concorrentes entre admins.

const SIM_AUTO_IMPORT_INTERVALO_MS = 10 * 60 * 1000; // 10 min

let _simAutoRodando = false;
let _simAutoTimer   = null;

// ── Toast discreto (canto inferior direito) ──────────────
// Painel com DUAS regiões independentes: uma barra de PROGRESSO persistente
// (atualizada de forma barata, sem reconstruir o DOM) e uma PILHA de MENSAGENS
// que acumula os últimos avisos. Antes ambas dividiam um único slot
// (wrap.innerHTML): isso (a) reconstruía todo o overlay a cada registro — caro,
// reflow síncrono — e (b) fazia o progresso e os avisos se sobrescreverem.
// Espelha o padrão do botão manual de parametrização (mostrarProgresso + log).
let _simAutoMsgs    = [];   // HTML das últimas mensagens (via alerta())
let _simAutoLastPct = -1;   // evita tocar o DOM quando o % arredondado não muda

function _simAutoEls() {
  let wrap = document.getElementById('sim-auto-toast');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'sim-auto-toast';
    wrap.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:9999;max-width:360px;' +
      'display:flex;flex-direction:column;gap:6px';
    wrap.innerHTML =
      '<div id="sim-auto-progress" class="progress-wrap" style="display:none;margin-bottom:0">' +
        '<div class="progress-header">' +
          '<span class="progress-label" id="sim-auto-progress-label">Processando…</span>' +
          '<span class="progress-pct" id="sim-auto-progress-pct">0%</span>' +
        '</div>' +
        '<div class="progress-track"><div class="progress-fill" id="sim-auto-progress-fill"></div></div>' +
      '</div>' +
      '<div id="sim-auto-msgs" class="sim-auto-msgs"></div>';
    document.body.appendChild(wrap);
  }
  return {
    wrap,
    prog:  document.getElementById('sim-auto-progress'),
    label: document.getElementById('sim-auto-progress-label'),
    pct:   document.getElementById('sim-auto-progress-pct'),
    fill:  document.getElementById('sim-auto-progress-fill'),
    msgs:  document.getElementById('sim-auto-msgs'),
  };
}

// Barra de progresso (azul) — só mexe no DOM quando o % arredondado muda.
function _simAutoProgress(atual, total) {
  if (!total) return;
  const els = _simAutoEls();
  els.wrap.style.display = '';
  const pct = Math.round((atual / total) * 100);
  if (pct === _simAutoLastPct) return;
  _simAutoLastPct = pct;
  els.prog.style.display = '';
  els.fill.style.width   = pct + '%';
  els.pct.textContent    = pct + '%';
  els.label.textContent  = `Importando auditorias do SIM ${atual} de ${total}…`;
}

// Oculta apenas a barra de progresso (mantém as mensagens visíveis).
function _simAutoProgressHide() {
  _simAutoLastPct = -1;
  const p = document.getElementById('sim-auto-progress');
  if (p) p.style.display = 'none';
}

// Pilha de mensagens (avisos/infos) — acrescenta mantendo as últimas 6.
function _simAutoMsg(msg, type) {
  const els = _simAutoEls();
  els.wrap.style.display = '';
  const html = (typeof alerta === 'function')
    ? alerta(type || 'info', msg)
    : `<div class="alert">${msg}</div>`;
  _simAutoMsgs.push(html);
  if (_simAutoMsgs.length > 6) _simAutoMsgs = _simAutoMsgs.slice(-6);
  els.msgs.innerHTML = _simAutoMsgs.join('');
  els.msgs.scrollTop = els.msgs.scrollHeight;
}

// Oculta o painel inteiro e zera o estado das duas regiões.
function _simAutoToastHide(delayMs) {
  const wrap = document.getElementById('sim-auto-toast');
  if (!wrap) return;
  setTimeout(() => {
    wrap.style.display = 'none';
    _simAutoMsgs = [];
    _simAutoLastPct = -1;
    const m = document.getElementById('sim-auto-msgs');     if (m) m.innerHTML = '';
    const p = document.getElementById('sim-auto-progress'); if (p) p.style.display = 'none';
  }, delayMs || 6000);
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

    // 2. Watermark atual: maior updatedAt em ordens_servico (1 leitura)
    let watermark;
    try {
      watermark = await window.db_getMaxUpdatedOrdemServico();
    } catch (e) {
      console.warn('[SIM auto-import] Não foi possível obter o watermark de ordens_servico:', e.message);
      return;
    }

    // 3. Comparar com o estado salvo — pular se mesma competência e watermark não avançou
    let state = {};
    try { state = await window.db_getImportState(); } catch (_) {}
    const st = state && state.sim;
    if (st && Number(st.mes) === Number(mes) && Number(st.ano) === Number(ano) &&
        Number(st.watermark) >= watermark) {
      return; // nada mudou desde a última importação — nada a fazer
    }

    // 4. Importar todos os fiscais
    _simAutoMsg('🔄 Atualizando auditorias do SIM (todos os fiscais)…', 'info');
    const allFiscais = await window.db_getTodosFiscais();
    const onProgress = (m, t) => _simAutoMsg(m, t);
    const onProgressBar = (atual, total) => _simAutoProgress(atual, total);

    // Medição da execução (painel Custo & Leituras): leituras via delta do
    // contador de sessão (js/firebase-config.js) + duração + resultados.
    const _runT0 = Date.now();
    const _runR0 = (typeof window.rmReadsSession === 'function') ? window.rmReadsSession() : 0;
    if (typeof window.rmSetReadContext === 'function') window.rmSetReadContext('import_sim');

    try {
      const r = await window.importarAuditoriasSIM({
        fiscalEmail: null, mes, ano, allFiscais, onProgress, onProgressBar,
      });
      // 5. Persistir o novo watermark só após sucesso — junto com o histórico
      // de execuções (runs, últimos 60) que alimenta o painel de monitoramento.
      const _runEntry = {
        tipo: 'sim', ts: new Date().toISOString(),
        dur_s: Math.round((Date.now() - _runT0) / 1000),
        leituras: (typeof window.rmReadsSession === 'function') ? (window.rmReadsSession() - _runR0) : null,
        criados: (r && r.criados) || 0, atualizados: (r && r.atualizados) || 0,
        ignorados: (r && r.ignorados) || 0, excluidos: (r && r.excluidos) || 0,
        erros: (r && r.erros) || 0,
        mes: Number(mes), ano: Number(ano), watermark,
      };
      const _runs = (Array.isArray(state.runs) ? state.runs : []).concat(_runEntry).slice(-60);
      await window.db_setImportState({
        sim: {
          watermark,
          mes: Number(mes), ano: Number(ano), imported_at: new Date().toISOString(),
        },
        runs: _runs,
      });
      const total = r ? ((r.criados || 0) + (r.atualizados || 0)) : 0;
      _simAutoProgressHide();
      _simAutoMsg(`✅ Auditorias do SIM atualizadas (${total} lançamento(s) afetado(s)).`, 'ok');
      _simAutoToastHide(6000);
    } catch (e) {
      // Outro admin já está importando (lock) — sai em silêncio.
      const msg = String(e && e.message || '');
      if (/andamento/i.test(msg)) {
        _simAutoToastHide(2000);
        return;
      }
      console.warn('[SIM auto-import] Falha na importação automática:', msg);
      _simAutoProgressHide();
      _simAutoMsg('⚠️ Falha ao atualizar auditorias do SIM automaticamente.', 'warn');
      _simAutoToastHide(8000);
    }
  } finally {
    if (typeof window.rmSetReadContext === 'function') window.rmSetReadContext(null);
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
