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

// ── Comparação com a origem (lançamento recusado) ────────
// Um lançamento recusado nunca é sobrescrito pela importação, mas o que mudou
// na origem depois da recusa precisa ser sinalizado ao fiscal e ao gestor.
// Campos que definem identidade e pontuação da auditoria — os demais (descrição,
// dispositivo legal) são derivados e não justificam alarmar ninguém.
const SIM_CAMPOS_ORIGEM = ['data', 'pontos', 'item_pontuacao', 'prazo_os'];

const SIM_CAMPOS_ORIGEM_LABEL = {
  data: 'Data', pontos: 'Pontos',
  item_pontuacao: 'Item do Anexo VII', prazo_os: 'Prazo da OS',
};

// null, undefined e '' são o mesmo "vazio"; 48 e '48' são o mesmo valor —
// mesma normalização de js/visa-import.js, para não acusar mudança onde não houve.
function _normValorOrigemSim(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const s = String(v).trim();
  if (s === '') return '';
  if (!isNaN(Number(s))) return String(Number(s));
  return s;
}

// [] = nada mudou. Campo AUSENTE no doc gravado é ignorado: são campos que ainda
// não existiam no esquema quando aquele lançamento foi salvo — evolução do RMPF,
// não alteração na origem.
function simDiffOrigem(existing, novo) {
  const diff = [];
  for (const c of SIM_CAMPOS_ORIGEM) {
    if (existing && !Object.prototype.hasOwnProperty.call(existing, c)) continue;
    const de   = _normValorOrigemSim(existing ? existing[c] : null);
    const para = _normValorOrigemSim(novo ? novo[c] : null);
    if (de !== para) {
      diff.push({ campo: c, label: SIM_CAMPOS_ORIGEM_LABEL[c] || c, de, para });
    }
  }
  return diff;
}

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

