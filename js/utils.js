// js/utils.js

const TABELA_PONTUACAO = [
  { item: 1,  complexidade: "Alta",  pontos: 48, descricao: "Vistoria ou atendimento a denúncia por estabelecimento" },
  { item: 2,  complexidade: "Média", pontos: 12, descricao: "Vistoria ou atendimento a denúncia por estabelecimento" },
  { item: 3,  complexidade: "Baixa", pontos: 6,  descricao: "Vistoria ou atendimento a denúncia por estabelecimento" },
  { item: 4,  complexidade: "Alta",  pontos: 24, descricao: "Análise de projeto arquitetônico por estabelecimento" },
  { item: 5,  complexidade: "Média", pontos: 12, descricao: "Análise de projeto arquitetônico por estabelecimento" },
  { item: 6,  complexidade: "—",     pontos: 48, descricao: "Plantão fiscal (não cumulativo com pontuação de vistorias realizadas)" },
  { item: 7,  complexidade: "—",     pontos: 12, descricao: "Coleta de amostra para análise em laboratório oficial por coleta" },
  { item: 8,  complexidade: "—",     pontos: 12, descricao: "Manifestação do servidor atuante por peça" },
  { item: 9,  complexidade: "—",     pontos: 24, descricao: "Participação, preparação e/ou apresentação de cursos, palestras, encontros e eventos similares" },
  { item: 10, complexidade: "Alta",  pontos: 48, descricao: "Elaboração de relatório técnico de inspeção por estabelecimento (não cumulativo com vistoria)" },
  { item: 11, complexidade: "Média", pontos: 12, descricao: "Elaboração de relatório técnico de inspeção por estabelecimento" },
  { item: 12, complexidade: "Baixa", pontos: 6,  descricao: "Elaboração de relatório técnico de inspeção por estabelecimento" },
  { item: 13, complexidade: "Alta",  pontos: 48, descricao: "Elaboração de relatório técnico harmonizado conforme diretrizes SNVS" },
  { item: 14, complexidade: "—",     pontos: 48, descricao: "Serviços técnicos no âmbito da VISA, requisitados pela chefia por dia de serviço" },
  { item: 15, complexidade: "—",     pontos: 48, descricao: "Operações fiscais não previstas e/ou situações extraordinárias" },
  { item: 16, complexidade: "—",     pontos: 2,  descricao: "Certidão" },
];

// ── Exceções de complexidade do Decreto 49.723/2023 (ANEXO VII, item C) ──
// A complexidade segue a LC 377/2018 (refletida no cnae.csv do VISA), SALVO
// estes CNAEs, reclassificados expressamente pelo decreto:
//   C.1 → média complexidade | C.2 → baixa complexidade
// A chave é o CNAE só com dígitos (ex.: "4639-7/02" → "4639702").
const EXCECOES_COMPLEXIDADE_DECRETO = {
  '4639702': 'Média',  // C.1
  '3831901': 'Média',  // C.1
  '3831999': 'Média',  // C.1
  '3832700': 'Média',  // C.1
  '3839499': 'Média',  // C.1
  '8630503': 'Baixa',  // C.2
};

// Retorna a complexidade imposta pelo decreto para o CNAE, ou null quando não há
// exceção (mantém-se então a classificação da fonte — cnae.csv/Firestore).
function complexidadeDecreto(cnae) {
  const norm = String(cnae || '').replace(/\D/g, '');
  return EXCECOES_COMPLEXIDADE_DECRETO[norm] || null;
}

const TIPOS_ATIVIDADE = [
  { id: 1,  codigo: "VIS", nome: "Vistoria ou atendimento a denúncia",               itensPontuacao: [1, 2, 3],    somenteCsv: true  },
  { id: 2,  codigo: "ARQ", nome: "Análise de projeto arquitetônico",                  itensPontuacao: [4, 5],       somenteCsv: true  },
  { id: 3,  codigo: "PLT", nome: "Plantão fiscal",                                    itensPontuacao: [6]          },
  { id: 4,  codigo: "COL", nome: "Coleta de amostra para laboratório",                itensPontuacao: [7],          somenteCsv: true  },
  { id: 5,  codigo: "MAN", nome: "Manifestação do servidor atuante",                  itensPontuacao: [8],          somenteCsv: true  },
  { id: 6,  codigo: "CUR", nome: "Curso, palestra, evento ou encontro VISA",          itensPontuacao: [9]          },
  { id: 7,  codigo: "REL", nome: "Elaboração de relatório técnico de inspeção",       itensPontuacao: [10, 11, 12], somenteCsv: true  },
  { id: 8,  codigo: "RLH", nome: "Relatório técnico harmonizado (SNVS)",              itensPontuacao: [13],         somenteCsv: true  },
  { id: 9,  codigo: "SRV", nome: "Serviços técnicos requisitados pela chefia",        itensPontuacao: [14]         },
  { id: 10, codigo: "OPF", nome: "Operações fiscais não previstas / extraordinárias", itensPontuacao: [15]         },
  { id: 11, codigo: "CER", nome: "Certidão",                                          itensPontuacao: [16],         somenteCsv: true  },
];

