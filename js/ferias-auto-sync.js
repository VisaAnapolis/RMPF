// js/ferias-auto-sync.js
// Sincronização automática das FÉRIAS (mantidas pela gestão no app VISA, doc
// `ferias/escala`) para a coleção `ocorrencias` do RMPF.
//
// Substitui o lançamento manual do tipo "Férias" pelo fiscal: roda em sessão de
// Administrador, ao carregar a página. Como a fonte é o Firestore (doc único
// `ferias/escala`, mesmo projeto visam-3a30b) e há um `updatedAt` de servidor a
// cada save do VISA, a detecção de mudança usa esse timestamp como "watermark":
// só quando ele avança (ou muda a competência aberta) é que a reconciliação é
// executada — caso contrário é apenas 1 leitura barata. Um lock distribuído
// (ferias_sync_locks/escala) evita execuções concorrentes entre admins.
//
// Escopo: só a COMPETÊNCIA ABERTA (db_getProximaCompetencia). Sub-períodos de
// férias que caem em meses fechados/passados não são tocados. As ocorrências
// criadas nascem `status:'pendente'` (idêntico ao lançamento manual) e carregam
// `origem:'ferias_visa'` para permitir a reconciliação (criar/remover) e nunca
// afetar lançamentos manuais. O aceite (geração de pontos em `manuais`) continua
// sendo feito pelo administrador na própria ocorrencias.html.

let _feriasSyncRodando = false;
let _feriasSyncIniciado = false;

// ── Toast discreto (canto inferior direito) — espelha sim-auto-import.js ──
let _feriasSyncMsgs = [];

function _feriasSyncEls() {
  let wrap = document.getElementById('ferias-sync-toast');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'ferias-sync-toast';
    wrap.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:9999;max-width:360px;' +
      'display:flex;flex-direction:column;gap:6px';
    wrap.innerHTML = '<div id="ferias-sync-msgs" class="ferias-sync-msgs"></div>';
    document.body.appendChild(wrap);
  }
  return { wrap, msgs: document.getElementById('ferias-sync-msgs') };
}

function _feriasSyncMsg(msg, type) {
  const els = _feriasSyncEls();
  els.wrap.style.display = '';
  const html = (typeof alerta === 'function')
    ? alerta(type || 'info', msg)
    : `<div class="alert">${msg}</div>`;
  _feriasSyncMsgs.push(html);
  if (_feriasSyncMsgs.length > 6) _feriasSyncMsgs = _feriasSyncMsgs.slice(-6);
  els.msgs.innerHTML = _feriasSyncMsgs.join('');
  els.msgs.scrollTop = els.msgs.scrollHeight;
}

function _feriasSyncToastHide(delayMs) {
  const wrap = document.getElementById('ferias-sync-toast');
  if (!wrap) return;
  setTimeout(() => {
    wrap.style.display = 'none';
    _feriasSyncMsgs = [];
    const m = document.getElementById('ferias-sync-msgs');
    if (m) m.innerHTML = '';
  }, delayMs || 7000);
}

// Chave de deduplicação/reconciliação de uma (sub)ocorrência de férias.
function _feriasKey(email, dataInicio, dataFim) {
  return `${email}|${dataInicio}|${dataFim || dataInicio}`;
}

