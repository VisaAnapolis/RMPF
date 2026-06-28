// js/visa-import.js
// Módulo de importação de inspeções do VISA para o RMPF

const VISA_IMPORT_INICIO_MES = 4;
const VISA_IMPORT_INICIO_ANO = 2026;
// Teto de pontos somados dos CNAEs (informado + cae.csv) por inspeção VISA.
const TETO_PONTOS_CNAE_VISA = 48;

// ── Cache de ocorrências aceitas por fiscal/mês ──────────
const _visaOcorrCache = new Map();
async function _getOcorrenciasAceitasVisa(emailFiscal, mes, ano) {
  const key = `${emailFiscal}::${mes}::${ano}`;
  if (!_visaOcorrCache.has(key)) {
    try {
      const ocorrs = await window.db_getOcorrencias(emailFiscal, mes, ano);
      _visaOcorrCache.set(key, ocorrs.filter(o => o.status === 'aceito'));
    } catch (_) {
      _visaOcorrCache.set(key, []);
    }
  }
  return _visaOcorrCache.get(key);
}

function _dataCobertaOcorrVisa(dataISO, ocorrencias) {
  return ocorrencias.some(o => {
    const fim = o.data_fim || o.data_inicio;
    return dataISO >= o.data_inicio && dataISO <= fim;
  });
}

function _manualContaNoLimiteOcorrenciaVisa(m) {
  return !!m && m.origem !== 'ocorrencia' && m.status !== 'recusado';
}

function _aplicarManualNoMapaPontosVisa(mapa, manual, delta) {
  if (!manual || !_manualContaNoLimiteOcorrenciaVisa(manual) || !manual.data) return;
  const dia = manual.data;
  const pontos = Number(manual.pontos) || 0;
  mapa.set(dia, (mapa.get(dia) || 0) + (delta * pontos));
}

async function _getEstadoPontosVisa(cache, emailFiscal, mes, ano) {
  const key = `${emailFiscal}::${mes}::${ano}`;
  if (!cache.has(key)) {
    const docs = await window.db_getManuais(emailFiscal, mes, ano);
    const byDia = new Map();
    for (const d of docs) _aplicarManualNoMapaPontosVisa(byDia, d, 1);
    cache.set(key, {
      docsById: new Map(docs.map(d => [d.id, d])),
      byDia,
      plantaoDatas: datasComPlantaoManual(docs),
    });
  }
  return cache.get(key);
}

// ── Regra Plantão fiscal × Vistoria importada ────────────
// Um lançamento manual de Plantão Fiscal (tipo PLT) torna as vistorias
// importadas do VISA na mesma data não cumulativas → pontos zerados.

function ehPlantaoManual(m) {
  return !!m && m.tipo_codigo === 'PLT' && m.origem !== 'visa_csv' && m.status !== 'recusado';
}

function ehVistoriaImportada(m) {
  return !!m && m.origem === 'visa_csv' && m.tipo_codigo === 'VIS';
}

// Conjunto de datas (yyyy-mm-dd) que possuem plantão manual na lista informada.
function datasComPlantaoManual(manuais) {
  const s = new Set();
  for (const m of (manuais || [])) {
    if (ehPlantaoManual(m) && m.data) s.add(m.data);
  }
  return s;
}

// Vistorias importadas (origem visa_csv, tipo VIS) lançadas em uma data para um fiscal.
// `excluirId` ignora um documento específico (útil ao editar o próprio registro).
async function vistoriasImportadasNoDia(fiscalEmail, dataISO, excluirId = null) {
  if (!fiscalEmail || !dataISO) return [];
  const parts = String(dataISO).split('-');
  if (parts.length !== 3) return [];
  const ano = Number(parts[0]);
  const mes = Number(parts[1]);
  if (!ano || !mes) return [];
  const manuais = await window.db_getManuais(fiscalEmail, mes, ano);
  return manuais.filter(m => m.id !== excluirId && m.data === dataISO && ehVistoriaImportada(m));
}

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
  if (norm === 'CERTIDAO') {
    return { tipo_id: 11, tipo_codigo: 'CER', tipo_nome: 'Certidão',
             item_pontuacao: 16, pontos: 2, descLabel: 'Certidão' };
  }
  // Default: Vistoria VISA with complexidade
  const { item, pontos } = complexToItem(complexidade);
  return { tipo_id: 1, tipo_codigo: 'VIS', tipo_nome: 'Vistoria ou atendimento a denúncia',
           item_pontuacao: item, pontos, descLabel: 'Vistoria VISA' };
}

