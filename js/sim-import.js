// js/sim-import.js
// Módulo de importação de auditorias do SIM para o RMPF.
// Fonte de dados: coleção Firestore `ordens_servico` (antes era data/auditoria.csv).

const SIM_IMPORT_INICIO_MES = 4;
const SIM_IMPORT_INICIO_ANO = 2026;

// Todas as auditorias do SIM são tratadas como Alta complexidade
// (Vistoria — item 1 da tabela de pontuação = 48 pontos).
const SIM_COMPLEXIDADE   = 'Alta';
const SIM_ITEM_PONTUACAO = 1;
const SIM_PONTOS         = 48;

// ── Cache de ocorrências aceitas por fiscal/mês ──────────
const _simOcorrCache = new Map();
async function _getOcorrenciasAceitasSim(emailFiscal, mes, ano) {
  const key = `${emailFiscal}::${mes}::${ano}`;
  if (!_simOcorrCache.has(key)) {
    try {
      const ocorrs = await window.db_getOcorrencias(emailFiscal, mes, ano);
      _simOcorrCache.set(key, ocorrs.filter(o => o.status === 'aceito'));
    } catch (_) {
      _simOcorrCache.set(key, []);
    }
  }
  return _simOcorrCache.get(key);
}

function _dataCobertaOcorrSim(dataISO, ocorrencias) {
  return ocorrencias.some(o => {
    const fim = o.data_fim || o.data_inicio;
    return dataISO >= o.data_inicio && dataISO <= fim;
  });
}

function _manualContaNoLimiteOcorrenciaSim(m) {
  return !!m && m.origem !== 'ocorrencia' && m.status !== 'recusado';
}

function _aplicarManualNoMapaPontosSim(mapa, manual, delta) {
  if (!manual || !_manualContaNoLimiteOcorrenciaSim(manual) || !manual.data) return;
  const dia = manual.data;
  const pontos = Number(manual.pontos) || 0;
  mapa.set(dia, (mapa.get(dia) || 0) + (delta * pontos));
}

async function _getEstadoPontosSim(cache, emailFiscal, mes, ano) {
  const key = `${emailFiscal}::${mes}::${ano}`;
  if (!cache.has(key)) {
    const docs = await window.db_getManuais(emailFiscal, mes, ano);
    const byDia = new Map();
    for (const d of docs) _aplicarManualNoMapaPontosSim(byDia, d, 1);
    cache.set(key, {
      docsById: new Map(docs.map(d => [d.id, d])),
      byDia,
      opfDatas: window.datasComOpfManual ? window.datasComOpfManual(docs) : new Set(),
    });
  }
  return cache.get(key);
}

function simMesAberto(mes, ano) {
  mes = Number(mes); ano = Number(ano);
  if (ano > SIM_IMPORT_INICIO_ANO) return true;
  if (ano === SIM_IMPORT_INICIO_ANO && mes >= SIM_IMPORT_INICIO_MES) return true;
  return false;
}