const MESES = [
  "Janeiro","Fevereiro","Março","Abril","Maio","Junho",
  "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"
];

function fmtData(d) {
  if (!d) return '—';
  if (typeof d === 'string' && d.includes('-')) {
    const [y, m, day] = d.split('-');
    return `${day}/${m}/${y}`;
  }
  if (d && d.toDate) d = d.toDate();
  if (d instanceof Date) {
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    return `${dd}/${mm}/${d.getFullYear()}`;
  }
  return String(d);
}

function nomeCurto(nome) {
  if (!nome) return '—';
  const parts = nome.trim().split(/\s+/);
  if (parts.length <= 2) return nome;
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

function badge(type) {
  const map = {
    aceito:   ['badge-aceito',   'Aceito'],
    homologado: ['badge-aceito', 'Homologado'],
    enviado:  ['badge-enviado',  'Enviado'],
    rascunho: ['badge-rascunho', 'Rascunho'],
    recusado: ['badge-recusado', 'Recusado'],
    fechado:  ['badge-fechado',  'Fechado'],
    pendente:        ['badge-pendente',        'Pendente'],
    'pendente-fiscal': ['badge-pendente-fiscal', 'Pendente'],
    cvs:      ['badge-cvs',      'CVS'],
    manual:   ['badge-manual',   'Manual'],
  };
  const [cls, label] = map[type] || ['badge-rascunho', type];
  return `<span class="badge ${cls}">${label}</span>`;
}

function alerta(type, content) {
  const icons = { warn: '⚠️', info: 'ℹ️', danger: '🚨', ok: '✅' };
  const icon = icons[type] || 'ℹ️';
  return `<div class="alert alert-${type}"><span class="alert-icon">${icon}</span><div>${content}</div></div>`;
}

function mesAnoLabel(mes, ano) {
  return `${MESES[mes - 1]} / ${ano}`;
}

/** Escape a string for safe HTML insertion */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Normaliza a complexidade armazenada (que pode vir como "alta"/"ALTA"/"Média"/…)
// para exibição padronizada. Retorna '—' quando não se aplica.
function formatComplexidade(c) {
  const n = String(c || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (n === 'alta')  return 'Alta';
  if (n === 'media') return 'Média';
  if (n === 'baixa') return 'Baixa';
  return '—';
}

// Célula HTML da coluna "Complexidade". Quando o lançamento foi reclassificado
// pelo Decreto 49.723/2023 (campo complexidade_decreto), acrescenta o ícone ⚖️
// com tooltip mostrando "origem → atual".
function complexidadeHtml(m) {
  const c = formatComplexidade(m && m.complexidade);
  if (c === '—') return '—';
  if (m && m.complexidade_decreto && m.complexidade_origem) {
    const orig = formatComplexidade(m.complexidade_origem);
    return `${c} <span class="cx-decreto" style="cursor:help" ` +
      `title="Complexidade reclassificada pelo Decreto 49.723/2023 (item C): ${orig} → ${c}">⚖️</span>`;
  }
  return c;
}

// ── Dispositivo legal que embasa cada item de pontuação ──
// Chave: item_pontuacao interno; valor: número do item no ANEXO VII do Decreto 49.723/2023.
const _ITEM_PONTUACAO_TO_DECRETO = {
  1: 1,  2: 2,  3: 3,        // VIS por complexidade
  4: 7,  5: 8,               // ARQ por complexidade
  6: 9,                      // PLT
  7: 10,                     // COL
  8: 11,                     // MAN
  9: 12,                     // CUR
  10: 13, 11: 14, 12: 15,    // REL por complexidade
  13: 16,                    // RLH
  14: 17,                    // SRV
  15: 18,                    // OPF
  16: 19,                    // CER
};

// Retorna o texto do dispositivo legal que embasa a pontuação do lançamento.
// pontos: necessário para detectar os itens 5/6 (alimentação por área: 16 e 8 pts).
// duplaReducao: true quando o item E.2 foi aplicado (média/baixa em dupla fiscal).
function dispositivoLegal(itemPontuacao, pontos, duplaReducao) {
  if (itemPontuacao === 1 && pontos === 8)  return 'Item 6 do Anexo VII do Decreto 49.723/2023';
  if (itemPontuacao === 1 && pontos === 16) return 'Item 5 do Anexo VII do Decreto 49.723/2023';
  const decretoItem = _ITEM_PONTUACAO_TO_DECRETO[itemPontuacao];
  if (!decretoItem) return null;
  let texto = `Item ${decretoItem} do Anexo VII do Decreto 49.723/2023`;
  if (duplaReducao) texto += ' combinado com Item E.2 do Anexo VII do Decreto 49.723/2023';
  return texto;
}

// ── Tipos de ocorrência = hipóteses do Art. 11 da LC 548/2023 ──
// Fonte única: alimenta o dropdown de ocorrencias.html (só os `manual:true`, na
// ordem dos incisos), o label de exibição e o dispositivo_legal (inciso exato).
//   - Inciso I (Férias) é sincronizado automaticamente do VISA → fora do dropdown
//     manual, mas mantido aqui para renderizar/embasar as ocorrências criadas.
//   - `afastamento_legal`/`outros` (caput) são LEGADOS: mantidos só para exibir/
//     embasar ocorrências antigas; NÃO aparecem no dropdown (sem a opção "outros").
const TIPOS_OCORRENCIA = [
  { tipo: 'ferias',            inciso: 'inciso I',    label: 'Férias',                                       manual: false },
  { tipo: 'casamento',         inciso: 'inciso II',   label: 'Casamento',                                    manual: true  },
  { tipo: 'luto',              inciso: 'inciso III',  label: 'Luto por falecimento de familiar',             manual: true  },
  { tipo: 'juri',              inciso: 'inciso IV',   label: 'Convocação para o Tribunal do Júri',           manual: true  },
  { tipo: 'licenca_medica',    inciso: 'inciso V',    label: 'Licença para tratamento da própria saúde',     manual: true  },
  { tipo: 'licenca_familia',   inciso: 'inciso VI',   label: 'Licença por doença em pessoa da família',      manual: true  },
  { tipo: 'licenca_gestante',  inciso: 'inciso VII',  label: 'Licença gestante / maternidade',               manual: true  },
  { tipo: 'paternidade',       inciso: 'inciso VIII', label: 'Nascimento de filho(a) — licença-paternidade', manual: true  },
  { tipo: 'adocao',            inciso: 'inciso IX',   label: 'Adoção de criança',                            manual: true  },
  { tipo: 'cargo_comissao',    inciso: 'inciso X',    label: 'Exercício de cargo em comissão',               manual: true  },
  // Legado (fora do dropdown; só exibição/embasamento de registros antigos):
  { tipo: 'afastamento_legal', inciso: 'caput',       label: 'Outros afastamentos funcionais imperativos',   manual: false },
  { tipo: 'outros',            inciso: 'caput',       label: 'Outros afastamentos funcionais imperativos',   manual: false },
];

const _TIPO_OCR_LABELS = {};
const _TIPO_OCR_TO_DISPOSITIVO = {};
TIPOS_OCORRENCIA.forEach(t => {
  _TIPO_OCR_LABELS[t.tipo] = t.label;
  _TIPO_OCR_TO_DISPOSITIVO[t.tipo] = `Art. 11, ${t.inciso}, da Lei Complementar nº 548/2023`;
});

function labelOcorrencia(tipo) {
  return _TIPO_OCR_LABELS[tipo] || tipo;
}

function dispositivoLegalOcorrencia(tipo) {
  return _TIPO_OCR_TO_DISPOSITIVO[tipo] || 'Art. 11 da Lei Complementar nº 548/2023';
}

// ─────────────────────────────────────────────────────────────
// Rateio de pontos de ocorrência por dia útil (evita ultrapassar
// o teto mensal de 1000 pontos quando o período cobre um mês inteiro)
// ─────────────────────────────────────────────────────────────
const FERIADOS_NACIONAIS_FIXOS_MMDD = ['01-01','04-21','05-01','09-07','10-12','11-02','11-15','12-25'];
const MEDIA_PRODUTIVIDADE_OCORRENCIA = 1000; // placeholder até existir média real do fiscal

async function carregarFeriadosMunicipais() {
  try {
    const resp = await fetch('data/feriados.csv');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const texto = await resp.text();
    const linhas = texto.trim().split('\n').slice(1);
    return new Set(linhas.map(l => l.split(',')[0].trim()).filter(Boolean));
  } catch (e) {
    console.warn('Não foi possível carregar data/feriados.csv — feriados municipais não serão excluídos do rateio:', e);
    return new Set();
  }
}

function ehDiaUtil(dataISO, feriadosSet) {
  const d = new Date(dataISO + 'T12:00:00');
  if (d.getDay() === 0 || d.getDay() === 6) return false;
  if (FERIADOS_NACIONAIS_FIXOS_MMDD.includes(dataISO.slice(5))) return false;
  return !feriadosSet.has(dataISO);
}

function diasUteisNoMes(mes, ano, feriadosSet) {
  const diasNoMes = new Date(ano, mes, 0).getDate();
  let count = 0;
  for (let dia = 1; dia <= diasNoMes; dia++) {
    const iso = `${ano}-${String(mes).padStart(2,'0')}-${String(dia).padStart(2,'0')}`;
    if (ehDiaUtil(iso, feriadosSet)) count++;
  }
  return count;
}

// ─────────────────────────────────────────────────────────────
// Períodos de ocorrência (compartilhado entre o lançamento manual
// de ocorrencias.html e a sincronização automática de férias)
// ─────────────────────────────────────────────────────────────

/**
 * Retorna objeto agrupado por "mes-ano" com os dias (ISO) da ocorrência.
 * Lida corretamente com ocorrências que cruzam a virada do mês.
 */
function diasDaOcorrenciaPorMes(dataInicio, dataFim) {
  const fim = dataFim || dataInicio;
  const result = {};
  const cur = new Date(dataInicio + 'T12:00:00');
  const end = new Date(fim + 'T12:00:00');
  while (cur <= end) {
    const iso = cur.toISOString().split('T')[0];
    const mes = cur.getMonth() + 1;
    const ano = cur.getFullYear();
    const key = `${mes}-${ano}`;
    if (!result[key]) result[key] = { mes, ano, dias: [] };
    result[key].dias.push(iso);
    cur.setDate(cur.getDate() + 1);
  }
  return result;
}

/**
 * Verifica se dois períodos [aIni..aFim] e [bIni..bFim] se sobrepõem.
 * Datas em ISO (YYYY-MM-DD); quando não há fim, considera-se o próprio início.
 */
function periodosSeSobrepoem(aIni, aFim, bIni, bFim) {
  const a1 = aIni, a2 = aFim || aIni;
  const b1 = bIni, b2 = bFim || bIni;
  return a1 <= b2 && b1 <= a2;
}

// Arredonda para 2 casas decimais, eliminando o ruído de ponto flutuante que
// aparece ao somar valores como 45.45 várias vezes (ex.: "636.3000000000001").
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Formata um total de pontos para exibição, livre de ruído de ponto flutuante. */
function formatPontos(n) {
  return String(round2(n));
}

/** Normaliza um nome para casamento tolerante (trim, minúsculas, sem acentos). */
function normalizarNome(nome) {
  return String(nome || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

// Expose globals
window.TABELA_PONTUACAO = TABELA_PONTUACAO;
window.TIPOS_ATIVIDADE  = TIPOS_ATIVIDADE;
window.MESES            = MESES;
window.fmtData          = fmtData;
window.nomeCurto        = nomeCurto;
window.badge            = badge;
window.alerta           = alerta;
window.mesAnoLabel      = mesAnoLabel;
window.escHtml          = escHtml;
window.complexidadeDecreto = complexidadeDecreto;
window.formatComplexidade  = formatComplexidade;
window.complexidadeHtml    = complexidadeHtml;
window.dispositivoLegal         = dispositivoLegal;
window.dispositivoLegalOcorrencia = dispositivoLegalOcorrencia;
window.TIPOS_OCORRENCIA         = TIPOS_OCORRENCIA;
window.labelOcorrencia          = labelOcorrencia;
window.round2               = round2;
window.formatPontos         = formatPontos;
window.carregarFeriadosMunicipais = carregarFeriadosMunicipais;
window.ehDiaUtil                = ehDiaUtil;
window.diasUteisNoMes           = diasUteisNoMes;
window.MEDIA_PRODUTIVIDADE_OCORRENCIA = MEDIA_PRODUTIVIDADE_OCORRENCIA;
window.diasDaOcorrenciaPorMes   = diasDaOcorrenciaPorMes;
window.periodosSeSobrepoem      = periodosSeSobrepoem;
window.normalizarNome           = normalizarNome;