// Lê a escala do VISA e reconcilia as ocorrências de férias da competência
// aberta, criando as que faltam e removendo as que saíram do VISA.
async function verificarESincronizarFerias(user) {
  if (_feriasSyncRodando) return;
  if (!user || user.perfil !== 'Administrador') return;
  if (typeof window.db_getFeriasEscala !== 'function' ||
      typeof window.db_getProximaCompetencia !== 'function') return;

  _feriasSyncRodando = true;
  try {
    // 1. Competência aberta (mesmo critério dos imports SIM/VISA)
    let mes, ano;
    try {
      ({ mes, ano } = await window.db_getProximaCompetencia());
    } catch (_) {
      const now = new Date();
      mes = now.getMonth() + 1; ano = now.getFullYear();
    }
    mes = Number(mes); ano = Number(ano);

    // 2. Ler a escala + watermark (1 leitura)
    let escala;
    try {
      escala = await window.db_getFeriasEscala();
    } catch (e) {
      console.warn('[Férias sync] Não foi possível ler ferias/escala:', e.message);
      return;
    }
    const periodos = (escala && Array.isArray(escala.periodos)) ? escala.periodos : [];
    const watermark = escala && escala.updatedAt && escala.updatedAt.toMillis
      ? escala.updatedAt.toMillis() : 0;

    // 3. Comparar com o estado salvo — pular se mesma competência e watermark igual
    let state = {};
    try { state = await window.db_getImportState(); } catch (_) {}
    const st = state && state.ferias;
    if (st && Number(st.mes) === mes && Number(st.ano) === ano &&
        Number(st.watermark) === watermark) {
      return; // nada mudou desde a última sincronização desta competência
    }

    // 4. Lock distribuído
    try {
      await window.db_acquireFeriasSyncLock(user.email, user.nome || user.email);
    } catch (e) {
      // Outro admin já está sincronizando — sai em silêncio.
      if (/andamento/i.test(String(e && e.message || ''))) return;
      console.warn('[Férias sync] Falha ao obter lock:', e && e.message);
      return;
    }

    try {
      // 5. Mapa nome→email dos fiscais do RMPF (perfil Fiscal)
      const fiscais = await window.db_getTodosFiscais();
      const mapaNome = new Map();
      fiscais.forEach(f => {
        const n = window.normalizarNome(f.nome);
        if (n) mapaNome.set(n, { email: f.email || f.id, nome: f.nome || (f.email || f.id) });
      });

      // 6. Conjunto DESEJADO — só sub-períodos que caem na competência aberta
      //    A coleção ferias tem dois tipos de lançamento no mesmo array
      //    (ex.: "Férias" e "Licença-prêmio"), distinguidos pelo campo `obs`.
      //    Aqui só entram os de FÉRIAS (obs == "Férias", tolerante a caixa/acento).
      const desejadas = new Map(); // key -> {email, nome, mes, ano, data_inicio, data_fim}
      const naoResolvidos = new Set();
      let ignorados = 0; // lançamentos que não são férias (obs != "Férias")
      for (const p of periodos) {
        if (!p || !p.nome || !p.inicio || !p.fim) continue;
        if (window.normalizarNome(p.obs) !== 'ferias') { ignorados++; continue; }
        if (p.fim < p.inicio) continue;
        const alvo = mapaNome.get(window.normalizarNome(p.nome));
        if (!alvo) { naoResolvidos.add(String(p.nome).trim()); continue; }
        const porMes = window.diasDaOcorrenciaPorMes(p.inicio, p.fim);
        for (const parte of Object.values(porMes)) {
          if (Number(parte.mes) !== mes || Number(parte.ano) !== ano) continue; // só competência aberta
          const ini = parte.dias[0];
          const fimReal = parte.dias[parte.dias.length - 1];
          const data_fim = (fimReal === ini) ? null : fimReal;
          desejadas.set(_feriasKey(alvo.email, ini, data_fim), {
            email: alvo.email, nome: alvo.nome,
            mes: parte.mes, ano: parte.ano,
            data_inicio: ini, data_fim,
          });
        }
      }

      // 7. Conjunto EXISTENTE (origem ferias_visa) restrito à competência aberta
      const todasAuto = await window.db_getOcorrenciasPorOrigem('ferias_visa');
      const existentes = new Map();
      todasAuto.forEach(o => {
        if (Number(o.mes) !== mes || Number(o.ano) !== ano) return;
        existentes.set(_feriasKey(o.fiscal_email, o.data_inicio, o.data_fim), o);
      });

      // 8. Reconciliação
      let criadas = 0, removidas = 0;
      const conflitos = [];

      // 8a. Remover as que saíram/mudaram no VISA (espelhar). Se aceita, apaga
      //     antes os manuais (pontos) gerados por ela.
      for (const [key, o] of existentes) {
        if (desejadas.has(key)) continue;
        try {
          if (o.status === 'aceito') {
            const ms = await window.db_getManuaisPorOcorrencia(o.id);
            for (const m of ms) { try { await window.db_deleteManual(m.id); } catch (_) {} }
          }
          await window.db_deleteOcorrencia(o.id);
          removidas++;
        } catch (e) {
          console.warn('[Férias sync] Falha ao remover ocorrência', o.id, e && e.message);
        }
      }

      // 8b. Criar as novas — reusa a validação de sobreposição do lançamento
      //     manual, ignorando as próprias (origem ferias_visa).
      for (const [key, d] of desejadas) {
        if (existentes.has(key)) continue; // já existe, nada a fazer
        try {
          const conflito = await window.ocorrenciaConflitante(
            d.email, d.data_inicio, d.data_fim, null, { ignorarOrigem: 'ferias_visa' });
          if (conflito) {
            conflitos.push(`${window.nomeCurto ? window.nomeCurto(d.nome) : d.nome} (${window.fmtData(d.data_inicio)})`);
            continue;
          }
          await window.db_createOcorrencia({
            fiscal_email: d.email,
            fiscal_nome:  d.nome,
            mes: d.mes, ano: d.ano,
            tipo: 'ferias',
            data_inicio: d.data_inicio,
            data_fim: d.data_fim,
            descricao: 'Férias — sincronizado automaticamente do VISA',
            status: 'pendente',
            origem: 'ferias_visa',
            dispositivo_legal: window.dispositivoLegalOcorrencia
              ? window.dispositivoLegalOcorrencia('ferias')
              : 'Art. 11, inciso I, da Lei Complementar nº 548/2023',
          });
          criadas++;
        } catch (e) {
          console.warn('[Férias sync] Falha ao criar ocorrência para', d.email, e && e.message);
        }
      }

      // 9. Persistir o novo watermark só após sucesso
      await window.db_setImportState({
        ferias: { watermark, mes, ano, synced_at: new Date().toISOString() },
      });

      // 10. Feedback
      const compLabel = window.mesAnoLabel ? window.mesAnoLabel(mes, ano) : `${mes}/${ano}`;
      console.info(
        `[Férias sync] ${compLabel}: periodos=${periodos.length}, ignorados(não-férias)=${ignorados}, ` +
        `desejadas(mês aberto)=${desejadas.size}, existentes=${existentes.size}, ` +
        `criadas=${criadas}, removidas=${removidas}, conflitos=${conflitos.length}, ` +
        `nomesNaoResolvidos=${naoResolvidos.size}`);
      // Toast isolado: um erro ao renderizar nunca pode invalidar a
      // reconciliação (que já foi persistida) nem o valor de retorno.
      if (criadas || removidas || naoResolvidos.size || conflitos.length) {
        try {
          _feriasSyncMsg(
            `✅ Férias sincronizadas (${compLabel}): ${criadas} criada(s), ${removidas} removida(s).`, 'ok');
          if (conflitos.length) {
            _feriasSyncMsg(
              `⚠️ ${conflitos.length} período(s) não criado(s) por conflito com outra ocorrência: ` +
              conflitos.join(', ') + '.', 'warn');
          }
          if (naoResolvidos.size) {
            _feriasSyncMsg(
              `⚠️ Nome(s) de férias sem fiscal correspondente no cadastro (grupo/perfil Fiscal): ` +
              [...naoResolvidos].join(', ') + '. Ajuste o nome no VISA ou o cadastro.', 'warn');
          }
          _feriasSyncToastHide(12000);
        } catch (e) {
          console.warn('[Férias sync] Falha ao exibir aviso (ignorado):', e && e.message);
        }
      }

      return { criadas, removidas, ignorados, conflitos: conflitos.length, naoResolvidos: naoResolvidos.size };
    } finally {
      try { await window.db_releaseFeriasSyncLock(); } catch (_) {}
    }
  } catch (e) {
    console.warn('[Férias sync] Falha na sincronização automática:', e && e.message);
  } finally {
    _feriasSyncRodando = false;
  }
}

// Inicia a sincronização: roda 1x ao carregar a página. Só tem efeito para
// perfil Administrador. Férias mudam raramente (~1x/mês) e o watermark evita
// trabalho quando nada mudou, então não há polling periódico.
function iniciarAutoSyncFerias(user) {
  if (!user || user.perfil !== 'Administrador') return;
  if (_feriasSyncIniciado) return; // já iniciado nesta página
  _feriasSyncIniciado = true;
  verificarESincronizarFerias(user);
}

window.verificarESincronizarFerias = verificarESincronizarFerias;
window.iniciarAutoSyncFerias       = iniciarAutoSyncFerias;
