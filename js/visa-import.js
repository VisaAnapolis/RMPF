// js/visa-import.js
// Módulo de importação de inspeções do VISA para o RMPF

const VISA_IMPORT_INICIO_MES = 4;
const VISA_IMPORT_INICIO_ANO = 2026;

function visaMesAberto(mes, ano) {
  mes = Number(mes); ano = Number(ano);
  if (ano > VISA_IMPORT_INICIO_ANO) return true;
  if (ano === VISA_IMPORT_INICIO_ANO && mes >= VISA_IMPORT_INICIO_MES) return true;
  return false;
}

function normNomeVisa(v) {
  return String(v || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

function complexToItem(complexidade) {
  const c = String(complexidade || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (c === 'alta')  return { item: 1, pontos: 48 };
  if (c === 'baixa') return { item: 3, pontos: 6  };
  return { item: 2, pontos: 12 };
}

function resolverTipoVisa(tipoRaw, complexidade) {
  const norm = String(tipoRaw || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
  const c = String(complexidade || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (norm === 'MANIFESTACAO DO FISCAL ATUANTE') {
    return { tipo_id: 5, tipo_codigo: 'MAN', tipo_nome: 'Manifestação do servidor atuante',
             item_pontuacao: 8, pontos: 12, descLabel: 'Manifestação do fiscal atuante' };
  }
  if (norm === 'TERMO DE COLETA DE AMOSTRA') {
    return { tipo_id: 4, tipo_codigo: 'COL', tipo_nome: 'Coleta de amostra para laboratório',
             item_pontuacao: 7, pontos: 12, descLabel: 'Termo de coleta de amostra' };
  }
  if (norm === 'PRORROGACAO') {
    return { tipo_id: 3, tipo_codigo: 'PLT', tipo_nome: 'Plantão fiscal',
             item_pontuacao: 6, pontos: 0, descLabel: 'Prorrogação' };
  }
  if (norm === 'RELATORIO TECNICO') {
    if (c === 'alta')  return { tipo_id: 7, tipo_codigo: 'REL', tipo_nome: 'Elaboração de relatório técnico de inspeção',
                                item_pontuacao: 10, pontos: 48, descLabel: 'Relatório técnico' };
    if (c === 'baixa') return { tipo_id: 7, tipo_codigo: 'REL', tipo_nome: 'Elaboração de relatório técnico de inspeção',
                                item_pontuacao: 12, pontos: 6,  descLabel: 'Relatório técnico' };
    return               { tipo_id: 7, tipo_codigo: 'REL', tipo_nome: 'Elaboração de relatório técnico de inspeção',
                           item_pontuacao: 11, pontos: 12, descLabel: 'Relatório técnico' };
  }
  if (norm === 'ANALISE DE PAS') {
    if (c === 'alta')  return { tipo_id: 2, tipo_codigo: 'ARQ', tipo_nome: 'Análise de projeto arquitetônico',
                                item_pontuacao: 4, pontos: 24, descLabel: 'Análise de PAS' };
    return               { tipo_id: 2, tipo_codigo: 'ARQ', tipo_nome: 'Análise de projeto arquitetônico',
                           item_pontuacao: 5, pontos: 12, descLabel: 'Análise de PAS' };
  }
  if (norm === 'RELATORIO HARMONIZADO') {
    return { tipo_id: 8, tipo_codigo: 'RLH', tipo_nome: 'Relatório técnico harmonizado (SNVS)',
             item_pontuacao: 13, pontos: 48, descLabel: 'Relatório harmonizado' };
  }
  // Default: Vistoria VISA with complexidade
  const { item, pontos } = complexToItem(complexidade);
  return { tipo_id: 1, tipo_codigo: 'VIS', tipo_nome: 'Vistoria ou atendimento a denúncia',
           item_pontuacao: item, pontos, descLabel: 'Vistoria VISA' };
}

// ── Autorização do terceiro fiscal ───────────────────────
// Retorna true quando o Fiscal3 está autorizado a participar da OS/Ofício.
// Comportamento permissivo: se a OS/Ofício não for encontrada em nenhum mapa,
// considera autorizado (chave desconhecida não bloqueia o registro).
function isTerceiroFiscalAutorizado(os, oficio, requerimentoMap, oficioMap) {
  let encontrado = false;

  if (os) {
    const req = requerimentoMap.get(os);
    if (req !== undefined) {
      encontrado = true;
      if (req.prioridade === true) return true;
    }
  }

  if (oficio) {
    const ofi = oficioMap.get(oficio);
    if (ofi !== undefined) {
      encontrado = true;
      if (ofi.terceiro === true) return true;
    }
  }

  // Chave não encontrada em nenhum mapa → permissivo
  if (!encontrado) return true;

  return false;
}

function visaDataToISO(dataStr) {
  if (!dataStr) return null;
  const s = String(dataStr).trim().replace(/"/g, '');
  const parts = s.split('.');
  if (parts.length === 3) {
    const [d, m, y] = parts;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  return null;
}

async function importarInspecoesVISA({ fiscalEmail, fiscalNome, mes, ano, allFiscais, onProgress, onProgressBar }) {
  mes = Number(mes); ano = Number(ano);

  if (!visaMesAberto(mes, ano)) {
    onProgress('⚠️ Mês anterior a Abril/2026 — impossível importar.', 'warn');
    return { criados: 0, atualizados: 0, ignorados: 0, erros: 0 };
  }

  // Acquire distributed lock — throws if another import is already running for this month
  await window.db_acquireVisaImportLock(mes, ano, fiscalEmail, fiscalNome || fiscalEmail);

  try {
    onProgress('🔄 Buscando CSV de inspeções do VISA...', 'info');

    const text = await window.fetchGitHubCSV('data/inspecoes.csv');

    const parsed = Papa.parse(text, {
      header: true,
      delimiter: ';',
      skipEmptyLines: true,
      transformHeader: h => h.replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim(),
    });
    const rows = parsed.data;

    // ── Carregar CSVs de autorização do terceiro fiscal ──
    const requerimentoMap = new Map(); // OS normalizada → { prioridade: boolean }
    const oficioMap       = new Map(); // Oficio normalizado → { terceiro: boolean }

    try {
      const reqText = await window.fetchGitHubCSV('data/requerimento.csv');
      const reqParsed = Papa.parse(reqText, {
        header: true,
        skipEmptyLines: true,
        transformHeader: h => h.replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim(),
      });
      for (const r of reqParsed.data) {
        const osKey = String(r['OS'] || '').replace(/"/g, '').trim();
        if (!osKey) continue;
        const prioridade = String(r['prioridade'] || '').replace(/"/g, '').trim().toLowerCase();
        requerimentoMap.set(osKey, { prioridade: prioridade === 'true' || prioridade === '1' || prioridade === 'sim' });
      }
      onProgress(`📑 ${requerimentoMap.size} requerimento(s) carregado(s).`, 'info');
    } catch (err) {
      onProgress('⚠️ Não foi possível carregar requerimento.csv — autorizações de terceiro fiscal não verificadas.', 'warn');
      console.error('Failed to load requerimento.csv:', err);
    }

    try {
      const ofiText = await window.fetchGitHubCSV('data/Oficio.csv');
      const ofiParsed = Papa.parse(ofiText, {
        header: true,
        skipEmptyLines: true,
        transformHeader: h => h.replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim(),
      });
      for (const r of ofiParsed.data) {
        const ofiKey = String(r['Oficio'] || '').replace(/"/g, '').trim();
        if (!ofiKey) continue;
        const terceiro = String(r['terceiro'] || '').replace(/"/g, '').trim().toLowerCase();
        oficioMap.set(ofiKey, { terceiro: terceiro === 'true' || terceiro === '1' || terceiro === 'sim' });
      }
      onProgress(`📑 ${oficioMap.size} ofício(s) carregado(s).`, 'info');
    } catch (err) {
      onProgress('⚠️ Não foi possível carregar Oficio.csv — autorizações de terceiro fiscal não verificadas.', 'warn');
      console.error('Failed to load Oficio.csv:', err);
    }

    const fiscalMap = new Map();
    for (const f of (allFiscais || [])) {
      if (f.nome) fiscalMap.set(normNomeVisa(f.nome), f.email || f.id);
    }

    const mesStr = String(mes).padStart(2, '0');
    const anoStr = String(ano);
    const rowsFiltradas = rows.filter(r => {
      const rawDt = String(r['DT_VISITA'] || '').replace(/"/g, '').trim();
      const dt = visaDataToISO(rawDt);
      return dt && dt.startsWith(`${anoStr}-${mesStr}-`);
    });

    onProgress(`📋 ${rowsFiltradas.length} inspeção(ões) encontrada(s) para ${mesStr}/${anoStr}.`, 'info');

    let criados = 0, atualizados = 0, ignorados = 0, erros = 0;
    const cnaeCache = new Map();
    const processedKeys = new Set(); // "fiscalEmail::controleVisa"

    for (let idx = 0; idx < rowsFiltradas.length; idx++) {
      const row = rowsFiltradas[idx];
      if (onProgressBar) onProgressBar(idx + 1, rowsFiltradas.length);

      const controleVisa = String(row['CONTROLE'] || '').replace(/"/g, '').trim();
      if (!controleVisa) continue;

      const subclasse = String(row['Atividade'] || '').replace(/"/g, '').trim();
      let cnaeInfo = { complexidade: 'Média', descricao: '' };
      if (subclasse) {
        if (!cnaeCache.has(subclasse)) {
          try {
            const info = await window.db_getCNAEComplexidade(subclasse);
            cnaeCache.set(subclasse, info || { complexidade: 'Média', descricao: subclasse });
          } catch(_) {
            cnaeCache.set(subclasse, { complexidade: 'Média', descricao: subclasse });
          }
        }
        cnaeInfo = cnaeCache.get(subclasse) || { complexidade: 'Média', descricao: subclasse };
      }

      const tipoRaw = String(row['tipo'] || row['TIPO'] || row['Tipo'] || '').replace(/"/g, '').trim();
      const tipoInfo = resolverTipoVisa(tipoRaw, cnaeInfo.complexidade);

      const dataISO = visaDataToISO(String(row['DT_VISITA'] || '').replace(/"/g, '').trim());
      const os = String(row['OS'] || row['NUMERO'] || '').replace(/"/g, '').trim();
      const oficio = String(row['Oficio'] || row['OFICIO'] || '').replace(/"/g, '').trim();

      const descParts = [tipoInfo.descLabel];
      if (os) descParts.push('OS ' + os);
      if (subclasse) descParts.push('CNAE ' + subclasse);
      if (cnaeInfo.descricao && cnaeInfo.descricao !== subclasse) descParts.push(cnaeInfo.descricao);
      const descricao = descParts.join(' — ');

      const rawFiscais = [
        { nome: row['Fiscal1'], isTerceiro: false },
        { nome: row['Fiscal2'], isTerceiro: false },
        { nome: row['Fiscal3'], isTerceiro: true  },
      ];
      const fiscaisCsv = rawFiscais
        .map(f => ({ ...f, nome: String(f.nome || '').replace(/"/g, '').trim() }))
        .filter(f => f.nome);

      for (const { nome: nomeFiscalCsv, isTerceiro } of fiscaisCsv) {
        const emailFiscal = fiscalMap.get(normNomeVisa(nomeFiscalCsv));
        if (!emailFiscal) continue;
        if (fiscalEmail && emailFiscal !== fiscalEmail) continue;

        // Marca como presente no CSV para detecção de registros órfãos
        processedKeys.add(emailFiscal + '::' + controleVisa);

        try {
          const existing = await window.db_getVISAManual(controleVisa, emailFiscal);

          if (existing) {
            if (existing.status === 'aceito' || existing.status === 'fechado') {
              ignorados++;
              onProgress(`⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: já homologado, ignorado.`, 'warn');
              continue;
            }
            const updateData = {
              fiscal_nome: nomeFiscalCsv,
              mes, ano, data: dataISO,
              tipo_id: tipoInfo.tipo_id, tipo_codigo: tipoInfo.tipo_codigo,
              tipo_nome: tipoInfo.tipo_nome,
              item_pontuacao: tipoInfo.item_pontuacao,
              complexidade: cnaeInfo.complexidade,
              pontos: tipoInfo.pontos, descricao,
              origem: 'visa_csv',
              visa_controle: controleVisa,
            };
            if (existing.status === 'recusado') {
              updateData.status = 'enviado';
              updateData.motivo_recusa = null;
              onProgress(`🔄 CONTROLE ${controleVisa}: recusado anteriormente, resubmetido para conferência.`, 'info');
            }
            // Verificação de autorização do terceiro fiscal na atualização
            if (isTerceiro) {
              const autorizado = isTerceiroFiscalAutorizado(os, oficio, requerimentoMap, oficioMap);
              if (!autorizado) {
                updateData.status = 'Pendente';
                onProgress(`⚠️ CONTROLE ${controleVisa} — Fiscal3 sem autorização, marcado como Pendente.`, 'warn');
              } else if (existing.status === 'Pendente') {
                updateData.status = 'enviado';
                onProgress(`✅ CONTROLE ${controleVisa} — Fiscal3 agora autorizado, restaurado para enviado.`, 'info');
              }
            }
            await window.db_upsertVISAManual(controleVisa, emailFiscal, updateData, existing.id, false);
            atualizados++;
          } else {
            const fechamento = await window.db_getFechamento(emailFiscal, mes, ano);
            if (fechamento) {
              ignorados++;
              onProgress(`⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: competência fechada, ignorado.`, 'warn');
              continue;
            }
            // Determinar status inicial considerando autorização do terceiro fiscal
            let statusInicial = 'enviado';
            if (isTerceiro && !isTerceiroFiscalAutorizado(os, oficio, requerimentoMap, oficioMap)) {
              statusInicial = 'Pendente';
              onProgress(`⚠️ CONTROLE ${controleVisa} — Fiscal3 sem autorização, marcado como Pendente.`, 'warn');
            }
            await window.db_upsertVISAManual(controleVisa, emailFiscal, {
              controle: 'VISA-' + controleVisa,
              fiscal_email: emailFiscal,
              fiscal_nome: nomeFiscalCsv,
              mes, ano, data: dataISO,
              tipo_id: tipoInfo.tipo_id, tipo_codigo: tipoInfo.tipo_codigo,
              tipo_nome: tipoInfo.tipo_nome,
              item_pontuacao: tipoInfo.item_pontuacao,
              complexidade: cnaeInfo.complexidade,
              pontos: tipoInfo.pontos, descricao,
              status: statusInicial,
              origem: 'visa_csv',
              visa_controle: controleVisa,
            }, null, true);
            criados++;
          }
        } catch(e) {
          erros++;
          onProgress('🚨 Erro CONTROLE ' + controleVisa + ': ' + e.message, 'danger');
        }
      }
    }

    // Exclui lançamentos VISA que foram removidos do CSV e ainda não foram homologados
    let excluidos = 0;
    try {
      const candidatos = fiscalEmail
        ? await window.db_getManuais(fiscalEmail, mes, ano)
        : await window.db_getManuaisTodos(mes, ano);
      for (const m of candidatos) {
        if (m.origem !== 'visa_csv') continue;
        if (m.status === 'aceito' || m.status === 'fechado') continue;
        const key = (m.fiscal_email || '') + '::' + (m.visa_controle || '');
        if (!processedKeys.has(key)) {
          await window.db_deleteManual(m.id);
          excluidos++;
          onProgress(`🗑️ CONTROLE ${m.visa_controle} — não encontrado no CSV, lançamento excluído.`, 'info');
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
    await window.db_releaseVisaImportLock(mes, ano);
  }
}

window.visaMesAberto         = visaMesAberto;
window.importarInspecoesVISA = importarInspecoesVISA;