// ── Autorização do terceiro fiscal ───────────────────────
// Retorna true somente quando o Fiscal3 está explicitamente autorizado:
//   - OS encontrada em requerimento.csv com prioridade=true, OU
//   - Ofício encontrado em oficio.csv com terceiro=true.
// Qualquer outro caso (chave ausente ou flag falso) → não autorizado.
function isTerceiroFiscalAutorizado(os, oficio, requerimentoMap, oficioMap) {
  if (os) {
    const req = requerimentoMap.get(os);
    if (req !== undefined && req.prioridade === true) return true;
  }

  if (oficio) {
    const ofi = oficioMap.get(oficio);
    if (ofi !== undefined && ofi.terceiro === true) return true;
  }

  // Não autorizado: OS/Ofício ausente nos mapas ou encontrado sem flag de autorização
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
    if (text === null) {
      onProgress('❌ Arquivo data/inspecoes.csv não encontrado no repositório VISA. Verifique se o arquivo existe.', 'danger');
      return { criados: 0, atualizados: 0, ignorados: 0, excluidos: 0, erros: 0 };
    }

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
      if (reqText !== null) {
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
      }
    } catch (err) {
      onProgress('⚠️ Não foi possível carregar requerimento.csv — autorizações de terceiro fiscal não verificadas.', 'warn');
      console.error('Failed to load requerimento.csv:', err);
    }

    try {
      const ofiText = await window.fetchGitHubCSV('data/Oficio.csv');
      if (ofiText !== null) {
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
      }
    } catch (err) {
      onProgress('⚠️ Não foi possível carregar Oficio.csv — autorizações de terceiro fiscal não verificadas.', 'warn');
      console.error('Failed to load Oficio.csv:', err);
    }

    // ── Tabela de complexidade CNAE (data/cnae.csv) ──────────
    // Mapa CNAE → { complexidade, descricao }. A presença no mapa define que o
    // CNAE é de competência da vigilância (tem pontuação). Complexidades inválidas
    // (ex.: lixo "OS") são descartadas, logo o CNAE não conta como competência.
    const cnaeMap = new Map();
    try {
      const cnaeText = await window.fetchGitHubCSV('data/cnae.csv');
      if (cnaeText !== null) {
        const cnaeParsed = Papa.parse(cnaeText, {
          header: true,
          delimiter: ';',
          skipEmptyLines: true,
          transformHeader: h => h.replace(/^﻿/, '').replace(/^"|"$/g, '').trim(),
        });
        for (const r of cnaeParsed.data) {
          const sub = String(r['Subclasse'] || '').replace(/"/g, '').trim();
          if (!sub) continue;
          const compNorm = normNomeVisa(r['Complexidade'] || '').toLowerCase();
          if (compNorm !== 'alta' && compNorm !== 'media' && compNorm !== 'baixa') continue;
          const desc = String(r['Atividade'] || '').replace(/"/g, '').trim();
          cnaeMap.set(sub, { complexidade: compNorm, descricao: desc });
        }
        onProgress(`🧬 ${cnaeMap.size} CNAE(s) de competência carregado(s).`, 'info');
      }
    } catch (err) {
      onProgress('⚠️ Não foi possível carregar cnae.csv — expansão por CNAE do regulado desabilitada.', 'warn');
      console.error('Failed to load cnae.csv:', err);
    }

    // ── CNAEs do regulado (data/cae.csv) ─────────────────────
    // Mapa Codigo(regulado) → Map<CNAE, { cnae, stats }>. Dedup por CNAE;
    // linhas com Stats "Não Exerce" são excluídas; Subclasse vazia é ignorada.
    const caeMap = new Map();
    try {
      const caeText = await window.fetchGitHubCSV('data/cae.csv');
      if (caeText !== null) {
        const caeParsed = Papa.parse(caeText, {
          header: true,
          delimiter: ';',
          skipEmptyLines: true,
          transformHeader: h => h.replace(/^﻿/, '').replace(/^"|"$/g, '').trim(),
        });
        for (const r of caeParsed.data) {
          const cod = String(r['Codigo'] || '').replace(/"/g, '').trim();
          const sub = String(r['Subclasse'] || '').replace(/"/g, '').trim();
          if (!cod || !sub) continue;
          if (normNomeVisa(r['Stats'] || '') === 'NAO EXERCE') continue;
          if (!caeMap.has(cod)) caeMap.set(cod, new Map());
          const m = caeMap.get(cod);
          if (!m.has(sub)) m.set(sub, { cnae: sub, stats: normNomeVisa(r['Stats'] || '') });
        }
        onProgress(`🏷️ ${caeMap.size} regulado(s) com CNAEs carregado(s).`, 'info');
      }
    } catch (err) {
      onProgress('⚠️ Não foi possível carregar cae.csv — usando apenas o CNAE da inspeção.', 'warn');
      console.error('Failed to load cae.csv:', err);
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
    const processedKeys = new Set(); // "fiscalEmail::controleVisa::cnae"
    const pontosEstadoCache = new Map();

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

      const motivoOS = String(row['Modalidade'] || row['modalidade'] || row['MODALIDADE'] || '').replace(/"/g, '').trim();
      const motivoOSNorm = normNomeVisa(motivoOS);
      const pontosFinal = motivoOSNorm === 'PLANTAO FISCAL' ? 0 : tipoInfo.pontos;

      const dataISO = visaDataToISO(String(row['DT_VISITA'] || '').replace(/"/g, '').trim());
      const os = String(row['OS'] || row['NUMERO'] || '').replace(/"/g, '').trim();
      const oficio = String(row['Oficio'] || row['OFICIO'] || '').replace(/"/g, '').trim();
      const protocolo = String(row['Protocolo'] || row['PROTOCOLO'] || '').replace(/"/g, '').trim();
      const denuncia = String(row['Denuncia'] || row['DENUNCIA'] || '').replace(/"/g, '').trim();
      let osNumero = '';
      if      (motivoOSNorm === 'DE OFICIO')    osNumero = oficio;
      else if (motivoOSNorm === 'PROTOCOLO')    osNumero = protocolo;
      else if (motivoOSNorm === 'DENUNCIA')     osNumero = denuncia;
      else if (motivoOSNorm === 'REQUERIMENTO') osNumero = os;
      const documento = tipoRaw;

      const rawFiscais = [
        { nome: row['Fiscal1'], isTerceiro: false },
        { nome: row['Fiscal2'], isTerceiro: false },
        { nome: row['Fiscal3'], isTerceiro: true  },
      ];
      const fiscaisCsv = rawFiscais
        .map(f => ({ ...f, nome: String(f.nome || '').replace(/"/g, '').trim() }))
        .filter(f => f.nome);

      // ── CNAEs-alvo da inspeção ───────────────────────────
      // Vistoria (VIS): expande em 1 lançamento por CNAE de competência —
      // o CNAE informado na inspeção e os CNAEs do regulado (cae.csv ∩ cnae.csv,
      // exceto "Não Exerce"). A soma dos pontos desses CNAEs não pode exceder
      // TETO_PONTOS_CNAE_VISA (48): seleciona por maior pontuação primeiro
      // (informado primeiro em empate) e NÃO lança os CNAEs que não couberem
      // no teto. Demais tipos seguem com 1 lançamento pelo CNAE da inspeção.
      const codigoRegulado = String(row['CODIGO'] || '').replace(/"/g, '').trim();
      const entregaRaw = String(row['entrega'] || row['Entrega'] || row['ENTREGA'] || '').replace(/"/g, '').trim().toLowerCase();
      const entregaFalse = entregaRaw === 'false' || entregaRaw === '0' || entregaRaw === 'nao' || entregaRaw === 'não';
      const caeListMap = caeMap.get(codigoRegulado);
      const caeList = caeListMap ? [...caeListMap.values()] : [];
      const alvos = [];
      if (tipoInfo.tipo_codigo === 'VIS' && !entregaFalse) {
        const candidatos = [];
        // CNAE informado na inspeção (pontos pela complexidade; default média = 12)
        if (subclasse) {
          candidatos.push({
            cnae: subclasse,
            complexidade: cnaeInfo.complexidade,
            descricao: cnaeInfo.descricao,
            pontos: complexToItem(cnaeInfo.complexidade).pontos,
            informado: true,
          });
        }
        // CNAEs de competência do regulado (cae.csv ∩ cnae.csv), exceto o já informado
        for (const item of caeList) {
          if (item.cnae === subclasse) continue; // não duplica o informado
          const info = cnaeMap.get(item.cnae);
          if (!info) continue; // CNAE sem competência da vigilância → fora
          candidatos.push({
            cnae: item.cnae,
            complexidade: info.complexidade,
            descricao: info.descricao,
            pontos: complexToItem(info.complexidade).pontos,
            informado: false,
          });
        }
        // Ordena por pontos desc; em empate, informado primeiro (sort estável
        // mantém a ordem do cae.csv no restante).
        candidatos.sort((a, b) => (b.pontos - a.pontos) || (Number(b.informado) - Number(a.informado)));
        // Seleção gulosa respeitando o teto de pontos da inspeção
        let somaPontos = 0;
        for (const c of candidatos) {
          if (somaPontos + c.pontos > TETO_PONTOS_CNAE_VISA) continue; // não cabe → não lança
          somaPontos += c.pontos;
          alvos.push({ cnae: c.cnae, complexidade: c.complexidade, descricao: c.descricao,
                       cnae_origem: c.informado ? 'INS' : 'CAE' });
        }
      } else {
        // Tipos não-VIS: o CNAE é sempre o informado na inspeção (inspecoes.csv).
        alvos.push({ cnae: subclasse, complexidade: cnaeInfo.complexidade, descricao: cnaeInfo.descricao,
                     cnae_origem: subclasse ? 'INS' : '' });
      }

      if (alvos.length === 0) {
        ignorados++;
        onProgress(`⚠️ CONTROLE ${controleVisa}: regulado ${codigoRegulado || '—'} sem CNAE de competência, ignorado.`, 'warn');
        continue;
      }

      for (const { nome: nomeFiscalCsv, isTerceiro } of fiscaisCsv) {
        const emailFiscal = fiscalMap.get(normNomeVisa(nomeFiscalCsv));
        if (!emailFiscal) continue;
        if (fiscalEmail && emailFiscal !== fiscalEmail) continue;

        // Preserva lançamento legado homologado (esquema antigo: 1 por controle,
        // sem CNAE no ID). Mantém o registro intacto e não expande, evitando
        // dupla contagem do mesmo CNAE.
        try {
          const legacy = await window.db_getVISAManual(controleVisa, emailFiscal);
          if (legacy && (legacy.status === 'aceito' || legacy.status === 'fechado')) {
            processedKeys.add(emailFiscal + '::' + controleVisa + '::' + (legacy.visa_cnae || ''));
            ignorados++;
            onProgress(`⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: já homologado (legado), preservado.`, 'warn');
            continue;
          }
        } catch (_) { /* sem registro legado — segue para a expansão normal */ }

        for (const alvo of alvos) {
          const tipoInfoA    = resolverTipoVisa(tipoRaw, alvo.complexidade);
          const pontosFinalA = motivoOSNorm === 'PLANTAO FISCAL' ? 0 : tipoInfoA.pontos;
          const descPartsA   = [];
          if (alvo.cnae) descPartsA.push('CNAE ' + alvo.cnae);
          if (alvo.descricao && alvo.descricao !== alvo.cnae) descPartsA.push(alvo.descricao);
          const descricaoA   = descPartsA.join(' — ') || tipoInfoA.descLabel;

          // Marca como presente no CSV para detecção de registros órfãos
          processedKeys.add(emailFiscal + '::' + controleVisa + '::' + alvo.cnae);

          try {
            const existing = await window.db_getVISAManual(controleVisa, emailFiscal, alvo.cnae);
            let estadoPontos = null;
            let pontosFiscal = pontosFinalA;

            // ── Vistoria não cumulativa com Plantão Fiscal manual na data ─
            // Se o fiscal tem lançamento manual de plantão (PLT) nesta data,
            // a vistoria importada do VISA entra com pontos zerados.
            if (tipoInfoA.tipo_codigo === 'VIS' && dataISO && pontosFiscal > 0) {
              estadoPontos = await _getEstadoPontosVisa(pontosEstadoCache, emailFiscal, mes, ano);
              if (estadoPontos.plantaoDatas.has(dataISO)) {
                pontosFiscal = 0;
                onProgress(
                  `⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: vistoria zerada — ` +
                  `plantão fiscal manual em ${fmtData(dataISO)}.`,
                  'warn'
                );
              }
            }

            // ── Verificar limite de 24 pts em dia com ocorrência aceita ─
            if (dataISO) {
              const dtParts = dataISO.split('-');
              const dtMes = Number(dtParts[1]);
              const dtAno = Number(dtParts[0]);
              const ocorrAceitas = await _getOcorrenciasAceitasVisa(emailFiscal, dtMes, dtAno);
              if (_dataCobertaOcorrVisa(dataISO, ocorrAceitas)) {
                estadoPontos = await _getEstadoPontosVisa(pontosEstadoCache, emailFiscal, dtMes, dtAno);
                const somaDia = estadoPontos.byDia.get(dataISO) || 0;
                const pontosExistenteMesmoDoc =
                  existing && _manualContaNoLimiteOcorrenciaVisa(existing) && existing.data === dataISO
                    ? (Number(existing.pontos) || 0)
                    : 0;
                const baseDia = somaDia - pontosExistenteMesmoDoc;
                const totalDia = baseDia + (Number(pontosFiscal) || 0);
                if (totalDia > LIMITE_PONTOS_OCORRENCIA_DIA) {
                  ignorados++;
                  onProgress(
                    `⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: dia ${dataISO} com ocorrência aceita ` +
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
                onProgress(`⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: já homologado, ignorado.`, 'warn');
                continue;
              }
              const updateData = {
                fiscal_nome: nomeFiscalCsv,
                mes, ano, data: dataISO,
                tipo_id: tipoInfoA.tipo_id, tipo_codigo: tipoInfoA.tipo_codigo,
                tipo_nome: tipoInfoA.tipo_nome,
                item_pontuacao: tipoInfoA.item_pontuacao,
                complexidade: alvo.complexidade,
                pontos: pontosFiscal, descricao: descricaoA,
                motivo_os: motivoOS,
                os_numero: osNumero,
                documento,
                origem: 'visa_csv',
                visa_controle: controleVisa,
                visa_cnae: alvo.cnae,
                cnae_origem: alvo.cnae_origem,
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
                  updateData.status = 'pendente';
                  updateData.motivo_pendencia = 'Fiscal3 sem autorização de terceiro fiscal (OS/Ofício não consta como autorizado)';
                  onProgress(`⚠️ CONTROLE ${controleVisa} — Fiscal3 sem autorização, marcado como pendente.`, 'warn');
                } else if (existing.status === 'pendente') {
                  updateData.status = 'enviado';
                  updateData.motivo_pendencia = null;
                  onProgress(`✅ CONTROLE ${controleVisa} — Fiscal3 agora autorizado, restaurado para enviado.`, 'info');
                }
              }
              await window.db_upsertVISAManual(controleVisa, emailFiscal, updateData, existing.id, false, alvo.cnae);
              const estado = estadoPontos || await _getEstadoPontosVisa(pontosEstadoCache, emailFiscal, mes, ano);
              _aplicarManualNoMapaPontosVisa(estado.byDia, existing, -1);
              const manualAtualizado = { ...existing, ...updateData, id: existing.id };
              _aplicarManualNoMapaPontosVisa(estado.byDia, manualAtualizado, 1);
              estado.docsById.set(existing.id, manualAtualizado);
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
              let motivoPendencia = null;
              if (isTerceiro && !isTerceiroFiscalAutorizado(os, oficio, requerimentoMap, oficioMap)) {
                statusInicial = 'pendente';
                motivoPendencia = 'Fiscal3 sem autorização de terceiro fiscal (OS/Ofício não consta como autorizado)';
                onProgress(`⚠️ CONTROLE ${controleVisa} — Fiscal3 sem autorização, marcado como pendente.`, 'warn');
              }
              await window.db_upsertVISAManual(controleVisa, emailFiscal, {
                controle: 'VISA-' + controleVisa,
                fiscal_email: emailFiscal,
                fiscal_nome: nomeFiscalCsv,
                mes, ano, data: dataISO,
                tipo_id: tipoInfoA.tipo_id, tipo_codigo: tipoInfoA.tipo_codigo,
                tipo_nome: tipoInfoA.tipo_nome,
                item_pontuacao: tipoInfoA.item_pontuacao,
                complexidade: alvo.complexidade,
                pontos: pontosFiscal, descricao: descricaoA,
                motivo_os: motivoOS,
                os_numero: osNumero,
                documento,
                status: statusInicial,
                motivo_pendencia: motivoPendencia,
                origem: 'visa_csv',
                visa_controle: controleVisa,
                visa_cnae: alvo.cnae,
                cnae_origem: alvo.cnae_origem,
              }, null, true, alvo.cnae);
              const estado = estadoPontos || await _getEstadoPontosVisa(pontosEstadoCache, emailFiscal, mes, ano);
              _aplicarManualNoMapaPontosVisa(estado.byDia, {
                data: dataISO, pontos: pontosFiscal, origem: 'visa_csv', status: statusInicial,
              }, 1);
              criados++;
            }
          } catch(e) {
            erros++;
            onProgress('🚨 Erro CONTROLE ' + controleVisa + ': ' + e.message, 'danger');
          }
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
        const key = (m.fiscal_email || '') + '::' + (m.visa_controle || '') + '::' + (m.visa_cnae || '');
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

window.visaMesAberto            = visaMesAberto;
window.importarInspecoesVISA    = importarInspecoesVISA;
window.ehPlantaoManual          = ehPlantaoManual;
window.ehVistoriaImportada      = ehVistoriaImportada;
window.datasComPlantaoManual    = datasComPlantaoManual;
window.vistoriasImportadasNoDia = vistoriasImportadasNoDia;
