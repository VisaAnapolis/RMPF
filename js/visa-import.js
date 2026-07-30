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

// ── Reconciliação com a origem (WCVS) ────────────────────
// O inspecoes.csv é a fonte da verdade permanente do mês aberto: se uma inspeção
// muda no WCVS depois de homologada, o lançamento é sobrescrito e REABERTO (volta
// a 'enviado') para nova homologação. Para isso é preciso saber se mudou algo que
// de fato importa — daí a comparação campo a campo sobre os campos que definem
// identidade e pontuação. Campos cosméticos (razão social, descrição, dispositivo
// legal, participantes) ficam de fora: mudança neles não justifica desfazer o
// trabalho de conferência do administrador.
const VISA_CAMPOS_ORIGEM = [
  'data', 'tipo_codigo', 'item_pontuacao', 'complexidade', 'visa_cnae',
  'cnae_origem', 'pontos', 'visa_area', 'qtd_fiscais', 'documento',
  'codigo', 'motivo_os', 'os_numero',
];

// Rótulos legíveis para o modal — o nome cru do campo não diz nada ao fiscal.
const VISA_CAMPOS_ORIGEM_LABEL = {
  data: 'Data', tipo_codigo: 'Tipo', item_pontuacao: 'Item do Anexo VII',
  complexidade: 'Complexidade', visa_cnae: 'CNAE', cnae_origem: 'Origem do CNAE',
  pontos: 'Pontos', visa_area: 'Área (m²)', qtd_fiscais: 'Qtd. de fiscais',
  documento: 'Documento', codigo: 'Regulado (código)', motivo_os: 'Origem da demanda',
  os_numero: 'Nº da OS',
};

// null, undefined e '' são o mesmo "vazio"; 48 e '48' são o mesmo valor. Sem
// isso, docs antigos (gravados quando um campo ainda não existia) apareceriam
// como alterados e seriam reabertos sem que nada tivesse mudado na origem.
function _normValorOrigem(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const s = String(v).trim();
  if (s === '') return '';
  if (!isNaN(Number(s))) return String(Number(s));
  return s;
}

function visaCanonicoOrigem(doc) {
  const out = {};
  for (const c of VISA_CAMPOS_ORIGEM) out[c] = _normValorOrigem(doc ? doc[c] : null);
  return out;
}

// [] = nada mudou (homologação preservada). Cada entrada traz o rótulo e os
// valores de/para, que alimentam direto a tabela do modal de reabertura.
//
// Campo AUSENTE no doc gravado (chave inexistente, não null) é ignorado: são
// campos que ainda não existiam no esquema quando aquele lançamento foi salvo
// — evolução do RMPF, não alteração no WCVS. Sem isso, a primeira rodada
// reabriria em massa homologações antigas legítimas. Campo gravado como null
// continua valendo como comparação normal.
function visaDiffOrigem(existing, novo) {
  const a = visaCanonicoOrigem(existing);
  const b = visaCanonicoOrigem(novo);
  const diff = [];
  for (const c of VISA_CAMPOS_ORIGEM) {
    if (existing && !Object.prototype.hasOwnProperty.call(existing, c)) continue;
    if (a[c] !== b[c]) {
      diff.push({ campo: c, label: VISA_CAMPOS_ORIGEM_LABEL[c] || c, de: a[c], para: b[c] });
    }
  }
  return diff;
}

// ── Campos informativos (sincronizados sem reabrir) ──────
// Não afetam pontuação nem identidade, então uma diferença aqui NÃO justifica
// desfazer a homologação — mas o valor precisa refletir a origem, senão a tela
// mostra dado velho para sempre: quando um homologado não tem diferença nos
// campos canônicos, o laço nem grava (é o `continue` mais abaixo), e um campo
// que passou a existir depois daquela homologação nunca chegaria ao documento.
const VISA_CAMPOS_INFORMATIVOS = ['fiscais_participantes', 'numero'];

// Compara só os informativos. Diferente de visaDiffOrigem em dois pontos:
// trata array (fiscais_participantes) e considera chave AUSENTE como diferença
// — é exatamente o caso a preencher nos lançamentos antigos.
function _normValorInformativo(v) {
  if (Array.isArray(v)) return v.map(x => String(x == null ? '' : x).trim()).join('|');
  return _normValorOrigem(v);
}

function visaDiffInformativo(existing, novo, campos) {
  const lista = campos || VISA_CAMPOS_INFORMATIVOS;
  const diff = [];
  for (const c of lista) {
    if (_normValorInformativo(existing ? existing[c] : null) !==
        _normValorInformativo(novo ? novo[c] : null)) {
      diff.push(c);
    }
  }
  return diff;
}

// Patch com SOMENTE os campos informativos, montado do zero. Nunca derivar de
// updateData: um spread acidental levaria status/pontos para um lançamento
// homologado, quebrando a garantia de que sincronizar não altera pontuação.
function visaPatchInformativo(novo, campos) {
  const patch = {};
  for (const c of (campos || VISA_CAMPOS_INFORMATIVOS)) {
    patch[c] = (novo && novo[c] !== undefined) ? novo[c] : null;
  }
  return patch;
}

