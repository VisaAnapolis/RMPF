// js/ferias-auto-sync.js
// Sincronização automática das FÉRIAS (mantidas pela gestão no app VISA, doc
// `ferias/escala`) para a coleção `ocorrencias` do RMPF.
//
// Substitui o lançamento manual do tipo "Férias" pelo fiscal: roda em sessão de
// Administrador, ao carregar a página. Como a fonte é o Firestore (doc único
// `ferias/escala`, mesmo projeto visam-3a30b) e há um `updatedAt` de servidor a
// cada save do VISA, a detecção de mudança usa esse timestamp como "watermark":
// só quando ele avança (ou muda a competência aberta) é que a reconciliação
// completa é executada. Um lock distribuído (ferias_sync_locks/escala) evita
// execuções concorrentes entre admins.
//
// Escopo: só a COMPETÊNCIA ABERTA (db_getProximaCompetencia). Sub-períodos de
// férias que caem em meses fechados/passados não são tocados. As ocorrências
// carregam `origem:'ferias_visa'` (para reconciliar criar/remover) e nunca
// afetam lançamentos manuais.
//
// AUTO-ACEITE: além de criar a ocorrência, a sincronização a ACEITA
// automaticamente (as férias já vêm validadas da gestão), gerando os pontos em
// `manuais` por dia útil com o mesmo rateio do aceite manual (db_aceitarOcorrencia).
// Também aceita qualquer ferias_visa que ainda esteja `pendente` (ex.: criadas
// antes deste recurso). Se um dia coberto já tiver outro lançamento, a ocorrência
// fica `pendente` e é reportada (mesma pré-checagem do aceite manual).

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
// aberta: cria as que faltam, remove as que saíram, e ACEITA as pendentes
// (gerando os pontos). Retorna um resumo { criadas, aceitas, removidas, ... }.
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

    // 3. Estado salvo → o watermark (updatedAt da escala) mudou nesta competência?
    let state = {};
    try { state = await window.db_getImportState(); } catch (_) {}
    const st = state && state.ferias;
    const watermarkMudou = !(st && Number(st.mes) === mes && Number(st.ano) === ano &&
                             Number(st.watermark) === watermark);

    // 4. Existentes (origem ferias_visa) da competência aberta — 1 leitura.
    //    Precede o lock para decidir se há trabalho (reconciliar OU aceitar pendentes).
    const todasAuto = await window.db_getOcorrenciasPorOrigem('ferias_visa');
    const existentes = new Map();
    todasAuto.forEach(o => {
      if (Number(o.mes) !== mes || Number(o.ano) !== ano) return;
      existentes.set(_feriasKey(o.fiscal_email, o.data_inicio, o.data_fim), o);
    });
    const pendentesExistentes = [...existentes.values()].filter(o => o.status === 'pendente');

    // Nada mudou no VISA e não há pendentes a aceitar → sai barato (só leituras).
    if (!watermarkMudou && pendentesExistentes.length === 0) return;

    // 5. Lock distribuído
    try {
      await window.db_acquireFeriasSyncLock(user.email, user.nome || user.email);
    } catch (e) {
      // Outro admin já está sincronizando — sai em silêncio.
      if (/andamento/i.test(String(e && e.message || ''))) return;
      console.warn('[Férias sync] Falha ao obter lock:', e && e.message);
      return;
    }

    try {
      let criadas = 0, removidas = 0, aceitas = 0, ignorados = 0;
      const conflitos = [];   // sobreposição com outra ocorrência (não criada)
      const bloqueadas = [];  // aceite bloqueado: dia já tem outro lançamento
      const naoResolvidos = new Set();
      const aAceitar = [];    // ocorrências (com id) a aceitar nesta rodada

      if (watermarkMudou) {
        // 6. Mapa nome→email dos fiscais do RMPF (perfil Fiscal)
        const fiscais = await window.db_getTodosFiscais();
        const mapaNome = new Map();
        fiscais.forEach(f => {
          const n = window.normalizarNome(f.nome);
          if (n) mapaNome.set(n, { email: f.email || f.id, nome: f.nome || (f.email || f.id) });
        });

        // 7. Conjunto DESEJADO — só obs="Férias" (a coleção tem dois tipos) e só a
        //    competência aberta. Períodos que cruzam meses são cortados no mês aberto.
        const desejadas = new Map();
        for (const p of periodos) {
          if (!p || !p.nome || !p.inicio || !p.fim) continue;
          if (window.normalizarNome(p.obs) !== 'ferias') { ignorados++; continue; }
          if (p.fim < p.inicio) continue;
          const alvo = mapaNome.get(window.normalizarNome(p.nome));
          if (!alvo) { naoResolvidos.add(String(p.nome).trim()); continue; }
          const porMes = window.diasDaOcorrenciaPorMes(p.inicio, p.fim);
          for (const parte of Object.values(porMes)) {
            if (Number(parte.mes) !== mes || Number(parte.ano) !== ano) continue;
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

        // 8b. Criar as faltantes; juntar as pendentes (novas e antigas) p/ aceitar.
        for (const [key, d] of desejadas) {
          const existente = existentes.get(key);
          if (existente) {
            if (existente.status === 'pendente') aAceitar.push(existente);
            continue; // já aceita → nada a fazer
          }
          try {
            const conflito = await window.ocorrenciaConflitante(
              d.email, d.data_inicio, d.data_fim, null, { ignorarOrigem: 'ferias_visa' });
            if (conflito) {
              conflitos.push(`${window.nomeCurto ? window.nomeCurto(d.nome) : d.nome} (${window.fmtData(d.data_inicio)})`);
              continue;
            }
            const novoId = await window.db_createOcorrencia({
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
            aAceitar.push({
              id: novoId, fiscal_email: d.email, fiscal_nome: d.nome,
              mes: d.mes, ano: d.ano, tipo: 'ferias',
              data_inicio: d.data_inicio, data_fim: d.data_fim,
            });
            criadas++;
          } catch (e) {
            console.warn('[Férias sync] Falha ao criar ocorrência para', d.email, e && e.message);
          }
        }
      } else {
        // Watermark igual: a escala não mudou → só aceitar as pendentes que já
        // existem (ex.: criadas antes do auto-aceite, ou aceites antes bloqueados).
        for (const o of pendentesExistentes) aAceitar.push(o);
      }

      // 8c. Aceitar (gera os pontos por dia útil) — mesmo rateio do aceite manual.
      for (const o of aAceitar) {
        try {
          const r = await window.db_aceitarOcorrencia(o, { sufixoDescricao: 'sincronizada automaticamente do VISA' });
          if (r && r.ok) aceitas++;
          else if (r && r.motivo === 'dia_com_lancamento') {
            bloqueadas.push(`${window.nomeCurto ? window.nomeCurto(o.fiscal_nome) : o.fiscal_nome} (${window.fmtData(r.dia)})`);
          }
        } catch (e) {
          console.warn('[Férias sync] Falha ao aceitar ocorrência', o.id, e && e.message);
        }
      }

      // 9. Persistir o novo watermark (só quando reconciliou a escala).
      if (watermarkMudou) {
        await window.db_setImportState({
          ferias: { watermark, mes, ano, synced_at: new Date().toISOString() },
        });
      }

      // 10. Feedback
      const compLabel = window.mesAnoLabel ? window.mesAnoLabel(mes, ano) : `${mes}/${ano}`;
      console.info(
        `[Férias sync] ${compLabel}: watermarkMudou=${watermarkMudou}, existentes=${existentes.size}, ` +
        `criadas=${criadas}, aceitas=${aceitas}, removidas=${removidas}, bloqueadas=${bloqueadas.length}, ` +
        `conflitos=${conflitos.length}, ignorados(não-férias)=${ignorados}, nomesNaoResolvidos=${naoResolvidos.size}`);
      // Toast isolado: um erro ao renderizar nunca invalida a reconciliação
      // (já persistida) nem o valor de retorno.
      if (criadas || removidas || aceitas || bloqueadas.length || naoResolvidos.size || conflitos.length) {
        try {
          _feriasSyncMsg(
            `✅ Férias sincronizadas (${compLabel}): ${criadas} criada(s), ${aceitas} aceita(s), ${removidas} removida(s).`, 'ok');
          if (bloqueadas.length) {
            _feriasSyncMsg(
              `⚠️ ${bloqueadas.length} não aceita(s) — o dia já tem outro lançamento: ` +
              bloqueadas.join(', ') + '. Ajuste os lançamentos e recarregue.', 'warn');
          }
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

      return { criadas, aceitas, removidas, bloqueadas: bloqueadas.length, ignorados, conflitos: conflitos.length, naoResolvidos: naoResolvidos.size };
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
