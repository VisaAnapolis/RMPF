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
      opfDatas: datasComOpfManual(docs),
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

// ── Regra Operação Fiscal (OPF) × Vistoria importada ─────
// Decreto item 18: a operação fiscal (OPF, lançada manualmente) não é cumulativa
// com a vistoria (VIS) no mesmo dia. Uma OPF manual zera os pontos das vistorias
// importadas (VISA/SIM) lançadas na mesma data.
function ehOpfManual(m) {
  return !!m && m.tipo_codigo === 'OPF' &&
         m.origem !== 'visa_csv' && m.origem !== 'sim_csv' && m.status !== 'recusado';
}

function datasComOpfManual(manuais) {
  const s = new Set();
  for (const m of (manuais || [])) {
    if (ehOpfManual(m) && m.data) s.add(m.data);
  }
  return s;
}

// Vistoria importada (VISA ou SIM) — usada para bloquear o lançamento de OPF
// manual em data que já possui vistoria.
function ehVistoriaQualquer(m) {
  return !!m && m.tipo_codigo === 'VIS' && (m.origem === 'visa_csv' || m.origem === 'sim_csv');
}

async function vistoriasNoDia(fiscalEmail, dataISO, excluirId = null) {
  if (!fiscalEmail || !dataISO) return [];
  const parts = String(dataISO).split('-');
  if (parts.length !== 3) return [];
  const ano = Number(parts[0]);
  const mes = Number(parts[1]);
  if (!ano || !mes) return [];
  const manuais = await window.db_getManuais(fiscalEmail, mes, ano);
  return manuais.filter(m => m.id !== excluirId && m.data === dataISO && ehVistoriaQualquer(m));
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

// \u2500\u2500 Pontua\u00e7\u00e3o por \u00e1rea (m\u00b2) para CNAEs de alta complexidade de alimenta\u00e7\u00e3o \u2500\u2500
// Equipes "IA" ou "AG" no cnae.csv marcam a \u00e1rea de alimenta\u00e7\u00e3o. Quando o CNAE
// \u00e9 de alta complexidade dessas equipes, a pontua\u00e7\u00e3o deixa de ser 48 fixo e passa
// a depender da \u00e1rea f\u00edsica do estabelecimento (taxa.csv, via regulados.csv):
//   \u2264 100 m\u00b2 \u2192 8 | > 100 e < 400 m\u00b2 \u2192 16 | \u2265 400 m\u00b2 \u2192 48 | sem \u00e1rea \u2192 48 (m\u00e1xima)
const EQUIPES_ALIMENTACAO_VISA = ['IA', 'AG'];

function ehAlimentacaoAlta(complexidade, equipe) {
  if (complexToItem(complexidade).pontos !== 48) return false; // s\u00f3 alta
  const eq = String(equipe || '').toUpperCase().trim();
  return EQUIPES_ALIMENTACAO_VISA.includes(eq);
}

function pontosPorAreaVisa(area) {
  if (area == null) return 48;          // sem \u00e1rea no arquivo \u2192 pontua\u00e7\u00e3o m\u00e1xima
  if (area <= 100)  return 8;
  if (area < 400)   return 16;
  return 48;                            // \u2265 400 m\u00b2 (inclusive)
}

// \u2500\u2500 Redu\u00e7\u00e3o por dupla/trio fiscal (decreto E.2) \u2500\u2500
// Em Vistorias realizadas por 2+ fiscais, a pontua\u00e7\u00e3o dos CNAEs de baixa e
// m\u00e9dia complexidade \u00e9 reduzida para cada fiscal individualmente:
//   m\u00e9dia (12) \u2192 9 (\u221225%) | baixa (6) \u2192 3 (\u221250%).
// Alta (inclusive a alta-alimenta\u00e7\u00e3o j\u00e1 ajustada por \u00e1rea) N\u00c3O \u00e9 reduzida.
function pontosReduzidosDuplaVisa(complexidade, pontos) {
  const item = complexToItem(complexidade).item;
  if (item === 2) return 9;   // m\u00e9dia 12 \u2192 9 (\u221225%)
  if (item === 3) return 3;   // baixa   6 \u2192 3 (\u221250%)
  return pontos;              // alta inalterada
}

// Normaliza inscri\u00e7\u00e3o municipal p/ casar regulados.csv (ex.: "29.601") com
// taxa.csv (ex.: "29601"): mant\u00e9m s\u00f3 d\u00edgitos e remove zeros \u00e0 esquerda.
function normMunicipalVisa(v) {
  return String(v || '').replace(/\D/g, '').replace(/^0+/, '');
}

// Extrai a \u00e1rea (m\u00b2) do taxa.csv. O arquivo \u00e9 ISO-8859-1 e cada registro ocupa
// 2 linhas f\u00edsicas (quebra dentro do campo "Observa\u00e7\u00e3o", sem aspas), o que
// inviabiliza Papa.parse direto. Retorna Map<inscricaoMunicipalNormalizada, m\u00b2>.
// S\u00f3 extra\u00edmos d\u00edgitos/pontos (ASCII), ent\u00e3o o mojibake do decode UTF-8 sobre
// bytes latin1 (acentos/\u00b2) \u00e9 irrelevante.
function parseTaxaArea(text) {
  const map = new Map();
  if (!text) return map;
  const linhasFisicas = String(text).split(/\r?\n/);
  const registros = [];
  for (const ln of linhasFisicas) {
    // Linha de continua\u00e7\u00e3o da Observa\u00e7\u00e3o (ex.: "* \u00c1rea: 150m\u00b2") \u2192 anexa \u00e0 anterior.
    if (/^\s*\*/.test(ln) && registros.length) {
      registros[registros.length - 1] += ' ' + ln;
    } else {
      registros.push(ln);
    }
  }
  for (let i = 0; i < registros.length; i++) {
    if (i === 0) continue; // cabe\u00e7alho
    const reg = registros[i];
    if (!reg.trim()) continue;
    const campos = reg.split(';');
    if (campos.length < 5) continue;
    const im = normMunicipalVisa(campos[4]);
    if (!im) continue;
    const mArea = reg.match(/rea:\s*([\d.,]+)\s*m/i);
    if (!mArea) continue;
    const area = parseFloat(mArea[1].replace(',', '.'));
    if (!isFinite(area)) continue;
    if (!map.has(im)) map.set(im, area); // primeira metragem v\u00e1lida por inscri\u00e7\u00e3o
  }
  return map;
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
          let compNorm = normNomeVisa(r['Complexidade'] || '').toLowerCase();
          if (compNorm !== 'alta' && compNorm !== 'media' && compNorm !== 'baixa') continue;
          // Exceção do Decreto 49.723/2023 (item C) sobrepõe a classificação da LC 377.
          let complexidadeOrigem = null;
          const ovr = complexidadeDecreto(sub);
          if (ovr) {
            const ovrNorm = normNomeVisa(ovr).toLowerCase();
            if (ovrNorm !== compNorm) { complexidadeOrigem = compNorm; compNorm = ovrNorm; }
          }
          const desc = String(r['Atividade'] || '').replace(/"/g, '').trim();
          const equipe = String(r['equipe'] || r['Equipe'] || r['EQUIPE'] || '').replace(/"/g, '').trim();
          cnaeMap.set(sub, { complexidade: compNorm, complexidade_origem: complexidadeOrigem, descricao: desc, equipe });
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

    // ── Regulados (data/regulados.csv) ───────────────────────
    // Mapa CODIGO(regulado) → { municipal (inscrição normalizada), razao }.
    // Fornece a razão social e a inscrição municipal (ponte para o taxa.csv).
    // ⚠️ A coluna AREA do regulados.csv NÃO é a metragem (são códigos cadastrais).
    const reguladoMap = new Map();
    try {
      const regText = await window.fetchGitHubCSV('data/regulados.csv');
      if (regText !== null) {
        const regParsed = Papa.parse(regText, {
          header: true,
          delimiter: ';',
          skipEmptyLines: true,
          transformHeader: h => h.replace(/^﻿/, '').replace(/^"|"$/g, '').trim(),
        });
        for (const r of regParsed.data) {
          const cod = String(r['CODIGO'] || r['Codigo'] || '').replace(/"/g, '').trim();
          if (!cod) continue;
          const municipal = normMunicipalVisa(r['MUNICIPAL'] || r['Municipal'] || '');
          const razao = String(r['RAZAO'] || r['Razao'] || '').replace(/"/g, '').trim();
          if (!reguladoMap.has(cod)) reguladoMap.set(cod, { municipal, razao });
        }
        onProgress(`🏢 ${reguladoMap.size} regulado(s) carregado(s) (código/razão/inscrição).`, 'info');
      }
    } catch (err) {
      onProgress('⚠️ Não foi possível carregar regulados.csv — código/razão/área indisponíveis.', 'warn');
      console.error('Failed to load regulados.csv:', err);
    }

    // ── Áreas por inscrição municipal (data/taxa.csv) ────────
    // Carregado de forma preguiçosa (arquivo grande, ~6 MB): só na primeira vez
    // que surgir um candidato de alta complexidade de alimentação. Cacheado em
    // taxaAreaState para reuso. Map<inscricaoMunicipalNormalizada, áreaM²>.
    let taxaAreaMap = null; // null = ainda não carregado
    async function getTaxaAreaMap() {
      if (taxaAreaMap !== null) return taxaAreaMap;
      taxaAreaMap = new Map();
      try {
        const taxaText = await window.fetchGitHubCSV('data/taxa.csv');
        if (taxaText !== null) {
          taxaAreaMap = parseTaxaArea(taxaText);
          onProgress(`📐 ${taxaAreaMap.size} área(s) de estabelecimento carregada(s).`, 'info');
        }
      } catch (err) {
        onProgress('⚠️ Não foi possível carregar taxa.csv — alta de alimentação usa pontuação máxima (48).', 'warn');
        console.error('Failed to load taxa.csv:', err);
      }
      return taxaAreaMap;
    }
    // Resolve a área (m²) do regulado: CODIGO → inscrição municipal → taxa.csv.
    // Retorna null quando indisponível (cai no fallback de 48 pontos).
    async function resolverAreaRegulado(codigoRegulado) {
      const reg = reguladoMap.get(codigoRegulado);
      if (!reg || !reg.municipal) return null;
      const mapa = await getTaxaAreaMap();
      const area = mapa.get(reg.municipal);
      return (area == null) ? null : area;
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
    const processedKeys = new Set(); // "fiscalEmail::controleVisa::cnae"
    const pontosEstadoCache = new Map();

    for (let idx = 0; idx < rowsFiltradas.length; idx++) {
      const row = rowsFiltradas[idx];
      if (onProgressBar) onProgressBar(idx + 1, rowsFiltradas.length);

      const controleVisa = String(row['CONTROLE'] || '').replace(/"/g, '').trim();
      if (!controleVisa) continue;

      const subclasse = String(row['Atividade'] || '').replace(/"/g, '').trim();
      // Complexidade/descrição do CNAE informado vêm do cnaeMap (data/cnae.csv),
      // já carregado em memória — fonte única de CNAE. O cnaeMap já aplica o
      // override do Decreto 49.723/2023 (item C) e expõe a complexidade original
      // em complexidade_origem (mesma fonte usada para os CNAEs do CAE abaixo).
      // Default Média quando o CNAE não consta no cnae.csv.
      const subInfo = subclasse ? cnaeMap.get(subclasse) : null;
      const cnaeInfo = subInfo
        ? { complexidade: subInfo.complexidade, descricao: subInfo.descricao }
        : { complexidade: 'média', descricao: subclasse };
      const complexidadeOrigemInformado = subInfo ? (subInfo.complexidade_origem || null) : null;

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
      const regInfo = reguladoMap.get(codigoRegulado) || { municipal: '', razao: '' };
      const entregaRaw = String(row['entrega'] || row['Entrega'] || row['ENTREGA'] || '').replace(/"/g, '').trim().toLowerCase();
      const entregaFalse = entregaRaw === 'false' || entregaRaw === '0' || entregaRaw === 'nao' || entregaRaw === 'não';
      const caeListMap = caeMap.get(codigoRegulado);
      const caeList = caeListMap ? [...caeListMap.values()] : [];
      const alvos = [];
      if (tipoInfo.tipo_codigo === 'VIS' && !entregaFalse) {
        const candidatos = [];
        // CNAE informado na inspeção (pontos pela complexidade; default média = 12).
        // complexidade/descrição/equipe (alimentação IA/AG) vêm todas do cnae.csv
        // (cnaeMap/subInfo) — fonte única.
        if (subclasse) {
          candidatos.push({
            cnae: subclasse,
            complexidade: cnaeInfo.complexidade,
            complexidade_origem: complexidadeOrigemInformado,
            descricao: cnaeInfo.descricao,
            equipe: (subInfo || {}).equipe || '',
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
            complexidade_origem: info.complexidade_origem || null,
            descricao: info.descricao,
            equipe: info.equipe || '',
            pontos: complexToItem(info.complexidade).pontos,
            informado: false,
          });
        }
        // ── Pontuação por área (alta de alimentação IA/AG) ──
        // Para esses CNAEs, a pontuação depende da área física do regulado
        // (taxa.csv). Resolve a área uma única vez (carrega o taxa.csv só agora,
        // de forma preguiçosa) e ajusta os pontos antes da seleção do teto.
        if (candidatos.some(c => ehAlimentacaoAlta(c.complexidade, c.equipe))) {
          const areaRegulado = await resolverAreaRegulado(codigoRegulado);
          for (const c of candidatos) {
            if (ehAlimentacaoAlta(c.complexidade, c.equipe)) {
              c.pontos = pontosPorAreaVisa(areaRegulado);
              c.visa_area = areaRegulado; // pode ser null (sem área) → exibe '—', pontos 48
            }
          }
        }
        // ── Redução por dupla/trio fiscal (baixa e média) ──
        // Decreto E.2: em fiscalização com 2+ fiscais, os CNAEs de baixa/média
        // complexidade têm a pontuação reduzida para cada fiscal (média 12→9,
        // baixa 6→3). Entra na seleção do teto de 48 já com o valor reduzido.
        // fiscaisCsv.length = participantes físicos no CSV (inclui Fiscal3 mesmo
        // não autorizado); como dupla e trio reduzem igual, isso só muda o nº
        // exibido, não os pontos.
        const qtdFiscais = fiscaisCsv.length;
        if (qtdFiscais >= 2) {
          for (const c of candidatos) {
            const item = complexToItem(c.complexidade).item;
            if (item === 2 || item === 3) {          // só média/baixa (alta intacta)
              c.pontos = pontosReduzidosDuplaVisa(c.complexidade, c.pontos);
              c.qtd_fiscais = qtdFiscais;            // marca aplicação da regra
            }
          }
        }
        // Ordena por pontos desc; em empate, informado primeiro (sort estável
        // mantém a ordem do cae.csv no restante).
        candidatos.sort((a, b) => (b.pontos - a.pontos) || (Number(b.informado) - Number(a.informado)));
        // Seleção gulosa respeitando o teto de pontos da inspeção (usa os pontos
        // já ajustados pela área).
        let somaPontos = 0;
        for (const c of candidatos) {
          if (somaPontos + c.pontos > TETO_PONTOS_CNAE_VISA) continue; // não cabe → não lança
          somaPontos += c.pontos;
          alvos.push({ cnae: c.cnae, complexidade: c.complexidade, descricao: c.descricao,
                       cnae_origem: c.informado ? 'INS' : 'CAE',
                       pontos: c.pontos, visa_area: c.visa_area ?? null,
                       qtd_fiscais: c.qtd_fiscais ?? null,
                       complexidade_origem: c.complexidade_origem || null });
        }
      } else {
        // Tipos não-VIS: o CNAE é sempre o informado na inspeção (inspecoes.csv).
        // A redução por dupla/trio não se aplica (abrangência = só Vistorias).
        alvos.push({ cnae: subclasse, complexidade: cnaeInfo.complexidade, descricao: cnaeInfo.descricao,
                     cnae_origem: subclasse ? 'INS' : '', pontos: null, visa_area: null, qtd_fiscais: null,
                     complexidade_origem: complexidadeOrigemInformado || null });
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
          // Usa os pontos já ajustados pela área (alta de alimentação) quando
          // presentes; senão, os pontos padrão do tipo/complexidade.
          const pontosBaseA  = (alvo.pontos != null) ? alvo.pontos : tipoInfoA.pontos;
          const pontosFinalA = motivoOSNorm === 'PLANTAO FISCAL' ? 0 : pontosBaseA;
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
              } else if (estadoPontos.opfDatas.has(dataISO)) {
                pontosFiscal = 0;
                onProgress(
                  `⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: vistoria zerada — ` +
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
                complexidade_decreto: !!alvo.complexidade_origem,
                complexidade_origem: alvo.complexidade_origem || null,
                pontos: pontosFiscal, descricao: descricaoA,
                motivo_os: motivoOS,
                os_numero: osNumero,
                documento,
                origem: 'visa_csv',
                visa_controle: controleVisa,
                visa_cnae: alvo.cnae,
                cnae_origem: alvo.cnae_origem,
                codigo: codigoRegulado,
                razao: regInfo.razao || '',
                municipal: regInfo.municipal || '',
                visa_area: alvo.visa_area ?? null,
                qtd_fiscais: alvo.qtd_fiscais ?? null,
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
                complexidade_decreto: !!alvo.complexidade_origem,
                complexidade_origem: alvo.complexidade_origem || null,
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
                codigo: codigoRegulado,
                razao: regInfo.razao || '',
                municipal: regInfo.municipal || '',
                visa_area: alvo.visa_area ?? null,
                qtd_fiscais: alvo.qtd_fiscais ?? null,
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
window.datasComOpfManual        = datasComOpfManual;
window.vistoriasNoDia           = vistoriasNoDia;
