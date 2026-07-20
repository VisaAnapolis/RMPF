// js/visa-import.js
// Módulo de importação de inspeções do VISA para o RMPF

const VISA_IMPORT_INICIO_MES = 4;
const VISA_IMPORT_INICIO_ANO = 2026;
// Teto de pontos somados dos CNAEs (informado + inspecoes_cnae.csv) por inspeção VISA.
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

async function _getEstadoPontosVisa(cache, emailFiscal, mes, ano, nomeFiscal) {
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
      relAltaDatas: datasComRelAltaImportada(docs),
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

// ── Regra Plantão fiscal × Vistoria importada ────────────
// Um lançamento manual de Plantão Fiscal (tipo PLT) torna as vistorias
// importadas do VISA na mesma data não cumulativas → pontos zerados.

function ehPlantaoManual(m) {
  return !!m && m.tipo_codigo === 'PLT' && m.origem !== 'visa_csv' && m.status !== 'recusado';
}

// Conjunto de datas (yyyy-mm-dd) que possuem plantão manual na lista informada.
function datasComPlantaoManual(manuais) {
  const s = new Set();
  for (const m of (manuais || [])) {
    if (ehPlantaoManual(m) && m.data) s.add(m.data);
  }
  return s;
}

// Vistorias importadas (VISA ou SIM, tipo VIS) lançadas em uma data para um fiscal.
// Considera apenas as que GERAM pontos (pontos > 0): a não cumulatividade com o plantão
// fiscal só faz sentido quando há pontuação a não cumular. Vistorias zeradas — ex.: origem
// da demanda "PLANTÃO FISCAL", que entra com pontos = 0 na importação — não são impeditivas.
// `excluirId` ignora um documento específico (útil ao editar o próprio registro).
// Usa `ehVistoriaQualquer` (definida abaixo, junto da regra OPF×Vistoria) para cobrir as
// duas origens de importação — sem isso, uma vistoria do SIM não bloquearia o lançamento
// manual de um plantão no mesmo dia.
async function vistoriasImportadasNoDia(fiscalEmail, dataISO, excluirId = null) {
  if (!fiscalEmail || !dataISO) return [];
  const parts = String(dataISO).split('-');
  if (parts.length !== 3) return [];
  const ano = Number(parts[0]);
  const mes = Number(parts[1]);
  if (!ano || !mes) return [];
  const manuais = await window.db_getManuais(fiscalEmail, mes, ano);
  return manuais.filter(m =>
    m.id !== excluirId &&
    m.data === dataISO &&
    ehVistoriaQualquer(m) &&
    (Number(m.pontos) || 0) > 0          // só vistorias que geram pontos são impeditivas
  );
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

// ── Regra Relatório técnico de inspeção (alta) × Vistoria ─
// Decreto item 13: a elaboração de relatório técnico de inspeção de alta
// complexidade não é cumulativa com a pontuação de vistoria no mesmo dia.
// REL só existe via importação do VISA (nunca lançamento manual — tipo
// somenteCsv), então, ao contrário de Plantão/OPF, não há bloqueio de
// lançamento manual a fazer aqui: a regra é só zerar a vistoria do mesmo dia.
function ehRelAltaImportada(m) {
  return !!m && m.origem === 'visa_csv' && m.tipo_codigo === 'REL' &&
         m.item_pontuacao === 10 && m.status !== 'recusado';
}

function datasComRelAltaImportada(manuais) {
  const s = new Set();
  for (const m of (manuais || [])) {
    if (ehRelAltaImportada(m) && m.data) s.add(m.data);
  }
  return s;
}

// ── Regra 48×48 — atividades de dia inteiro (manuais) não cumulativas ────
// Plantão fiscal (PLT), Operação fiscal (OPF) e Serviços técnicos requisitados
// pela chefia (SRV) valem 48 pts e representam um DIA INTEIRO de serviço; por
// isso não são cumulativas ENTRE SI no mesmo dia (Decreto 49.723/2023, Anexo
// VII). A regra vale apenas para LANÇAMENTOS MANUAIS — atividades importadas
// (VISA/SIM), inclusive o relatório técnico de alta (REL, 48 pts, só CSV), não
// entram nesta verificação e não são afetadas por ela.
const TIPOS_DIA_INTEIRO_MANUAL = ['PLT', 'OPF', 'SRV'];

function ehAtividadeDiaInteiroManual(m) {
  return !!m && TIPOS_DIA_INTEIRO_MANUAL.includes(m.tipo_codigo) &&
         m.origem !== 'visa_csv' && m.origem !== 'sim_csv' && m.status !== 'recusado';
}

// Atividades de dia inteiro (48 pts) já lançadas manualmente numa data para o
// fiscal — usadas para impedir uma segunda no mesmo dia. `excluirId` ignora o
// próprio registro (ao editar/mover). Retorna a lista dos lançamentos.
async function atividadesDiaInteiroNoDia(fiscalEmail, dataISO, excluirId = null) {
  if (!fiscalEmail || !dataISO) return [];
  const parts = String(dataISO).split('-');
  if (parts.length !== 3) return [];
  const ano = Number(parts[0]);
  const mes = Number(parts[1]);
  if (!ano || !mes) return [];
  const manuais = await window.db_getManuais(fiscalEmail, mes, ano);
  return manuais.filter(m =>
    m.id !== excluirId && m.data === dataISO && ehAtividadeDiaInteiroManual(m)
  );
}

// ── Motivo de não cumulatividade de uma vistoria num dia (uso avulso) ────
// Verificação leve (1 consulta), usada fora do fluxo de importação — ex.:
// revalidar na homologação (conferencia.html) se ainda é seguro aceitar
// pontos > 0 para uma vistoria, dado que Plantão/OPF/REL-alta do mesmo
// fiscal no mesmo dia podem tê-la tornado não cumulativa nesse meio-tempo.
// Retorna a frase-motivo (citando o item do Anexo VII) ou null se não há conflito.
async function motivoNaoCumulatividadeVistoria(fiscalEmail, dataISO, excluirId = null) {
  if (!fiscalEmail || !dataISO) return null;
  const parts = String(dataISO).split('-');
  if (parts.length !== 3) return null;
  const ano = Number(parts[0]);
  const mes = Number(parts[1]);
  if (!ano || !mes) return null;
  const manuais = await window.db_getManuais(fiscalEmail, mes, ano);
  for (const m of manuais) {
    if (m.id === excluirId || m.data !== dataISO) continue;
    if (ehPlantaoManual(m))    return 'plantão fiscal manual no mesmo dia (Anexo VII, item 9)';
    if (ehOpfManual(m))        return 'operação fiscal manual no mesmo dia (Anexo VII, item 18)';
    if (ehRelAltaImportada(m)) return 'relatório técnico de inspeção (alta complexidade) no mesmo dia (Anexo VII, item 13)';
  }
  // Fiscal escalado pela gerência para plantão na data (escala do VISA) também
  // torna a vistoria não cumulativa (item 9), mesmo sem PLT manual lançado.
  // Fail-open: sem escala publicada/nome não resolvido, não há conflito.
  if (typeof window.fiscalEscaladoNoDia === 'function' &&
      typeof window.nomeFiscalPorEmail === 'function') {
    const nome = await window.nomeFiscalPorEmail(fiscalEmail);
    if (nome) {
      const escala = await window.fiscalEscaladoNoDia(nome, dataISO);
      if (escala.status === 'escalado') {
        return 'fiscal escalado pela gerência para plantão fiscal no mesmo dia — escala de plantão do VISA (Anexo VII, item 9)';
      }
    }
  }
  return null;
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
// A aplicação da regra é controlada pelo flag app_config/visa_area_alimentacao
// (parametrizacao.html); desligado, esses CNAEs pontuam 48 fixo (alta padrão).
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

// ── Helpers de prazo (portados de VISA/os.html) ───────────
// Sentinela usada na base VISA para "prazo não informado" (30.03.1900).
const PRAZO_SEM_INFORMACAO = '1900-03-30';

// Hora "5:03:56 PM" → "17:03:56" (tramitacao.csv usa AM/PM). Cópia de os.html.
function converterHora12para24(horaStr) {
  if (!horaStr || String(horaStr).trim() === '') return '00:00:00';
  let s = String(horaStr).trim().toUpperCase();
  if (s.includes('.') && !s.includes(':')) s = s.replace(/\./g, ':');
  const mPeriodo = s.match(/\b(AM|PM)\b/);
  const periodo = mPeriodo ? mPeriodo[1] : null;
  s = s.replace(/\b(AM|PM)\b/g, '').trim().replace(/\s+/g, '');
  const partes = s.split(':').map(p => p.trim()).filter(Boolean);
  if (partes.length < 2) return '00:00:00';
  let h = parseInt(partes[0], 10);
  let m = parseInt(partes[1], 10);
  let sec = partes.length >= 3 ? parseInt(partes[2], 10) : 0;
  if ([h, m, sec].some(n => Number.isNaN(n))) return '00:00:00';
  if (periodo) {
    if (periodo === 'PM' && h !== 12) h += 12;
    if (periodo === 'AM' && h === 12) h = 0;
  }
  h = Math.min(Math.max(h, 0), 23);
  m = Math.min(Math.max(m, 0), 59);
  sec = Math.min(Math.max(sec, 0), 59);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

// Soma N dias úteis (pula sáb/dom) a uma data ISO. Cópia de os.html.
function adicionarDiasUteis(dataISO, diasUteis) {
  if (!dataISO) return '';
  const data = new Date(dataISO + 'T00:00:00');
  let add = 0;
  while (add < diasUteis) {
    data.setDate(data.getDate() + 1);
    const dow = data.getDay();
    if (dow !== 0 && dow !== 6) add++;
  }
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

// Protocolo: encontra a data de encaminhamento ao fiscal cuja janela de
// responsabilidade contém a data da inspeção (DT_VISITA). Ordena as
// tramitações cronologicamente; cada tramitação com DESTINO = fiscal abre uma
// janela que vai até a tramitação seguinte (quando o fiscal repassou para um
// órgão/outro). Retorna a data ISO de início dessa janela, ou null se nenhuma
// janela contiver a data. Espelha a lógica de buscarInfoProtocolo de os.html,
// mas seleciona a janela pela data do registro, não a última tramitação.
function encontrarDataEncaminhaProtocolo(numeroProtocolo, dataVisitaISO, tramitacaoPorProtocolo, fiscalMap) {
  if (!numeroProtocolo || !dataVisitaISO) return null;
  const trams = tramitacaoPorProtocolo.get(String(numeroProtocolo).trim());
  if (!trams || trams.length === 0) return null;

  // Ordena ascendente por data + hora (com ISO já pré-calculado em _dataISO).
  const ordenadas = [...trams].sort((a, b) => {
    if (a._dataISO !== b._dataISO) return a._dataISO < b._dataISO ? -1 : 1;
    const hA = converterHora12para24(a.HORA || '00:00:00');
    const hB = converterHora12para24(b.HORA || '00:00:00');
    return hA < hB ? -1 : (hA > hB ? 1 : 0);
  });

  for (let k = 0; k < ordenadas.length; k++) {
    const destino = String(ordenadas[k].DESTINO || '').trim();
    if (!destino || !fiscalMap.has(normNomeVisa(destino))) continue; // não é fiscal
    const inicio = ordenadas[k]._dataISO;
    if (!inicio) continue;
    const fim = (k + 1 < ordenadas.length) ? ordenadas[k + 1]._dataISO : null; // aberta se última
    if (dataVisitaISO >= inicio && (fim === null || dataVisitaISO <= fim)) {
      return inicio;
    }
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
    // ── Flag da pontuação por área (alimentação alta) ──
    // Parametrização (app_config/visa_area_alimentacao, parametrizacao.html):
    // quando desligado, os CNAEs de alta complexidade de alimentação pontuam
    // 48 fixo (Item 1), sem consultar a metragem do taxa.csv. Ligado por padrão.
    let regraAreaAlimentacaoAtiva = true;
    try {
      regraAreaAlimentacaoAtiva = (await window.db_getVisaAreaAlimentacaoConfig()).ativo;
    } catch (err) {
      onProgress('⚠️ Não foi possível ler a configuração da pontuação por área (alimentos) — regra mantida ativa.', 'warn');
      console.error('Failed to load visa_area_alimentacao config:', err);
    }
    if (!regraAreaAlimentacaoAtiva) {
      onProgress('ℹ️ Pontuação por área (alimentos alta complexidade) desativada na Parametrização — esses CNAEs pontuam 48 fixo.', 'info');
    }

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

    // ── Carregar CSVs de autorização do terceiro fiscal + prazo da OS ──
    const requerimentoMap = new Map(); // OS       → { prioridade: boolean, prazo: ISO|null }
    const oficioMap       = new Map(); // Oficio   → { terceiro: boolean, prazo: ISO|null }
    const denunciaMap     = new Map(); // Denuncia → { prazo: ISO|null }
    const tramitacaoPorProtocolo = new Map(); // PROTOCOLO → [ { DATA, HORA, DESTINO, _dataISO } ]

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
          requerimentoMap.set(osKey, {
            prioridade: prioridade === 'true' || prioridade === '1' || prioridade === 'sim',
            prazo: visaDataToISO(String(r['Prazo'] || '').replace(/"/g, '').trim()),
          });
        }
        onProgress(`📑 ${requerimentoMap.size} requerimento(s) carregado(s).`, 'info');
      }
    } catch (err) {
      onProgress('⚠️ Não foi possível carregar requerimento.csv — autorização de terceiro fiscal e prazo não verificados.', 'warn');
      console.error('Failed to load requerimento.csv:', err);
    }

    try {
      const ofiText = await window.fetchGitHubCSV('data/oficio.csv');
      if (ofiText !== null) {
        const ofiParsed = Papa.parse(ofiText, {
          header: true,
          skipEmptyLines: true,
          transformHeader: h => h.replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim(),
        });
        for (const r of ofiParsed.data) {
          const ofiKey = String(r['Oficio'] || '').replace(/"/g, '').trim();
          if (!ofiKey) continue;
          const terceiro = String(r['Terceiro'] || r['terceiro'] || '').replace(/"/g, '').trim().toLowerCase();
          oficioMap.set(ofiKey, {
            terceiro: terceiro === 'true' || terceiro === '1' || terceiro === 'sim',
            prazo: visaDataToISO(String(r['Prazo'] || '').replace(/"/g, '').trim()),
          });
        }
        onProgress(`📑 ${oficioMap.size} ofício(s) carregado(s).`, 'info');
      }
    } catch (err) {
      onProgress('⚠️ Não foi possível carregar oficio.csv — autorização de terceiro fiscal e prazo não verificados.', 'warn');
      console.error('Failed to load oficio.csv:', err);
    }

    // ── Prazo das denúncias (data/denuncia.csv, chave Denuncia) ──
    try {
      const denText = await window.fetchGitHubCSV('data/denuncia.csv');
      if (denText !== null) {
        const denParsed = Papa.parse(denText.replace(/^﻿/, ''), {
          header: true,
          delimiter: ';',
          skipEmptyLines: true,
          transformHeader: h => h.replace(/^﻿/, '').replace(/^"|"$/g, '').trim(),
        });
        for (const r of denParsed.data) {
          const denKey = String(r['Denuncia'] || '').replace(/"/g, '').trim();
          if (!denKey) continue;
          denunciaMap.set(denKey, {
            prazo: visaDataToISO(String(r['Prazo'] || '').replace(/"/g, '').trim()),
          });
        }
        onProgress(`📑 ${denunciaMap.size} denúncia(s) carregada(s).`, 'info');
      }
    } catch (err) {
      onProgress('⚠️ Não foi possível carregar denuncia.csv — prazo de denúncias não verificado.', 'warn');
      console.error('Failed to load denuncia.csv:', err);
    }

    // ── Tramitações dos protocolos (data/tramitacao.csv) ──
    // Usadas para achar a janela do fiscal que contém a data da inspeção e daí
    // o prazo do protocolo (encaminhamento ao fiscal + 15 dias úteis).
    try {
      const tramText = await window.fetchGitHubCSV('data/tramitacao.csv');
      if (tramText !== null) {
        const tramParsed = Papa.parse(tramText.replace(/^﻿/, ''), {
          header: true,
          delimiter: ';',
          skipEmptyLines: true,
          transformHeader: h => h.replace(/^﻿/, '').replace(/^"|"$/g, '').trim(),
        });
        for (const t of tramParsed.data) {
          const proto = String(t['PROTOCOLO'] || '').replace(/"/g, '').trim();
          if (!proto) continue;
          const rec = {
            DATA:    String(t['DATA'] || '').replace(/"/g, '').trim(),
            HORA:    String(t['HORA'] || '').replace(/"/g, '').trim(),
            DESTINO: String(t['DESTINO'] || '').replace(/"/g, '').trim(),
          };
          rec._dataISO = visaDataToISO(rec.DATA) || '';
          if (!tramitacaoPorProtocolo.has(proto)) tramitacaoPorProtocolo.set(proto, []);
          tramitacaoPorProtocolo.get(proto).push(rec);
        }
        onProgress(`📑 ${tramitacaoPorProtocolo.size} protocolo(s) com tramitação carregado(s).`, 'info');
      }
    } catch (err) {
      onProgress('⚠️ Não foi possível carregar tramitacao.csv — prazo de protocolos não verificado.', 'warn');
      console.error('Failed to load tramitacao.csv:', err);
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
          const ovr = window.complexidadeDecreto ? window.complexidadeDecreto(sub) : null;
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
      onProgress('⚠️ Não foi possível carregar cnae.csv — expansão por CNAEs extras desabilitada.', 'warn');
      console.error('Failed to load cnae.csv:', err);
    }

    // ── CNAEs extras por visita (data/inspecoes_cnae.csv) ────
    // Mapa VISITA_CTRL(controle da visita) → [CNAEs extras], dedup por CNAE.
    // O próprio fiscal informa no VISA os CNAEs adicionais de cada inspeção;
    // a coluna CONTROLE do arquivo é o id sequencial da linha (ignorada) e a
    // COMPLEXIDADE também é ignorada — a fonte única segue sendo o cnae.csv.
    const inspecoesCnaeMap = new Map();
    try {
      const icText = await window.fetchGitHubCSV('data/inspecoes_cnae.csv');
      if (icText !== null) {
        const icParsed = Papa.parse(icText, {
          header: true,
          delimiter: ';',
          skipEmptyLines: true,
          transformHeader: h => h.replace(/^﻿/, '').replace(/^"|"$/g, '').trim(),
        });
        for (const r of icParsed.data) {
          const visita = String(r['VISITA_CTRL'] || r['Visita_Ctrl'] || r['visita_ctrl'] || '').replace(/"/g, '').trim();
          const sub = String(r['SUBCLASSE'] || r['Subclasse'] || r['CNAE'] || r['Cnae'] || '').replace(/"/g, '').trim();
          if (!visita || !sub) continue;
          if (!inspecoesCnaeMap.has(visita)) inspecoesCnaeMap.set(visita, []);
          const list = inspecoesCnaeMap.get(visita);
          if (!list.includes(sub)) list.push(sub);
        }
        onProgress(`🏷️ ${inspecoesCnaeMap.size} visita(s) com CNAEs extras carregada(s).`, 'info');
      }
    } catch (err) {
      onProgress('⚠️ Não foi possível carregar inspecoes_cnae.csv — usando apenas o CNAE da inspeção.', 'warn');
      console.error('Failed to load inspecoes_cnae.csv:', err);
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
    // E-mail → nome cadastrado (coleção usuarios). Usado no match contra a
    // escala de plantão da gerência, que registra os fiscais por nome completo.
    const emailNomeMap = new Map();
    for (const f of (allFiscais || [])) {
      if ((f.email || f.id) && f.nome) emailNomeMap.set(f.email || f.id, f.nome);
    }

    const mesStr = String(mes).padStart(2, '0');
    const anoStr = String(ano);
    const rowsFiltradas = rows.filter(r => {
      const rawDt = String(r['DT_VISITA'] || '').replace(/"/g, '').trim();
      const dt = visaDataToISO(rawDt);
      return dt && dt.startsWith(`${anoStr}-${mesStr}-`);
    });

    // ── Processa primeiro as linhas de Relatório Técnico (alta) ──────────
    // Decreto item 13: REL alta × Vistoria não cumulativos no mesmo dia. REL só
    // existe via importação (nunca manual), então — ao contrário de Plantão/OPF,
    // que já estão gravados no banco antes da importação começar — a única forma
    // de garantir que `relAltaDatas` esteja populado antes de uma vistoria do
    // mesmo dia ser processada é ordenar as linhas do próprio CSV desta rodada.
    // Array.prototype.sort é estável, então a ordem relativa dentro de cada
    // grupo (REL-alta vs. demais) é preservada.
    function ehLinhaRelAlta(row) {
      const tipoRawRow = String(row['tipo'] || row['TIPO'] || row['Tipo'] || '').replace(/"/g, '').trim();
      if (normNomeVisa(tipoRawRow) !== 'RELATORIO TECNICO') return false;
      const subclasseRow = String(row['Atividade'] || '').replace(/"/g, '').trim();
      const subInfoRow = subclasseRow ? cnaeMap.get(subclasseRow) : null;
      const complexidadeRow = subInfoRow ? subInfoRow.complexidade : 'média';
      return String(complexidadeRow).trim().toLowerCase() === 'alta';
    }
    rowsFiltradas.sort((a, b) => Number(ehLinhaRelAlta(b)) - Number(ehLinhaRelAlta(a)));

    onProgress(`📋 ${rowsFiltradas.length} inspeção(ões) encontrada(s) para ${mesStr}/${anoStr}.`, 'info');

    let criados = 0, atualizados = 0, ignorados = 0, erros = 0;
    const processedKeys = new Set(); // "fiscalEmail::controleVisa::cnae"
    const pontosEstadoCache = new Map();

    // Heartbeat do lock: uma importação de todos os fiscais pode passar dos 3 min
    // do timeout de "stale". Renovamos o lock a cada ~60s para evitar que outra
    // sessão o considere abandonado e dispare uma importação duplicada.
    let _ultimoHeartbeat = Date.now();

    for (let idx = 0; idx < rowsFiltradas.length; idx++) {
      const row = rowsFiltradas[idx];
      if (onProgressBar) onProgressBar(idx + 1, rowsFiltradas.length);

      if (Date.now() - _ultimoHeartbeat > 60000) {
        _ultimoHeartbeat = Date.now();
        try { await window.db_refreshVisaImportLock(mes, ano); } catch (_) {}
      }

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

      // ── Prazo da OS e conformidade (cumprida fora do prazo) ──
      // Compara o prazo de execução da OS com a data do registro da inspeção
      // (DT_VISITA), não com a data atual. Requerimento/Ofício/Denúncia usam o
      // campo Prazo do CSV; Protocolo = encaminhamento ao fiscal + 15 dias úteis
      // (janela de tramitação que contém a data da inspeção).
      let prazoOsISO = '';
      if      (motivoOSNorm === 'REQUERIMENTO') prazoOsISO = (requerimentoMap.get(osNumero) || {}).prazo || '';
      else if (motivoOSNorm === 'DE OFICIO')    prazoOsISO = (oficioMap.get(osNumero) || {}).prazo || '';
      else if (motivoOSNorm === 'DENUNCIA')     prazoOsISO = (denunciaMap.get(osNumero) || {}).prazo || '';
      else if (motivoOSNorm === 'PROTOCOLO') {
        const encISO = encontrarDataEncaminhaProtocolo(osNumero, dataISO, tramitacaoPorProtocolo, fiscalMap);
        prazoOsISO = encISO ? adicionarDiasUteis(encISO, 15) : '';
      }
      if (prazoOsISO === PRAZO_SEM_INFORMACAO) prazoOsISO = ''; // sentinela "sem prazo"
      const foraDoPrazo = !!(prazoOsISO && dataISO && dataISO > prazoOsISO);
      const prazoOsFinal = prazoOsISO || null;

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
      // o CNAE informado na inspeção e os CNAEs extras que o fiscal informou
      // no VISA (inspecoes_cnae.csv, vinculado pelo controle da visita).
      // A soma dos pontos desses CNAEs não pode exceder
      // TETO_PONTOS_CNAE_VISA (48): seleciona por maior pontuação primeiro
      // (informado primeiro em empate) e NÃO lança os CNAEs que não couberem
      // no teto. Demais tipos seguem com 1 lançamento pelo CNAE da inspeção.
      const codigoRegulado = String(row['CODIGO'] || '').replace(/"/g, '').trim();
      const regInfo = reguladoMap.get(codigoRegulado) || { municipal: '', razao: '' };
      const entregaRaw = String(row['entrega'] || row['Entrega'] || row['ENTREGA'] || '').replace(/"/g, '').trim().toLowerCase();
      const entregaFalse = entregaRaw === 'false' || entregaRaw === '0' || entregaRaw === 'nao' || entregaRaw === 'não';
      const cnaesExtras = inspecoesCnaeMap.get(controleVisa) || [];
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
        // CNAEs extras informados pelo fiscal (inspecoes_cnae.csv), exceto o já informado
        for (const cnaeExtra of cnaesExtras) {
          if (cnaeExtra === subclasse) continue; // não duplica o informado
          const info = cnaeMap.get(cnaeExtra);
          if (!info) { // CNAE sem competência da vigilância → fora
            onProgress(`⚠️ CONTROLE ${controleVisa}: CNAE extra ${cnaeExtra} sem competência no cnae.csv — ignorado.`, 'warn');
            continue;
          }
          candidatos.push({
            cnae: cnaeExtra,
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
        // Aplicada somente com o flag da Parametrização ativo (regraAreaAlimentacaoAtiva);
        // desligado, esses CNAEs seguem com os 48 fixos de alta complexidade.
        if (regraAreaAlimentacaoAtiva && candidatos.some(c => ehAlimentacaoAlta(c.complexidade, c.equipe))) {
          const areaRegulado = await resolverAreaRegulado(codigoRegulado);
          for (const c of candidatos) {
            if (ehAlimentacaoAlta(c.complexidade, c.equipe)) {
              c.pontos = pontosPorAreaVisa(areaRegulado);
              c.visa_area = areaRegulado; // pode ser null (sem área) → exibe '—', pontos 48
              c.eh_alimentacao_alta = true; // marca para dispositivo_legal citar o Item 4 quando pontos=48
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
        // mantém a ordem do inspecoes_cnae.csv no restante).
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
                       complexidade_origem: c.complexidade_origem || null,
                       eh_alimentacao_alta: !!c.eh_alimentacao_alta });
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
            const estadoPontos = await _getEstadoPontosVisa(
              pontosEstadoCache, emailFiscal, mes, ano,
              emailNomeMap.get(emailFiscal) || nomeFiscalCsv);
            let pontosFiscal = pontosFinalA;
            let zeradoMotivo = null;
            // Item do Anexo VII que REJEITA a pontuação (citado em dispositivo_legal
            // no lugar do item produtivo quando pontosFiscal acaba em zero).
            let itemDecretoZerado = motivoOSNorm === 'PLANTAO FISCAL' && pontosBaseA > 0
              ? 9 // vistoria já contemplada no Plantão Fiscal (item 9), não pontua em separado
              : null;

            // ── Vistoria não cumulativa com Plantão/OPF manual ou REL alta ──
            // Se o fiscal tem, na mesma data, plantão manual (item 9), operação
            // fiscal manual (item 18) ou relatório técnico de inspeção de alta
            // complexidade importado (item 13), a vistoria entra com pontos zerados.
            if (tipoInfoA.tipo_codigo === 'VIS' && dataISO && pontosFiscal > 0) {
              if (estadoPontos.plantaoDatas.has(dataISO)) {
                pontosFiscal = 0;
                itemDecretoZerado = 9;
                zeradoMotivo = `Plantão fiscal manual em ${fmtData(dataISO)} — não cumulativo com vistoria (Anexo VII, item 9).`;
                onProgress(
                  `⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: vistoria zerada — ` +
                  `plantão fiscal manual em ${fmtData(dataISO)}.`,
                  'warn'
                );
              } else if (estadoPontos.escalaDatas.has(dataISO)) {
                // Mesmo sem PLT manual lançado, o fiscal está escalado pela
                // gerência para plantão nesta data (escala do VISA) — a
                // vistoria do dia não é cumulativa (Anexo VII, item 9),
                // forçando o cumprimento da escala.
                pontosFiscal = 0;
                itemDecretoZerado = 9;
                zeradoMotivo = `Fiscal escalado pela gerência para plantão fiscal em ${fmtData(dataISO)} (escala de plantão do VISA) — não cumulativo com vistoria (Anexo VII, item 9).`;
                onProgress(
                  `⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: vistoria zerada — ` +
                  `fiscal escalado pela gerência para plantão fiscal em ${fmtData(dataISO)} (escala VISA).`,
                  'warn'
                );
              } else if (estadoPontos.opfDatas.has(dataISO)) {
                pontosFiscal = 0;
                itemDecretoZerado = 18;
                zeradoMotivo = `Operação fiscal manual em ${fmtData(dataISO)} — não cumulativo com vistoria (Anexo VII, item 18).`;
                onProgress(
                  `⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: vistoria zerada — ` +
                  `operação fiscal (OPF) manual em ${fmtData(dataISO)}.`,
                  'warn'
                );
              } else if (estadoPontos.relAltaDatas.has(dataISO)) {
                pontosFiscal = 0;
                itemDecretoZerado = 13;
                zeradoMotivo = `Relatório técnico de inspeção (alta complexidade) em ${fmtData(dataISO)} — não cumulativo com vistoria (Anexo VII, item 13).`;
                onProgress(
                  `⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: vistoria zerada — ` +
                  `relatório técnico de inspeção (alta) em ${fmtData(dataISO)}.`,
                  'warn'
                );
              }
            } else if (tipoInfoA.tipo_codigo === 'REL' && tipoInfoA.item_pontuacao === 10 && dataISO) {
              // Marca a data já nesta rodada, para que vistorias do mesmo dia
              // processadas em seguida (graças à pré-ordenação de rowsFiltradas)
              // já enxerguem este relatório técnico de alta complexidade.
              estadoPontos.relAltaDatas.add(dataISO);
            }

            // Item 4 do Anexo VII (vistoria de alimentação de alta complexidade,
            // faixa ≥400m²/sem área — 48 pontos): sem isto, dispositivoLegal() não
            // consegue distinguir esse caso do Item 1 genérico (mesma pontuação).
            const itemDecretoAlimentacao =
              !itemDecretoZerado && tipoInfoA.tipo_codigo === 'VIS' && tipoInfoA.item_pontuacao === 1 &&
              alvo.eh_alimentacao_alta && pontosFiscal === 48
                ? 4
                : null;

            // ── Dia coberto por ocorrência aceita → importação ignorada ─
            // Alinhado com a regra de lançamento manual (lancamento.html /
            // meus-lancamentos.html): dias cobertos por ocorrência aceita não
            // admitem nenhum outro lançamento, sem exceção de pontuação.
            if (dataISO) {
              const dtParts = dataISO.split('-');
              const dtMes = Number(dtParts[1]);
              const dtAno = Number(dtParts[0]);
              const ocorrAceitas = await _getOcorrenciasAceitasVisa(emailFiscal, dtMes, dtAno);
              if (_dataCobertaOcorrVisa(dataISO, ocorrAceitas)) {
                ignorados++;
                onProgress(
                  `⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: dia ${dataISO} coberto por ` +
                  `ocorrência aceita. Importação ignorada.`,
                  'warn'
                );
                continue;
              }
            }

            if (existing) {
              if (existing.status === 'aceito' || existing.status === 'fechado') {
                ignorados++;
                onProgress(`⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: já homologado, ignorado.`, 'warn');
                continue;
              }
              const _duplaReducaoVis = alvo.qtd_fiscais != null;
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
                zerado_motivo: zeradoMotivo,
                motivo_os: motivoOS,
                os_numero: osNumero,
                prazo_os: prazoOsFinal,
                fora_do_prazo: foraDoPrazo,
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
                dispositivo_legal: window.dispositivoLegal
                  ? window.dispositivoLegal(tipoInfoA.item_pontuacao, pontosFiscal, _duplaReducaoVis, itemDecretoZerado || itemDecretoAlimentacao || undefined)
                  : null,
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
              _aplicarManualNoMapaPontosVisa(estadoPontos.byDia, existing, -1);
              const manualAtualizado = { ...existing, ...updateData, id: existing.id };
              _aplicarManualNoMapaPontosVisa(estadoPontos.byDia, manualAtualizado, 1);
              estadoPontos.docsById.set(existing.id, manualAtualizado);
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
              const _duplaReducaoVisCreate = alvo.qtd_fiscais != null;
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
                zerado_motivo: zeradoMotivo,
                motivo_os: motivoOS,
                os_numero: osNumero,
                prazo_os: prazoOsFinal,
                fora_do_prazo: foraDoPrazo,
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
                dispositivo_legal: window.dispositivoLegal
                  ? window.dispositivoLegal(tipoInfoA.item_pontuacao, pontosFiscal, _duplaReducaoVisCreate, itemDecretoZerado || itemDecretoAlimentacao || undefined)
                  : null,
              }, null, true, alvo.cnae);
              _aplicarManualNoMapaPontosVisa(estadoPontos.byDia, {
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
window.datasComPlantaoManual    = datasComPlantaoManual;
window.vistoriasImportadasNoDia = vistoriasImportadasNoDia;
window.datasComOpfManual        = datasComOpfManual;
window.vistoriasNoDia           = vistoriasNoDia;
window.ehRelAltaImportada          = ehRelAltaImportada;
window.datasComRelAltaImportada    = datasComRelAltaImportada;
window.ehAtividadeDiaInteiroManual = ehAtividadeDiaInteiroManual;
window.atividadesDiaInteiroNoDia   = atividadesDiaInteiroNoDia;
window.motivoNaoCumulatividadeVistoria = motivoNaoCumulatividadeVistoria;