async function _getEstadoPontosSim(cache, emailFiscal, mes, ano, nomeFiscal) {
  const key = `${emailFiscal}::${mes}::${ano}`;
  if (!cache.has(key)) {
    const docs = await window.db_getManuais(emailFiscal, mes, ano);
    const byDia = new Map();
    for (const d of docs) _aplicarManualNoMapaPontosSim(byDia, d, 1);
    cache.set(key, {
      docsById: new Map(docs.map(d => [d.id, d])),
      byDia,
      plantaoDatas: window.datasComPlantaoManual ? window.datasComPlantaoManual(docs) : new Set(),
      opfDatas: window.datasComOpfManual ? window.datasComOpfManual(docs) : new Set(),
      // Datas em que o fiscal está escalado para plantão pela gerência
      // (escala do VISA, coleção `plantao`): zeram vistorias do dia mesmo
      // sem PLT manual lançado, para forçar o cumprimento da escala. Set
      // vazio quando o mês não tem escala publicada ou em falha de leitura
      // (fail-open — js/plantao-escala.js).
      escalaDatas: (typeof window.datasEscaladoNoMes === 'function' && nomeFiscal)
        ? await window.datasEscaladoNoMes(nomeFiscal, mes, ano)
        : new Set(),
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
    // Feriados municipais — usados para prorrogar prazo vencido em dia não
    // útil (ver window.cumpridoForaDoPrazo em js/utils.js).
    const feriadosSet = await window.carregarFeriadosMunicipais();

    onProgress('🔄 Buscando ordens de serviço concluídas...', 'info');

    const ordens = await window.db_getOrdensServicoConcluidas(mes, ano, fiscalEmail || null);

    // Conjunto de e-mails de fiscais válidos (somente perfil Fiscal são importados)
    const fiscaisValidos = new Set();
    for (const f of (allFiscais || [])) {
      if (f.email) fiscaisValidos.add(String(f.email).toLowerCase());
    }
    // E-mail → nome cadastrado (coleção usuarios). Usado no match contra a
    // escala de plantão da gerência, que registra os fiscais por nome completo.
    const emailNomeMap = new Map();
    for (const f of (allFiscais || [])) {
      if (f.email && f.nome) emailNomeMap.set(f.email, f.nome);
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

      // ── Prazo da OS e conformidade (cumprida fora do prazo) ──
      // A OS de auditoria já traz o prazo (os.prazo) e a data de cumprimento
      // (os.dataCumprimento) no próprio doc de ordens_servico. Fora do prazo =
      // cumprida depois do prazo.
      // Prazo vencido em fim de semana/feriado prorroga para o próximo dia
      // útil: cumprir na segunda um prazo de sábado está DENTRO do prazo.
      const prazoOsISO = simTimestampToISO(os.prazo);
      const foraDoPrazo = window.cumpridoForaDoPrazo(prazoOsISO, dataISO, feriadosSet);

      try {
        const existing = await window.db_getSIMManual(osNum, emailFiscal);

        // ── Vistoria SIM não cumulativa com Plantão ou OPF manual ──────────
        // Decreto item 9: um Plantão Fiscal manual na mesma data zera a vistoria
        // importada. Decreto item 18: idem para Operação Fiscal (OPF) manual.
        // Mesma regra já aplicada às vistorias do VISA (js/visa-import.js) —
        // sem isso, uma vistoria do SIM escaparia da não cumulatividade.
        let pontosOs = pontos;
        let zeradoMotivo = null;
        // Item do Anexo VII que REJEITA a pontuação — citado em dispositivo_legal
        // no lugar do Item 1 (produtivo) quando pontosOs acaba em zero.
        let itemDecretoZerado = null;
        if (dataISO) {
          const estado = await _getEstadoPontosSim(
            pontosEstadoCache, emailFiscal, mes, ano,
            emailNomeMap.get(emailFiscal) || nomeFiscalOs);
          if (estado.plantaoDatas && estado.plantaoDatas.has(dataISO)) {
            pontosOs = 0;
            itemDecretoZerado = 9;
            zeradoMotivo = `Plantão fiscal manual em ${fmtData(dataISO)} — não cumulativo com vistoria (Anexo VII, item 9).`;
            onProgress(
              `⚠️ OS ${osNum} — ${nomeFiscalOs}: vistoria zerada — ` +
              `plantão fiscal manual em ${fmtData(dataISO)}.`,
              'warn'
            );
          } else if (estado.escalaDatas && estado.escalaDatas.has(dataISO)) {
            // Mesmo sem PLT manual lançado, o fiscal está escalado pela
            // gerência para plantão nesta data (escala do VISA) — a vistoria
            // do dia não é cumulativa (Anexo VII, item 9), forçando o
            // cumprimento da escala.
            pontosOs = 0;
            itemDecretoZerado = 9;
            zeradoMotivo = `Fiscal escalado pela gerência para plantão fiscal em ${fmtData(dataISO)} (escala de plantão do VISA) — não cumulativo com vistoria (Anexo VII, item 9).`;
            onProgress(
              `⚠️ OS ${osNum} — ${nomeFiscalOs}: vistoria zerada — ` +
              `fiscal escalado pela gerência para plantão fiscal em ${fmtData(dataISO)} (escala VISA).`,
              'warn'
            );
          } else if (estado.opfDatas && estado.opfDatas.has(dataISO)) {
            pontosOs = 0;
            itemDecretoZerado = 18;
            zeradoMotivo = `Operação fiscal manual em ${fmtData(dataISO)} — não cumulativo com vistoria (Anexo VII, item 18).`;
            onProgress(
              `⚠️ OS ${osNum} — ${nomeFiscalOs}: vistoria zerada — ` +
              `operação fiscal (OPF) manual em ${fmtData(dataISO)}.`,
              'warn'
            );
          }
        }

        // ── Dia coberto por ocorrência aceita → importação ignorada ─
        // Alinhado com a regra de lançamento manual (lancamento.html /
        // meus-lancamentos.html): dias cobertos por ocorrência aceita não
        // admitem nenhum outro lançamento, sem exceção de pontuação.
        if (dataISO) {
          const dtParts = dataISO.split('-');
          const dtMes = Number(dtParts[1]);
          const dtAno = Number(dtParts[0]);
          const ocorrAceitas = await _getOcorrenciasAceitasSim(emailFiscal, dtMes, dtAno);
          if (_dataCobertaOcorrSim(dataISO, ocorrAceitas)) {
            ignorados++;
            onProgress(
              `⚠️ OS ${osNum} — ${nomeFiscalOs}: dia ${dataISO} coberto por ocorrência aceita. ` +
              `Importação ignorada.`,
              'warn'
            );
            continue;
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
            zerado_motivo: zeradoMotivo,
            origem: 'sim_csv',
            sim_os: osNum,
            os_doc_id: os._docId || null,
            prazo_os: prazoOsISO || null,
            fora_do_prazo: foraDoPrazo,
            dispositivo_legal: window.dispositivoLegal
              ? window.dispositivoLegal(SIM_ITEM_PONTUACAO, pontosOs, false, itemDecretoZerado || undefined)
              : (pontosOs === 0 ? (itemDecretoZerado ? `Item ${itemDecretoZerado} do Anexo VII do Decreto 49.723/2023 (não cumulativo — pontuação zerada)` : null) : 'Item 1 do Anexo VII do Decreto 49.723/2023'),
          };
          // ── Recusado: avaliação definitiva, nunca sobrescrita ──────
          // Não devolve o lançamento à conferência nem apaga o motivo da recusa;
          // grava SÓ a marca do alerta quando a origem mudou depois da recusa.
          if (existing.status === 'recusado') {
            ignorados++;
            let _recusaAlterada = false;
            const _diffRec = simDiffOrigem(existing, updateData);
            const _jaMarcado = Array.isArray(existing.recusa_alterado_diff)
              ? existing.recusa_alterado_diff : null;
            let _mudouMarca = true;
            try {
              _mudouMarca = JSON.stringify(_jaMarcado || []) !== JSON.stringify(_diffRec);
            } catch (_) { _mudouMarca = true; }
            if (_diffRec.length) {
              _recusaAlterada = true;
              if (_mudouMarca) {
                await window.db_updateManual(existing.id, {
                  recusa_alterado_diff: _diffRec,
                  recusa_alterado_em: new Date().toISOString(),
                });
                onProgress(
                  `⛔ OS ${osNum} — ${nomeFiscalOs}: alterada na origem DEPOIS da recusa ` +
                  `(${_diffRec.map(d => d.label).join(', ')}) — recusa mantida, alerta sinalizado.`, 'warn');
                // Só quando a marca muda: repetir o aviso a cada rodada da
                // importação (~10 min) transformaria o alerta em ruído.
                if (typeof window.notificarRecusaAlterada === 'function') {
                  window.notificarRecusaAlterada({
                    id: existing.id,
                    controle: existing.controle || `OS ${osNum}`,
                    fiscal_email: emailFiscal,
                    fiscal_nome: nomeFiscalOs,
                  });
                }
              }
            } else if (_jaMarcado) {
              await window.db_updateManual(existing.id, {
                recusa_alterado_diff: null,
                recusa_alterado_em: null,
              });
              onProgress(`✅ OS ${osNum} — ${nomeFiscalOs}: origem voltou ao que era na recusa — alerta removido.`, 'info');
            }
            if (!_recusaAlterada) {
              onProgress(`⚠️ OS ${osNum} — ${nomeFiscalOs}: recusado pelo gestor — preservado. Reavaliação apenas pela Conferência.`, 'warn');
            }
            continue;
          }
          await window.db_upsertSIMManual(osNum, emailFiscal, updateData, existing.id, false);
          const estado = await _getEstadoPontosSim(pontosEstadoCache, emailFiscal, mes, ano);
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
            zerado_motivo: zeradoMotivo,
            status: 'enviado',
            origem: 'sim_csv',
            sim_os: osNum,
            os_doc_id: os._docId || null,
            prazo_os: prazoOsISO || null,
            fora_do_prazo: foraDoPrazo,
            dispositivo_legal: window.dispositivoLegal
              ? window.dispositivoLegal(SIM_ITEM_PONTUACAO, pontosOs, false, itemDecretoZerado || undefined)
              : (pontosOs === 0 ? (itemDecretoZerado ? `Item ${itemDecretoZerado} do Anexo VII do Decreto 49.723/2023 (não cumulativo — pontuação zerada)` : null) : 'Item 1 do Anexo VII do Decreto 49.723/2023'),
          }, null, true);
          const estado = await _getEstadoPontosSim(pontosEstadoCache, emailFiscal, mes, ano);
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
