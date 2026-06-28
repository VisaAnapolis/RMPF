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

const _TIPO_OCR_TO_DISPOSITIVO = {
  ferias:           'Art. 11, inciso I, da Lei Complementar nº 548/2023',
  licenca_medica:   'Art. 11, inciso V, da Lei Complementar nº 548/2023',
  licenca_gestante: 'Art. 11, inciso VII, da Lei Complementar nº 548/2023',
  cargo_comissao:   'Art. 11, inciso X, da Lei Complementar nº 548/2023',
  afastamento_legal:'Art. 11 da Lei Complementar nº 548/2023',
  outros:           'Art. 11 da Lei Complementar nº 548/2023',
};

function dispositivoLegalOcorrencia(tipo) {
  return _TIPO_OCR_TO_DISPOSITIVO[tipo] || 'Art. 11 da Lei Complementar nº 548/2023';
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