// Distingue "o WCVS mudou" de "outro lançamento tornou este não cumulativo":
// quando só os pontos mudaram E o motivo de zeragem mudou junto, a inspeção em si
// continua idêntica — quem mexeu no resultado foi um lançamento do mesmo dia.
function visaClassificaDiff(diff, existing, zeradoMotivoNovo) {
  const soPontos = diff.length === 1 && diff[0].campo === 'pontos';
  const zeradoMudou =
    _normValorOrigem(existing && existing.zerado_motivo) !== _normValorOrigem(zeradoMotivoNovo);
  return (soPontos && zeradoMudou) ? 'incompatibilidade' : 'origem';
}

// Textos das reaberturas (exibidos ao fiscal e ao administrador no modal).
function _motivoReaberturaOrigem(controle, diff) {
  return 'A inspeção CONTROLE ' + controle + ' foi alterada no WCVS depois de ter sido homologada. ' +
    'Campo(s) alterado(s): ' + diff.map(d => d.label).join(', ') + '. ' +
    'O lançamento foi atualizado com o dado atual da origem e devolvido à conferência para nova homologação.';
}

function _motivoReaberturaIncompat(controle, zeradoMotivo) {
  return 'A pontuação da inspeção CONTROLE ' + controle + ' mudou porque outro lançamento do mesmo dia ' +
    'a tornou não cumulativa' + (zeradoMotivo ? ' — ' + zeradoMotivo : '') + '. ' +
    'Como esse lançamento (no WCVS ou manual) foi feito DEPOIS da homologação, o registro voltou à conferência.';
}

function _motivoReaberturaOrfao(controle) {
  return 'A inspeção CONTROLE ' + controle + ' foi alterada no WCVS depois de ter sido homologada e não ' +
    'pertence mais a esta competência — normalmente porque a data do documento foi alterada para outro mês. ' +
    'A pontuação foi zerada e o lançamento devolvido à conferência. ' +
    'Se a alteração não estava correta, basta ajustar a data no WCVS que ele volta na próxima importação.';
}

// CNAE reclassificado ≠ data alterada na origem: o CONTROLE continua no CSV, só sob
// outro CNAE. A mensagem é ACIONÁVEL de propósito — o fiscal não precisa saber
// da mecânica interna, precisa saber que a atividade só volta a pontuar se ele
// marcá-la como inspecionada no WCVS (quando ela realmente foi).
function _motivoCnaeReclassificado(controle, cnaeAntigo, cnaesAtuais, documento, numero) {
  const lista = (cnaesAtuais || []).filter(Boolean).join(', ');
  const doc = String(documento || '').trim();
  const num = (numero == null) ? '' : String(numero).trim();
  // "o documento X" em vez de "o X": os tipos variam em gênero (o termo, a
  // certidão, a manifestação) e concordar com cada um exigiria uma tabela.
  const refDoc = doc
    ? ('o documento ' + doc + (num ? ' nº ' + num : '') + ' (inspeção ' + controle + ')')
    : ('a inspeção CONTROLE ' + controle);
  return 'Este lançamento é da atividade (CNAE) ' + (cnaeAntigo || '—') + ', que não está ' +
    'selecionada como atividade inspecionada' + (lista ? ' — no WCVS a inspeção está como ' + lista : '') +
    '. Por isso ele está sem pontuação. ' +
    'Se a atividade ' + (cnaeAntigo || '—') + ' TAMBÉM foi inspecionada nesta ocasião, abra no WCVS ' +
    refDoc + ' e, em "Marque as demais atividades inspecionadas nesta visita", selecione essa ' +
    'atividade e grave: na próxima importação ela volta a pontuar automaticamente. ' +
    'Se ela não foi inspecionada, não é preciso fazer nada.';
}

