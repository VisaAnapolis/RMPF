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
];

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
    enviado:  ['badge-enviado',  'Enviado'],
    rascunho: ['badge-rascunho', 'Rascunho'],
    recusado: ['badge-recusado', 'Recusado'],
    fechado:  ['badge-fechado',  'Fechado'],
    pendente: ['badge-pendente', 'Pendente'],
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