function normStatusSim(v) {
  return String(v || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
}

// Converte um Firestore Timestamp (ou Date) para a data ISO local YYYY-MM-DD.
function simTimestampToISO(ts) {
  if (!ts) return null;
  const d = typeof ts.toDate === 'function' ? ts.toDate() : (ts instanceof Date ? ts : null);
  if (!d || isNaN(d.getTime())) return null;
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dia}`;
}

async function importarAuditoriasSIM({ fiscalEmail, fiscalNome, mes, ano, allFiscais, onProgress, onProgressBar }) {
  mes = Number(mes); ano = Number(ano);

  if (!simMesAberto(mes, ano)) {
    onProgress('⚠️ Mês anterior a Abril/2026 — impossível importar.', 'warn');
    return { criados: 0, atualizados: 0, ignorados: 0, erros: 0 };
  }

  // Acquire distributed lock — throws if another import is already running for this month
  await window.db_acquireSimImportLock(mes, ano, fiscalEmail, fiscalNome || fiscalEmail);

  try {
    onProgress('🔄 Buscando ordens de serviço concluídas...', 'info');

    const ordens = await window.db_getOrdensServicoConcluidas(mes, ano, fiscalEmail || null);

    // Conjunto de e-mails de fiscais válidos (somente perfil Fiscal são importados)
    const fiscaisValidos = new Set();
    for (const f of (allFiscais || [])) {
      if (f.email) fiscaisValidos.add(String(f.email).toLowerCase());
    }

    const mesStr = String(mes).padStart(2, '0');
    const anoStr = String(ano);

    // Filtra OS concluídas com dataCumprimento dentro do mês (tolerante a
    // variações de caixa/acentuação em statusOs: "Concluida"/"concluída"/…).
    const ordensFiltradas = ordens.filter(o => {
      if (normStatusSim(o.statusOs) !== 'concluida') return false;
      const dt = simTimestampToISO(o.dataCumprimento);
      return dt && dt.startsWith(`${anoStr}-${mesStr}-`);
    });

    onProgress(`📋 ${ordensFiltradas.length} auditoria(s) concluída(s) encontrada(s) para ${mesStr}/${anoStr}.`, 'info');

    const item   = SIM_ITEM_PONTUACAO;
    const pontos = SIM_PONTOS;

    let criados = 0, atualizados = 0, ignorados = 0, erros = 0;
    const processedKeys = new Set(); // "fiscalEmail::osNum"
    const pontosEstadoCache = new Map();

    for (let idx = 0; idx < ordensFiltradas.length; idx++) {
      const os = ordensFiltradas[idx];
      if (onProgressBar) onProgressBar(idx + 1, ordensFiltradas.length);

      const osNum = String(os.id || os._docId || '').trim();
      if (!osNum) continue;

      const emailFiscal = String(os.fiscalEmail || '').trim();
      if (!emailFiscal) continue;
      if (fiscaisValidos.size && !fiscaisValidos.has(emailFiscal.toLowerCase())) continue;
      if (fiscalEmail && emailFiscal !== fiscalEmail) continue;

      const nomeFiscalOs = String(os.fiscalNome || emailFiscal).trim();

      // Marca como presente na coleção para detecção de registros órfãos
      processedKeys.add(emailFiscal + '::' + osNum);

      const dataISO = simTimestampToISO(os.dataCumprimento);
      const descricao = `Auditoria SIM — OS ${osNum}`;

      try {
        const existing = await window.db_getSIMManual(osNum, emailFiscal);
        let estadoPontos = null;

        // ── Vistoria SIM não cumulativa com operação fiscal (OPF) manual ──
        // Decreto item 18: uma OPF manual na mesma data zera a vistoria importada.
        let pontosOs = pontos;
        if (dataISO) {
          const estadoOpf = await _getEstadoPontosSim(pontosEstadoCache, emailFiscal, mes, ano);
          if (estadoOpf.opfDatas && estadoOpf.opfDatas.has(dataISO)) {
            pontosOs = 0;
            onProgress(
              `⚠️ OS ${osNum} — ${nomeFiscalOs}: vistoria zerada — ` +
              `operação fiscal (OPF) manual em ${fmtData(dataISO)}.`,
              'warn'
            );
          }
        }

        // ── Verificar limite de 24 pts em dia com ocorrência aceita ─
        if (dataISO) {
          const dtParts = dataISO.split('-');
          const dtMes = Number(dtParts[1]);
          const dtAno = Number(dtParts[0]);
          const ocorrAceitas = await _getOcorrenciasAceitasSim(emailFiscal, dtMes, dtAno);
          if (_dataCobertaOcorrSim(dataISO, ocorrAceitas)) {
            estadoPontos = await _getEstadoPontosSim(pontosEstadoCache, emailFiscal, dtMes, dtAno);
            const somaDia = estadoPontos.byDia.get(dataISO) || 0;
            const pontosExistenteMesmoDoc =
              existing && _manualContaNoLimiteOcorrenciaSim(existing) && existing.data === dataISO
                ? (Number(existing.pontos) || 0)
                : 0;
            const baseDia = somaDia - pontosExistenteMesmoDoc;
            const totalDia = baseDia + (Number(pontosOs) || 0);
            if (totalDia > LIMITE_PONTOS_OCORRENCIA_DIA) {
              ignorados++;
              onProgress(
                `⚠️ OS ${osNum} — ${nomeFiscalOs}: dia ${dataISO} com ocorrência aceita ` +
                `ultrapassaria ${LIMITE_PONTOS_OCORRENCIA_DIA} pontos (total projetado: ${totalDia}). Importação rejeitada.`,
                'warn'
              );
              continue;
            }
          }
        }

        if (existing) {
          if (existing.status === 'aceito' || existing.status === 'fechado') {
            ignorados++;
            onProgress(`⚠️ OS ${osNum} — ${nomeFiscalOs}: já homologado, ignorado.`, 'warn');
            continue;
          }
          const updateData = {
            fiscal_nome: nomeFiscalOs,
            mes, ano, data: dataISO,
            tipo_id: 1, tipo_codigo: 'VIS',
            tipo_nome: 'Vistoria ou atendimento a denúncia',
            item_pontuacao: item,
            complexidade: SIM_COMPLEXIDADE,
            pontos: pontosOs, descricao,
            origem: 'sim_csv',
            sim_os: osNum,
            os_doc_id: os._docId || null,
            dispositivo_legal: window.dispositivoLegal
              ? window.dispositivoLegal(SIM_ITEM_PONTUACAO, SIM_PONTOS, false)
              : 'Item 1 do Anexo VII do Decreto 49.723/2023',
          };
          if (existing.status === 'recusado') {
            updateData.status = 'enviado';
            updateData.motivo_recusa = null;
            onProgress(`🔄 OS ${osNum}: recusado anteriormente, resubmetido para conferência.`, 'info');
          }
          await window.db_upsertSIMManual(osNum, emailFiscal, updateData, existing.id, false);
          const estado = estadoPontos || await _getEstadoPontosSim(pontosEstadoCache, emailFiscal, mes, ano);
          _aplicarManualNoMapaPontosSim(estado.byDia, existing, -1);
          const manualAtualizado = { ...existing, ...updateData, id: existing.id };
          _aplicarManualNoMapaPontosSim(estado.byDia, manualAtualizado, 1);
          estado.docsById.set(existing.id, manualAtualizado);
          atualizados++;
        } else {
          const fechamento = await window.db_getFechamento(emailFiscal, mes, ano);
          if (fechamento) {
            ignorados++;
            onProgress(`⚠️ OS ${osNum} — ${nomeFiscalOs}: competência fechada, ignorado.`, 'warn');
            continue;
          }
          await window.db_upsertSIMManual(osNum, emailFiscal, {
            controle: 'SIM-' + osNum,
            fiscal_email: emailFiscal,
            fiscal_nome: nomeFiscalOs,
            mes, ano, data: dataISO,
            tipo_id: 1, tipo_codigo: 'VIS',
            tipo_nome: 'Vistoria ou atendimento a denúncia',
            item_pontuacao: item,
            complexidade: SIM_COMPLEXIDADE,
            pontos: pontosOs, descricao,
            status: 'enviado',
            origem: 'sim_csv',
            sim_os: osNum,
            os_doc_id: os._docId || null,
            dispositivo_legal: window.dispositivoLegal
              ? window.dispositivoLegal(SIM_ITEM_PONTUACAO, SIM_PONTOS, false)
              : 'Item 1 do Anexo VII do Decreto 49.723/2023',
          }, null, true);
          const estado = estadoPontos || await _getEstadoPontosSim(pontosEstadoCache, emailFiscal, mes, ano);
          _aplicarManualNoMapaPontosSim(estado.byDia, {
            data: dataISO, pontos: pontosOs, origem: 'sim_csv', status: 'enviado',
          }, 1);
          criados++;
        }
      } catch(e) {
        erros++;
        onProgress('🚨 Erro OS ' + osNum + ': ' + e.message, 'danger');
      }
    }

    // Exclui lançamentos SIM cuja OS não consta mais como concluída na coleção
    // e que ainda não foram homologados.
    let excluidos = 0;
    try {
      const candidatos = fiscalEmail
        ? await window.db_getManuais(fiscalEmail, mes, ano)
        : await window.db_getManuaisTodos(mes, ano);
      for (const m of candidatos) {
        if (m.origem !== 'sim_csv') continue;
        if (m.status === 'aceito' || m.status === 'fechado') continue;
        const key = (m.fiscal_email || '') + '::' + (m.sim_os || '');
        if (!processedKeys.has(key)) {
          await window.db_deleteManual(m.id);
          excluidos++;
          onProgress(`🗑️ OS ${m.sim_os} — não consta como concluída na coleção, lançamento excluído.`, 'info');
        }
      }
    } catch(e) {
      onProgress('⚠️ Erro ao verificar lançamentos órfãos: ' + e.message, 'warn');
    }

    onProgress(
      `✅ Importação concluída: <strong>${criados}</strong> criado(s), ` +
      `<strong>${atualizados}</strong> atualizado(s), ` +
      `<strong>${ignorados}</strong> ignorado(s), ` +
      `<strong>${excluidos}</strong> excluído(s), ` +
      `<strong>${erros}</strong> erro(s).`,
      erros > 0 ? 'warn' : 'ok'
    );
    return { criados, atualizados, ignorados, excluidos, erros };
  } finally {
    await window.db_releaseSimImportLock(mes, ano);
  }
}

window.simMesAberto          = simMesAberto;
window.importarAuditoriasSIM = importarAuditoriasSIM;