function _motivoReaberturaConflito(descricaoConflito) {
  return 'Este lançamento ficou incompatível com outro do mesmo dia: ' + descricaoConflito + '. ' +
    'O conflito surgiu DEPOIS da homologação — por isso os dois lançamentos envolvidos voltaram à ' +
    'conferência para o administrador decidir qual prevalece.';
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

function ehAltaComplexidade(complexidade) {
  return complexToItem(complexidade).item === 1;
}

function ehAlimentacaoAlta(complexidade, equipe) {
  if (!ehAltaComplexidade(complexidade)) return false; // s\u00f3 alta
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

// ── Autorização de inspeção com mais de dois fiscais ─────
// Toda inspeção com mais de dois fiscais exige autorização prévia. A regra
// recai sobre o Fiscal3 e todo fiscal adicional (4º+) vindo do
// inspecoes_fiscais.csv (isTerceiro=true). Retorna true somente quando
// explicitamente autorizado:
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

// ── Revalidação cruzada do mês ───────────────────────────
// Reconciliar linha a linha com o CSV não basta: a incompatibilidade entre dois
// lançamentos nasce da COMBINAÇÃO deles no mesmo dia, e o segundo pode ter sido
// criado (no WCVS ou manualmente) depois que o primeiro já estava homologado.
// Este passe varre o mês inteiro e reabre o que estiver em estado inconsistente.
//
// Só age sobre VIOLAÇÃO REAL visível nos dados — não sobre "houve conflito algum
// dia". Se a vistoria já está zerada pela regra, o estado é consistente e a
// homologação continua de pé; nada é reaberto à toa.
const _STATUS_REVALIDA = ['aceito', 'homologado', 'enviado', 'pendente'];

function _ehHomologado(m) {
  return m && (m.status === 'aceito' || m.status === 'homologado');
}

// Já sinalizado e aguardando decisão do administrador: não mexer de novo.
function _jaSinalizado(m) {
  return !!(m && m.reaberto_tipo && m.status === 'enviado');
}

async function revalidarCruzadoMes({ mes, ano, fiscalEmail, escrever, anota, onProgress, marcarReabertura }) {
  let reabertos_incompat = 0, zerados_incompat = 0;

  const docs = fiscalEmail
    ? await window.db_getManuais(fiscalEmail, mes, ano)
    : await window.db_getManuaisTodos(mes, ano);

  const porFiscal = new Map();
  for (const d of docs) {
    if (!d.fiscal_email || !d.data) continue;
    if (!_STATUS_REVALIDA.includes(d.status)) continue;   // fechado/recusado/rascunho fora
    if (!porFiscal.has(d.fiscal_email)) porFiscal.set(d.fiscal_email, []);
    porFiscal.get(d.fiscal_email).push(d);
  }

  // Reabre um lançamento (ou apenas zera, quando nunca foi homologado).
  const reabrir = async (m, motivo, patchExtra) => {
    if (_jaSinalizado(m)) return false;
    const patch = Object.assign({}, patchExtra || {});
    if (_ehHomologado(m)) {
      patch.status = 'enviado';
      patch.pontos_homologado = null;
      patch.reaberto_tipo = 'incompatibilidade';
      patch.reaberto_motivo = motivo;
      patch.reaberto_diff = null;
      patch.reaberto_em = new Date().toISOString();
      patch.reaberto_pontos_homologado_anterior =
        (m.pontos_homologado === undefined ? null : m.pontos_homologado);
      reabertos_incompat++;
      marcarReabertura(m.fiscal_email);
      anota('reabrir_incompat', {
        controle: m.visa_controle || m.controle, fiscal: m.fiscal_email,
        cnae: m.visa_cnae, data: m.data, status_atual: m.status, motivo,
      });
    } else {
      // Nunca homologado: corrige a pontuação em silêncio, sem marcar reabertura.
      if (!Object.keys(patch).length) return false;
      zerados_incompat++;
      anota('zerar', {
        controle: m.visa_controle || m.controle, fiscal: m.fiscal_email,
        cnae: m.visa_cnae, data: m.data, status_atual: m.status, motivo,
      });
    }
    await escrever.update(m.id, patch);
    Object.assign(m, patch);   // evita reavaliar o mesmo doc no laço seguinte
    return true;
  };

  const zerarVistoria = (m, itemDecreto, causa) => ({
    pontos: 0,
    zerado_motivo: causa,
    dispositivo_legal: window.dispositivoLegal
      ? window.dispositivoLegal(m.item_pontuacao, 0, false, itemDecreto)
      : (m.dispositivo_legal || null),
  });

  for (const [email, lista] of porFiscal.entries()) {
    const nome = (lista.find(d => d.fiscal_nome) || {}).fiscal_nome || null;
    let escalaDatas = new Set();
    try {
      if (typeof window.datasEscaladoNoMes === 'function' && nome) {
        escalaDatas = await window.datasEscaladoNoMes(nome, mes, ano);
      }
    } catch (_) { escalaDatas = new Set(); }

    let ocorrAceitas = [];
    try { ocorrAceitas = await _getOcorrenciasAceitasVisa(email, mes, ano); } catch (_) {}

    const porDia = new Map();
    for (const d of lista) {
      if (!porDia.has(d.data)) porDia.set(d.data, []);
      porDia.get(d.data).push(d);
    }

    for (const [dia, doDia] of porDia.entries()) {
      try {
        // ── C: dia coberto por afastamento aceito ──
        if (_dataCobertaOcorrVisa(dia, ocorrAceitas)) {
          for (const m of doDia) {
            if (m.origem === 'ocorrencia' || !_ehHomologado(m)) continue;
            await reabrir(m, _motivoReaberturaConflito(
              'o dia ' + dia + ' passou a ser coberto por um afastamento aceito (ocorrência), ' +
              'que não admite outros lançamentos'), {});
          }
          continue;   // dia resolvido; as demais regras não se aplicam
        }

        const plt      = doDia.filter(ehPlantaoManual);
        const opf      = doDia.filter(ehOpfManual);
        const relAlta  = doDia.filter(ehRelAltaImportada);
        const diaInt   = doDia.filter(ehAtividadeDiaInteiroManual);
        const vistorias = doDia.filter(ehVistoriaQualquer);
        const escalado = escalaDatas.has(dia);

        // ── A: vistoria pontuando num dia que deveria zerá-la ──
        let itemDecreto = null, causa = null, culpado = null;
        if (plt.length)          { itemDecreto = 9;  culpado = plt[0];
          causa = 'plantão fiscal manual no mesmo dia (Anexo VII, item 9)'; }
        else if (escalado)       { itemDecreto = 9;
          causa = 'fiscal escalado pela gerência para plantão fiscal no mesmo dia — escala de plantão do VISA (Anexo VII, item 9)'; }
        else if (opf.length)     { itemDecreto = 18; culpado = opf[0];
          causa = 'operação fiscal manual no mesmo dia (Anexo VII, item 18)'; }
        else if (relAlta.length) { itemDecreto = 13; culpado = relAlta[0];
          causa = 'relatório técnico de inspeção (alta complexidade) no mesmo dia (Anexo VII, item 13)'; }

        if (causa) {
          const pontuando = vistorias.filter(v => (Number(v.pontos) || 0) > 0);
          for (const v of pontuando) {
            await reabrir(v, _motivoReaberturaConflito(
              'a vistoria deixou de ser cumulativa por ' + causa), zerarVistoria(v, itemDecreto, causa));
          }
          // Decisão do gestor: reabrir os DOIS lados, para o administrador
          // escolher qual prevalece — a vistoria do WCVS ou o lançamento manual.
          if (pontuando.length && culpado && _ehHomologado(culpado)) {
            await reabrir(culpado, _motivoReaberturaConflito(
              'passou a existir vistoria do WCVS no mesmo dia (CONTROLE ' +
              (pontuando[0].visa_controle || '—') + '), não cumulativa com este lançamento'), {});
          }
        }

        // ── B: 48×48 — dois lançamentos manuais de dia inteiro pontuando ──
        const dInteiroPontuando = diaInt.filter(m => (Number(m.pontos) || 0) > 0);
        if (dInteiroPontuando.length > 1) {
          for (const m of dInteiroPontuando) {
            if (!_ehHomologado(m)) continue;
            const outro = dInteiroPontuando.find(x => x.id !== m.id);
            await reabrir(m, _motivoReaberturaConflito(
              'há outra atividade de dia inteiro (48 pontos) lançada no mesmo dia — ' +
              ((outro && outro.tipo_nome) || 'plantão/operação/serviços técnicos') +
              ' —, e elas não são cumulativas entre si (Decreto 49.723/2023, Anexo VII)'), {});
          }
        }
      } catch (e) {
        onProgress('⚠️ Revalidação do dia ' + dia + ': ' + e.message, 'warn');
      }
    }
  }

  return { reabertos_incompat, zerados_incompat };
}

async function importarInspecoesVISA({ fiscalEmail, fiscalNome, mes, ano, allFiscais, onProgress, onProgressBar, simulacao }) {
  mes = Number(mes); ano = Number(ano);
  simulacao = !!simulacao;

  if (!visaMesAberto(mes, ano)) {
    onProgress('⚠️ Mês anterior a Abril/2026 — impossível importar.', 'warn');
    return { criados: 0, atualizados: 0, ignorados: 0, erros: 0 };
  }

  // ── Modo simulação (auditoria de divergências) ───────────
  // Toda gravação passa por `escrever.*`; em simulação elas viram no-ops que só
  // registram a intenção em `relatorio`. É o que permite auditar o que a
  // reconciliação FARIA sem tocar em nada — mesma lógica, um caminho só.
  // Regra a manter: nenhuma chamada direta a db_upsertVISAManual/db_updateManual/
  // db_deleteManual dentro desta função — sempre via `escrever`.
  // O cache de ocorrências vive no módulo e a página do admin fica aberta por
  // horas (auto-import a cada 10 min): sem limpar no início de cada rodada, um
  // afastamento aceito nesse intervalo continuaria invisível pelo resto da
  // sessão — e agora essa informação decide reabertura de lançamento homologado.
  _visaOcorrCache.clear();

  const relatorio = [];
  const anota = (acao, dados) => relatorio.push({ acao, ...dados });
  const escrever = simulacao
    ? {
        upsert: async () => {},
        update: async () => {},
        remover: async () => {},
      }
    : {
        upsert: (...a) => window.db_upsertVISAManual(...a),
        update: (...a) => window.db_updateManual(...a),
        remover: (...a) => window.db_deleteManual(...a),
      };

  // Simulação é 100% leitura: não disputa o lock com uma importação real.
  if (!simulacao) {
    // Acquire distributed lock — throws if another import is already running for this month
    await window.db_acquireVisaImportLock(mes, ano, fiscalEmail, fiscalNome || fiscalEmail);
  }

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
    // Salvaguarda da reconciliação: sem cnae.csv/inspecoes_cnae.csv os alvos e a
    // pontuação saem errados — TODA inspeção viraria órfã e homologações
    // legítimas seriam reabertas/zeradas em massa por uma simples falha de rede.
    // Quando qualquer dessas fontes falta, a rodada segue importando, mas não
    // reabre nem zera nada de homologado.
    let fontesIncompletas = false;

    const cnaeMap = new Map();
    try {
      const cnaeText = await window.fetchGitHubCSV('data/cnae.csv');
      if (cnaeText === null) fontesIncompletas = true;
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
      fontesIncompletas = true;
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
      if (icText === null) fontesIncompletas = true;
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
      fontesIncompletas = true;
      onProgress('⚠️ Não foi possível carregar inspecoes_cnae.csv — usando apenas o CNAE da inspeção.', 'warn');
      console.error('Failed to load inspecoes_cnae.csv:', err);
    }

    // ── Fiscais adicionais por visita (data/inspecoes_fiscais.csv) ───
    // Mapa VISITA_CTRL (controle da visita) → [nomes de fiscais extras], dedup
    // por nome normalizado. Quando uma inspeção tem mais de 3 fiscais, o 4º em
    // diante vem neste arquivo (as três primeiras colunas Fiscal1/2/3 seguem no
    // inspecoes.csv). Cada fiscal daqui é tratado como terceiro fiscal
    // (isTerceiro=true), igual ao Fiscal3 — mesma regra de autorização. As
    // colunas CONTROLE (id sequencial da linha), ORDEM, CODIGO e auditoria são
    // ignoradas; o vínculo é por VISITA_CTRL, como no inspecoes_cnae.csv.
    //
    // A falha deste arquivo conta como fonte incompleta: sem os extras, a
    // contagem de fiscais cai (ex.: 6 → 3) e `qtd_fiscais` É campo canônico —
    // uma indisponibilidade momentânea reabriria homologados em massa. Também
    // marca `fiscaisIncompletos`, que suspende a sincronização da lista de
    // participantes para não substituir dado bom por lista truncada.
    const inspecoesFiscaisMap = new Map();
    let fiscaisIncompletos = false;
    try {
      const ifText = await window.fetchGitHubCSV('data/inspecoes_fiscais.csv');
      if (ifText === null) fiscaisIncompletos = true;
      if (ifText !== null) {
        const ifParsed = Papa.parse(ifText, {
          header: true,
          delimiter: ';',
          skipEmptyLines: true,
          transformHeader: h => h.replace(/^﻿/, '').replace(/^"|"$/g, '').trim(),
        });
        for (const r of ifParsed.data) {
          const visita = String(r['VISITA_CTRL'] || r['Visita_Ctrl'] || r['visita_ctrl'] || '').replace(/"/g, '').trim();
          const nomeFisc = String(r['FISCAL'] || r['Fiscal'] || r['fiscal'] || '').replace(/"/g, '').trim();
          if (!visita || !nomeFisc) continue;
          if (!inspecoesFiscaisMap.has(visita)) inspecoesFiscaisMap.set(visita, []);
          const list = inspecoesFiscaisMap.get(visita);
          const norm = normNomeVisa(nomeFisc);
          if (!list.some(n => normNomeVisa(n) === norm)) list.push(nomeFisc);
        }
        onProgress(`👥 ${inspecoesFiscaisMap.size} visita(s) com fiscais adicionais carregada(s).`, 'info');
      }
    } catch (err) {
      fiscaisIncompletos = true;
      onProgress('⚠️ Não foi possível carregar inspecoes_fiscais.csv — usando apenas os fiscais do inspecoes.csv.', 'warn');
      console.error('Failed to load inspecoes_fiscais.csv:', err);
    }
    if (fiscaisIncompletos) {
      fontesIncompletas = true;
      onProgress('⚠️ Sem inspecoes_fiscais.csv nesta rodada: nenhuma homologação será reaberta (a contagem de fiscais ficaria errada).', 'warn');
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
    let reabertos = 0, reabertos_orfaos = 0, reabertos_incompat = 0;
    // homologados que receberam só campos informativos (sem reabrir)
    let sincronizados = 0;
    // fiscal → nº de reaberturas nesta rodada (1 push agregado por fiscal ao final)
    const reabertosPorFiscal = new Map();
    const marcarReabertura = (email) => {
      if (!email) return;
      reabertosPorFiscal.set(email, (reabertosPorFiscal.get(email) || 0) + 1);
    };
    const processedKeys = new Set(); // "fiscalEmail::controleVisa::cnae"
    // "fiscalEmail::controleVisa" → Set de CNAEs processados nesta rodada. Uma
    // correção de RT no WCVS (CNAE reclassificado) faz o CONTROLE continuar
    // existindo no CSV sob outro CNAE — sem isso, o loop de órfãos trataria a
    // versão antiga como "data alterada na origem", quando na verdade já existe um
    // lançamento atualizado da MESMA inspeção sob o CNAE novo.
    const processedControleFiscal = new Map();
    const marcarProcessadoControleFiscal = (email, controle, cnae) => {
      const k = email + '::' + controle;
      if (!processedControleFiscal.has(k)) processedControleFiscal.set(k, new Set());
      processedControleFiscal.get(k).add(cnae || '');
    };
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

      // Número impresso do documento lavrado (coluna NUMERO do inspecoes.csv).
      // Reinicia por talão, então não é único e não serve como chave — é só
      // informação para o fiscal localizar o papel. '000000' e vazio querem
      // dizer "documento sem número" (dicionário de campos do WCVS).
      const numeroRaw = String(row['NUMERO'] || row['Numero'] || '').replace(/"/g, '').trim();
      const numero = (!numeroRaw || /^0+$/.test(numeroRaw)) ? null : numeroRaw;

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

      // Fiscais adicionais (4º+), vindos do inspecoes_fiscais.csv vinculado por
      // VISITA_CTRL (= controle da inspeção). Cada um entra como terceiro fiscal
      // (isTerceiro=true), igual ao Fiscal3. Dedup por nome normalizado contra os
      // já presentes (Fiscal1/2/3) e entre os próprios extras.
      const fiscaisExtras = inspecoesFiscaisMap.get(controleVisa) || [];
      const nomesPresentes = new Set(fiscaisCsv.map(f => normNomeVisa(f.nome)));
      for (const nomeExtra of fiscaisExtras) {
        const norm = normNomeVisa(nomeExtra);
        if (!norm || nomesPresentes.has(norm)) continue;
        nomesPresentes.add(norm);
        fiscaisCsv.push({ nome: nomeExtra, isTerceiro: true });
      }

      // Lista de participantes gravada no lançamento (coluna "Fiscais" clicável
      // na UI). Só relevante com 2+ fiscais; single-fiscal grava null (fallback
      // legado por qtd_fiscais nas telas).
      const nomesParticipantes = fiscaisCsv.map(f => f.nome);

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
        // fiscaisCsv.length = participantes físicos (Fiscal1/2/3 + adicionais do
        // inspecoes_fiscais.csv), incluindo os não autorizados; como dupla, trio
        // e 4+ reduzem igual, isso só muda o nº exibido, não os pontos.
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
        // Ordena por complexidade ALTA primeiro, depois por pontos desc; em
        // empate, informado primeiro (sort estável mantém a ordem do
        // inspecoes_cnae.csv no restante).
        //
        // Por que alta antes de pontos: a alta de alimentação ajustada por área
        // vale 8 ou 16 pontos e, na ordenação puramente por pontuação, ficava
        // ABAIXO de CNAEs de média (12/9). Com CNAEs de menor complexidade
        // suficientes para fechar os 48 (ex.: 4× média de 12), o CNAE de alta
        // era empurrado para fora do teto e simplesmente não era lançado. A alta
        // é a que caracteriza a inspeção: quando ela não consome os 48 sozinha,
        // entra primeiro e o restante do teto é preenchido pelos demais CNAEs,
        // somando enquanto não exceder 48.
        candidatos.sort((a, b) =>
          (Number(ehAltaComplexidade(b.complexidade)) - Number(ehAltaComplexidade(a.complexidade))) ||
          (b.pontos - a.pontos) ||
          (Number(b.informado) - Number(a.informado)));
        // Seleção gulosa respeitando o teto de pontos da inspeção (usa os pontos
        // já ajustados pela área). Não interrompe no primeiro que não couber:
        // segue tentando os seguintes, para aproveitar o teto ao máximo.
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
            marcarProcessadoControleFiscal(emailFiscal, controleVisa, legacy.visa_cnae);
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
          marcarProcessadoControleFiscal(emailFiscal, controleVisa, alvo.cnae);

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
              // Mês fechado é intocável: nem comparado, nem sinalizado.
              if (existing.status === 'fechado') {
                ignorados++;
                onProgress(`⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: competência fechada, ignorado.`, 'warn');
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
                numero,
                origem: 'visa_csv',
                visa_controle: controleVisa,
                visa_cnae: alvo.cnae,
                cnae_origem: alvo.cnae_origem,
                codigo: codigoRegulado,
                razao: regInfo.razao || '',
                municipal: regInfo.municipal || '',
                visa_area: alvo.visa_area ?? null,
                qtd_fiscais: alvo.qtd_fiscais ?? null,
                fiscais_participantes: fiscaisCsv.length >= 2 ? nomesParticipantes : null,
                dispositivo_legal: window.dispositivoLegal
                  ? window.dispositivoLegal(tipoInfoA.item_pontuacao, pontosFiscal, _duplaReducaoVis, itemDecretoZerado || itemDecretoAlimentacao || undefined)
                  : null,
              };
              // ── Homologado: só sobrescreve se a origem realmente mudou ──
              // Sem diff, a homologação do administrador fica intacta (e sem
              // gravação). Com diff, o dado do WCVS prevalece e o lançamento
              // volta à conferência — é o que fecha o furo de alterações feitas
              // no transacional depois da homologação.
              const _homologado = existing.status === 'aceito' || existing.status === 'homologado';
              if (_homologado) {
                const _diff = visaDiffOrigem(existing, updateData);
                if (!_diff.length) {
                  // Nada que justifique reabrir. Ainda assim os campos
                  // informativos precisam refletir a origem: sem isso, um campo
                  // criado depois desta homologação (a lista de participantes, o
                  // número do documento) nunca chegaria ao lançamento, porque
                  // este é o único caminho que ele percorre. Grava só esses
                  // campos — status, pontos e a homologação ficam intactos.
                  const _camposInf = fiscaisIncompletos
                    ? VISA_CAMPOS_INFORMATIVOS.filter(c => c !== 'fiscais_participantes')
                    : VISA_CAMPOS_INFORMATIVOS;
                  const _diffInf = visaDiffInformativo(existing, updateData, _camposInf);
                  if (_diffInf.length) {
                    await escrever.update(existing.id, visaPatchInformativo(updateData, _diffInf));
                    sincronizados++;
                    anota('sincronizar', {
                      controle: controleVisa, fiscal: emailFiscal, cnae: alvo.cnae,
                      data: dataISO, status_atual: existing.status,
                      motivo: 'Campos informativos desatualizados: ' + _diffInf.join(', ') +
                              ' (homologação e pontuação preservadas)',
                    });
                  } else {
                    ignorados++;
                  }
                  continue;
                }
                if (fontesIncompletas) {
                  ignorados++;
                  onProgress(
                    `⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: divergência detectada, mas ` +
                    `os CSVs de apoio falharam nesta rodada. Homologação mantida por segurança.`, 'warn');
                  continue;
                }
                const _tipoReab = visaClassificaDiff(_diff, existing, zeradoMotivo);
                updateData.status = 'enviado';
                updateData.pontos_homologado = null;
                updateData.reaberto_tipo = _tipoReab;
                updateData.reaberto_diff = _diff;
                updateData.reaberto_em = new Date().toISOString();
                updateData.reaberto_pontos_homologado_anterior =
                  (existing.pontos_homologado === undefined ? null : existing.pontos_homologado);
                updateData.reaberto_motivo = _tipoReab === 'incompatibilidade'
                  ? _motivoReaberturaIncompat(controleVisa, zeradoMotivo)
                  : _motivoReaberturaOrigem(controleVisa, _diff);
                if (_tipoReab === 'incompatibilidade') reabertos_incompat++; else reabertos++;
                marcarReabertura(emailFiscal);
                anota('reabrir', {
                  controle: controleVisa, fiscal: emailFiscal, cnae: alvo.cnae, data: dataISO,
                  status_atual: existing.status, tipo: _tipoReab, diff: _diff,
                });
                onProgress(
                  `🔄 CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: alterado na origem depois de ` +
                  `homologado (${_diff.map(d => d.label).join(', ')}) — reaberto para nova conferência.`, 'warn');
              } else if (existing.reaberto_tipo) {
                // Reaparecendo no CSV / voltando a bater: some a marca de reabertura.
                updateData.reaberto_tipo = null;
                updateData.reaberto_motivo = null;
                updateData.reaberto_diff = null;
                updateData.reaberto_em = null;
                updateData.reaberto_pontos_homologado_anterior = null;
              }

              if (existing.status === 'recusado') {
                updateData.status = 'enviado';
                updateData.motivo_recusa = null;
                onProgress(`🔄 CONTROLE ${controleVisa}: recusado anteriormente, resubmetido para conferência.`, 'info');
              }
              // Verificação de autorização (inspeção com mais de dois fiscais) na atualização
              if (isTerceiro) {
                const autorizado = isTerceiroFiscalAutorizado(os, oficio, requerimentoMap, oficioMap);
                if (!autorizado) {
                  updateData.status = 'pendente';
                  updateData.motivo_pendencia = 'Inspeção com mais de dois fiscais sem autorização prévia (OS/Ofício não consta como autorizado)';
                  onProgress(`⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: inspeção com mais de dois fiscais sem autorização prévia, marcado como pendente.`, 'warn');
                } else if (existing.status === 'pendente') {
                  updateData.status = 'enviado';
                  updateData.motivo_pendencia = null;
                  onProgress(`✅ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: autorização de fiscais confirmada, restaurado para enviado.`, 'info');
                }
              } else if (existing.status === 'pendente') {
                // Fiscal1 e Fiscal2 nunca dependem de autorização. Se o
                // lançamento ficou pendente numa versão anterior do CSV (era
                // terceiro fiscal e deixou de ser, ou a ordem dos fiscais
                // mudou no WCVS), nada o tirava desse estado: o update parcial
                // do Firestore só toca os campos enviados, e sem passar por
                // aqui `status` e `motivo_pendencia` ficavam presos para
                // sempre — inclusive com o texto de uma versão antiga.
                updateData.status = 'enviado';
                updateData.motivo_pendencia = null;
                onProgress(`✅ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: não é mais terceiro fiscal, pendência removida.`, 'info');
              }
              await escrever.upsert(controleVisa, emailFiscal, updateData, existing.id, false, alvo.cnae);
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
              // Determinar status inicial considerando autorização de mais de dois fiscais
              let statusInicial = 'enviado';
              let motivoPendencia = null;
              if (isTerceiro && !isTerceiroFiscalAutorizado(os, oficio, requerimentoMap, oficioMap)) {
                statusInicial = 'pendente';
                motivoPendencia = 'Inspeção com mais de dois fiscais sem autorização prévia (OS/Ofício não consta como autorizado)';
                onProgress(`⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: inspeção com mais de dois fiscais sem autorização prévia, marcado como pendente.`, 'warn');
              }
              const _duplaReducaoVisCreate = alvo.qtd_fiscais != null;
              anota('criar', {
                controle: controleVisa, fiscal: emailFiscal, cnae: alvo.cnae, data: dataISO,
                status_atual: null,
              });
              await escrever.upsert(controleVisa, emailFiscal, {
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
                numero,
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
                fiscais_participantes: fiscaisCsv.length >= 2 ? nomesParticipantes : null,
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
        if (m.status === 'fechado') continue;              // mês fechado: intocável
        // Órfão já sinalizado numa rodada anterior: preservar SEM regravar. Sem
        // este desvio ele voltaria a 'enviado' e a rodada seguinte o apagaria.
        if (m.reaberto_tipo === 'orfao' || m.reaberto_tipo === 'cnae_reclassificado') continue;
        const key = (m.fiscal_email || '') + '::' + (m.visa_controle || '') + '::' + (m.visa_cnae || '');
        if (processedKeys.has(key)) continue;

        // A inspeção saiu da competência, ou só trocou de CNAE? Se o mesmo
        // CONTROLE apareceu nesta rodada sob outro CNAE, o RT foi reclassificado
        // no WCVS: existe um lançamento novo e correto da mesma inspeção. Dizer
        // ao fiscal que a data foi alterada, nesse caso, seria mentira.
        const cnaesAtuais = processedControleFiscal.get((m.fiscal_email || '') + '::' + (m.visa_controle || ''));
        const reclassificado = !!(cnaesAtuais && cnaesAtuais.size);

        const homologado = m.status === 'aceito' || m.status === 'homologado';
        if (homologado) {
          // Homologado que saiu da competência na origem NÃO é apagado em silêncio:
          // fica visível, zerado, aguardando decisão do administrador.
          if (fontesIncompletas) {
            onProgress(
              `⚠️ CONTROLE ${m.visa_controle} — ausente do CSV, mas os arquivos de apoio falharam ` +
              `nesta rodada. Homologação mantida por segurança.`, 'warn');
            continue;
          }
          await escrever.update(m.id, {
            pontos: 0,
            status: 'enviado',
            pontos_homologado: null,
            reaberto_tipo: reclassificado ? 'cnae_reclassificado' : 'orfao',
            reaberto_motivo: reclassificado
              ? _motivoCnaeReclassificado(m.visa_controle, m.visa_cnae, Array.from(cnaesAtuais),
                                          m.documento, m.numero)
              : _motivoReaberturaOrfao(m.visa_controle),
            reaberto_diff: null,
            reaberto_em: new Date().toISOString(),
            reaberto_pontos_homologado_anterior:
              (m.pontos_homologado === undefined ? null : m.pontos_homologado),
          });
          reabertos_orfaos++;
          marcarReabertura(m.fiscal_email);
          anota(reclassificado ? 'reabrir_cnae_reclassificado' : 'reabrir_orfao', {
            controle: m.visa_controle, fiscal: m.fiscal_email, cnae: m.visa_cnae,
            data: m.data, status_atual: m.status,
          });
          onProgress(
            reclassificado
              ? `🔄 CONTROLE ${m.visa_controle} — CNAE ${m.visa_cnae} reclassificado no WCVS: versão ` +
                `antiga zerada (o lançamento atual da inspeção segue valendo).`
              : `🔄 CONTROLE ${m.visa_controle} — homologado, mas alterado no WCVS depois disso (data do ` +
                `documento fora desta competência): pontuação zerada e devolvido à conferência.`, 'warn');
        } else {
          await escrever.remover(m.id);
          excluidos++;
          anota('excluir', {
            controle: m.visa_controle, fiscal: m.fiscal_email, cnae: m.visa_cnae,
            data: m.data, status_atual: m.status,
          });
          onProgress(`🗑️ CONTROLE ${m.visa_controle} — não encontrado no CSV, lançamento excluído.`, 'info');
        }
      }
    } catch(e) {
      onProgress('⚠️ Erro ao verificar lançamentos órfãos: ' + e.message, 'warn');
    }

    // ── Revalidação cruzada do mês ──
    // Roda depois da reconciliação porque depende do estado final do dia (uma
    // vistoria recém-criada pode tornar não cumulativo um manual homologado há
    // semanas). Falha aqui não derruba a importação já concluída.
    let zerados_incompat = 0;
    if (!fontesIncompletas) {
      try {
        if (!simulacao && typeof window.db_refreshVisaImportLock === 'function') {
          await window.db_refreshVisaImportLock(mes, ano);
        }
        onProgress('🔁 Revalidando incompatibilidades do mês...', 'info');
        const rev = await revalidarCruzadoMes({
          mes, ano, fiscalEmail, escrever, anota, onProgress, marcarReabertura,
        });
        reabertos_incompat += rev.reabertos_incompat;
        zerados_incompat = rev.zerados_incompat;
      } catch (e) {
        onProgress('⚠️ Erro na revalidação cruzada: ' + e.message, 'warn');
      }
    } else {
      onProgress('⚠️ Revalidação cruzada pulada: os CSVs de apoio falharam nesta rodada.', 'warn');
    }

    const totalReabertos = reabertos + reabertos_orfaos + reabertos_incompat;

    // Um push por fiscal, agregando todas as reaberturas da rodada (a queda de
    // pontuação no painel dele é imediata; sem aviso, viraria chamado).
    if (!simulacao && reabertosPorFiscal.size &&
        typeof window.dispararNotificacaoFiscal === 'function') {
      for (const [email, qtd] of reabertosPorFiscal.entries()) {
        try {
          window.dispararNotificacaoFiscal(
            email,
            '🔄 Lançamento reaberto',
            `${qtd} lançamento(s) de ${String(mes).padStart(2, '0')}/${ano} voltaram para conferência ` +
            `por alteração na origem ou incompatibilidade. Abra Meus Lançamentos para ver o motivo.`
          );
        } catch (_) { /* notificação nunca derruba a importação */ }
      }
    }

    onProgress(
      `✅ ${simulacao ? 'Simulação concluída' : 'Importação concluída'}: ` +
      `<strong>${criados}</strong> criado(s), ` +
      `<strong>${atualizados}</strong> atualizado(s), ` +
      `<strong>${ignorados}</strong> ignorado(s), ` +
      `<strong>${excluidos}</strong> excluído(s), ` +
      `<strong>${totalReabertos}</strong> reaberto(s), ` +
      `<strong>${sincronizados}</strong> sincronizado(s), ` +
      `<strong>${erros}</strong> erro(s).`,
      erros > 0 ? 'warn' : 'ok'
    );
    if (sincronizados) {
      onProgress(
        `🔗 ${sincronizados} homologado(s) atualizado(s) só nos dados informativos ` +
        `(fiscais participantes / nº do documento) — pontuação e homologação preservadas.`, 'info');
    }
    if (totalReabertos) {
      onProgress(
        `🔄 Reaberturas: ${reabertos} por alteração na origem, ${reabertos_orfaos} por data alterada na ` +
        `origem, ${reabertos_incompat} por incompatibilidade.`, 'warn');
    }

    return {
      criados, atualizados, ignorados, excluidos, erros,
      reabertos, reabertos_orfaos, reabertos_incompat, zerados_incompat,
      sincronizados,
      relatorio,
    };
  } finally {
    if (!simulacao) await window.db_releaseVisaImportLock(mes, ano);
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
window.visaCanonicoOrigem          = visaCanonicoOrigem;
window.visaDiffOrigem              = visaDiffOrigem;
window.visaClassificaDiff          = visaClassificaDiff;
window.visaDiffInformativo         = visaDiffInformativo;
window.visaPatchInformativo        = visaPatchInformativo;
window.revalidarCruzadoMes         = revalidarCruzadoMes;
