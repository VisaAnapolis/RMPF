// js/utils.js

// ── Link cross-app para o VISA no sidebar ────────────────────────────────
// Aponta sempre para a hospedagem oficial do VISA (garrado.github.io/VISA),
// independentemente de onde o RMPF está sendo servido. O index.html do VISA
// redireciona usuário já autenticado direto para o dashboard de lá.
// Só o Android em modo PWA recebe target="_blank": lá a navegação é entregue
// ao sistema, que abre o PWA do VISA se instalado (o WebAPK captura as URLs
// do próprio escopo). O iOS não tem roteamento URL→PWA — o _blank alternava
// para o Safari; sem target, a página do VISA abre no painel interno do
// próprio app, mantendo o usuário no contexto. No navegador (qualquer
// plataforma), navegação normal na mesma guia.
function visaAppSidebarLink() {
  const url = 'https://garrado.github.io/VISA/index.html';
  let pwa = false;
  try {
    pwa = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
          window.navigator.standalone === true ||
          document.referrer.indexOf('android-app://') === 0;
  } catch (e) {}
  const android = /android/i.test(navigator.userAgent || '');
  const alvo = (pwa && android) ? ' target="_blank" rel="noopener"' : '';
  return `<a href="${url}"${alvo} class="sidebar-link sidebar-link--app-externo"><span class="icon">🏥</span>APP VISA</a>`;
}

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
    reaberto: ['badge-reaberto', 'Reaberto'],
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

// Retorna o texto do dispositivo legal que embasa (ou rejeita) a pontuação do lançamento.
// pontos: necessário para detectar os itens 5/6 (alimentação por área: 16 e 8 pts) e para
// distinguir pontuação zerada (sem base legal a corroborar, salvo rejeição conhecida).
// duplaReducao: true quando o item E.2 foi aplicado (média/baixa em dupla fiscal).
// itemDecretoOverride: item do Anexo VII já resolvido pelo chamador, usado em dois casos:
//   (a) pontos === 0 por não cumulatividade — cita o item que REJEITA (ex.: 9, 13, 18),
//       já que o item produtivo (itemPontuacao) não corrobora pontuação nenhuma aqui;
//   (b) pontos === 48 numa vistoria de alimentação de alta complexidade (item 4), caso
//       ambíguo com o item 1 genérico que os valores 8/16 (itens 6/5) não cobrem.
function dispositivoLegal(itemPontuacao, pontos, duplaReducao, itemDecretoOverride) {
  if (pontos === 0) {
    return itemDecretoOverride
      ? `Item ${itemDecretoOverride} do Anexo VII do Decreto 49.723/2023 (não cumulativo — pontuação zerada)`
      : null;
  }
  if (itemDecretoOverride) {
    let textoOverride = `Item ${itemDecretoOverride} do Anexo VII do Decreto 49.723/2023`;
    if (duplaReducao) textoOverride += ' combinado com Item E.2 do Anexo VII do Decreto 49.723/2023';
    return textoOverride;
  }
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

// ── Feriados móveis (derivados da Páscoa) ──
// Carnaval, Sexta-feira Santa e Corpus Christi mudam de data todo ano e
// `data/feriados.csv` só lista o ano corrente. Derivá-los da Páscoa mantém o
// cálculo de dia útil correto em qualquer ano, mesmo antes de o CSV ser
// atualizado. Algoritmo de Meeus/Butcher (calendário gregoriano), em UTC para
// não depender do fuso do navegador.
function _domingoDePascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

function _isoUTC(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function _somaDiasUTC(d, dias) {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + dias);
  return r;
}

// Dia seguinte a uma data ISO (aritmética em UTC, imune a horário de verão).
function _proximoDiaISO(dataISO) {
  return _isoUTC(_somaDiasUTC(new Date(dataISO + 'T00:00:00Z'), 1));
}

const _feriadosMoveisCache = new Map();

// Carnaval (segunda e terça), Sexta-feira Santa e Corpus Christi do ano.
// Carnaval e Corpus Christi são ponto facultativo — tratados como não úteis,
// igual ao que o `data/feriados.csv` já faz.
function feriadosMoveisNacionais(ano) {
  if (!_feriadosMoveisCache.has(ano)) {
    const pascoa = _domingoDePascoa(ano);
    _feriadosMoveisCache.set(ano, new Set([
      _isoUTC(_somaDiasUTC(pascoa, -48)), // Carnaval — segunda-feira
      _isoUTC(_somaDiasUTC(pascoa, -47)), // Carnaval — terça-feira
      _isoUTC(_somaDiasUTC(pascoa, -2)),  // Sexta-feira Santa
      _isoUTC(_somaDiasUTC(pascoa, 60)),  // Corpus Christi
    ]));
  }
  return _feriadosMoveisCache.get(ano);
}

// Fetch memoizado: `data/feriados.csv` é estático e consultado por várias
// telas (rateio de ocorrência, alerta de prazo). O Set resolvido fica em
// `_feriadosCache` para permitir a checagem SÍNCRONA na renderização das
// tabelas (ver `prazoWarningHtml`).
let _feriadosPromise = null;
let _feriadosCache = null;

async function carregarFeriadosMunicipais() {
  if (!_feriadosPromise) {
    _feriadosPromise = (async () => {
      try {
        const resp = await fetch('data/feriados.csv');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const texto = await resp.text();
        const linhas = texto.trim().split('\n').slice(1);
        const set = new Set(linhas.map(l => l.split(',')[0].trim()).filter(Boolean));
        _feriadosCache = set;
        return set;
      } catch (e) {
        console.warn('Não foi possível carregar data/feriados.csv — feriados municipais não serão considerados:', e);
        _feriadosPromise = null; // permite nova tentativa numa chamada futura
        return new Set();
      }
    })();
  }
  return _feriadosPromise;
}

// Set de feriados municipais já carregado, ou null se o fetch ainda não
// terminou (nunca dispara requisição — é o caminho síncrono da renderização).
function feriadosEmCache() {
  return _feriadosCache;
}

function ehDiaUtil(dataISO, feriadosSet) {
  if (!dataISO) return false;
  const d = new Date(dataISO + 'T12:00:00');
  if (d.getDay() === 0 || d.getDay() === 6) return false;
  if (FERIADOS_NACIONAIS_FIXOS_MMDD.includes(dataISO.slice(5))) return false;
  if (feriadosMoveisNacionais(Number(dataISO.slice(0, 4))).has(dataISO)) return false;
  return !(feriadosSet && feriadosSet.has(dataISO));
}

// ── Prorrogação de prazo para o próximo dia útil ──
// Prazo que vence em sábado, domingo ou feriado prorroga-se para o primeiro
// dia útil seguinte (art. 224, §1º, do CPC, aplicado por analogia ao processo
// administrativo): prazo no sábado cumprido na segunda-feira está EM DIA.
function prazoEfetivo(prazoISO, feriadosSet) {
  if (!prazoISO || !/^\d{4}-\d{2}-\d{2}$/.test(prazoISO)) return prazoISO || '';
  let iso = prazoISO;
  // O limite evita laço infinito caso alguma data inválida escape do regex.
  for (let i = 0; i < 30 && !ehDiaUtil(iso, feriadosSet); i++) iso = _proximoDiaISO(iso);
  return iso;
}

// Regra única de "cumprida fora do prazo", usada tanto na importação
// (visa-import.js / sim-import.js) quanto na exibição do alerta.
function cumpridoForaDoPrazo(prazoISO, cumprimentoISO, feriadosSet) {
  if (!prazoISO || !cumprimentoISO) return false;
  return cumprimentoISO > prazoEfetivo(prazoISO, feriadosSet);
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

/** Formata um total de pontos para exibição, sempre com 2 casas decimais. */
function formatPontos(n) {
  return round2(n).toFixed(2);
}

// ── Regra de produtividade — fiscais de 30 horas semanais ──────────────
// Carga horária reduzida (30h em vez de 40h) dá direito a pontuação
// proporcionalmente maior por atividade (fator 40/30). Lista fixa: situação
// imutável, não depende de cadastro no admin nem do sistema VISA.
const FATOR_30H = 40 / 30; // ≈ 1.3333...

const FISCAIS_30H = new Set([
  'ariannefvieira@hotmail.com',
  'edsonarantes@anapolis.go.gov.br',
  'geraldoedsonrosa@gmail.com',
  'joseluizribeiro22@gmail.com',
  'juliocteles@anapolis.go.gov.br',
  'kamillarolim@gmail.com',
  'marciorodovalho@anapolis.go.gov.br',
  'santosrat@gmail.com',
  'silviamarques@anapolis.go.gov.br',
  'tathnut@hotmail.com',
]);

function ehFiscal30h(email) {
  return FISCAIS_30H.has(String(email || '').trim().toLowerCase());
}

// Aplica o fator 40/30 aos pontos de um fiscal de 30h, quando a regra
// estiver ativa (flag de Parametrização). `pontos` é o valor requerido
// (tabela); o retorno já vem arredondado em 2 casas.
function pontosComFator30h(pontos, email, regraAtiva) {
  const base = Number(pontos) || 0;
  if (regraAtiva && ehFiscal30h(email)) return round2(base * FATOR_30H);
  return round2(base);
}

/** Normaliza um nome para casamento tolerante (trim, minúsculas, sem acentos). */
function normalizarNome(nome) {
  return String(nome || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

// ── Alerta "cumprida fora do prazo" (⚠️) + modal de detalhe ──
// A importação (visa-import.js / sim-import.js) grava em cada lançamento
// `fora_do_prazo` (bool) e `prazo_os` (ISO). O ícone aparece nas tabelas de
// lançamentos e, ao ser clicado, abre um modal com a redação detalhada.
// O modal é injetado uma única vez e controlado por delegação de eventos,
// então funciona em qualquer página/tabela sem wiring adicional.

// Dias corridos de atraso entre o prazo (já prorrogado para o próximo dia
// útil, quando cai em fim de semana/feriado) e a data de cumprimento —
// null se em dia.
function _prazoDiasAtraso(prazoISO, cumprISO) {
  if (!prazoISO || !cumprISO) return null;
  const a = new Date(prazoEfetivo(prazoISO, feriadosEmCache()) + 'T00:00:00');
  const b = new Date(cumprISO + 'T00:00:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  const diff = Math.round((b - a) / 86400000);
  return diff > 0 ? diff : null;
}

// HTML do ícone ⚠️ (só quando o lançamento foi cumprido fora do prazo).
// Os dados do modal viajam no próprio elemento via data-* (sem lookup externo).
function prazoWarningHtml(m) {
  if (!m || !m.fora_do_prazo) return '';
  // Reavaliação defensiva com a regra de prorrogação: lançamentos importados
  // antes dela ficaram gravados com fora_do_prazo=true mesmo quando o prazo
  // caía em fim de semana ou feriado. Com os feriados já em cache o ícone some
  // sem depender de nova importação; sem cache, vale o que está gravado.
  const feriados = feriadosEmCache();
  if (feriados && m.prazo_os && m.data && !cumpridoForaDoPrazo(m.prazo_os, m.data, feriados)) return '';
  const origem = m.motivo_os || (m.origem === 'sim_csv' ? 'Auditoria' : '—');
  return ` <span class="prazo-alerta" role="button" tabindex="0"` +
    ` style="cursor:pointer;color:var(--amar)"` +
    ` title="Cumprida fora do prazo — clique para detalhes"` +
    ` data-origem="${escHtml(origem)}" data-os="${escHtml(m.os_numero || '—')}"` +
    ` data-prazo="${escHtml(m.prazo_os || '')}" data-cumpr="${escHtml(m.data || '')}">⚠️</span>`;
}

// Preenche e exibe o modal a partir do dataset do ícone clicado.
function abrirForaPrazo(ds) {
  _initForaPrazoModal();
  const modal = document.getElementById('modal-fora-prazo');
  if (!modal) return;
  const dias = _prazoDiasAtraso(ds.prazo, ds.cumpr);
  // Quando o prazo original caiu em dia não útil, o modal mostra a data para a
  // qual ele foi prorrogado — é ela que define o atraso.
  const efetivo = ds.prazo ? prazoEfetivo(ds.prazo, feriadosEmCache()) : '';
  const prorrogado = efetivo && efetivo !== ds.prazo;
  modal.querySelector('#fp-body').innerHTML =
    `<p style="margin:0 0 12px">Esta ordem de serviço foi cumprida após o prazo de execução.</p>` +
    `<ul style="list-style:none;padding:0;margin:0;line-height:1.9">` +
    `<li><strong>Origem da demanda:</strong> ${escHtml(ds.origem || '—')}</li>` +
    `<li><strong>Nº da OS:</strong> ${escHtml(ds.os || '—')}</li>` +
    `<li><strong>Prazo para execução:</strong> ${escHtml(ds.prazo ? fmtData(ds.prazo) : '—')}` +
    (prorrogado
      ? `<br><small style="opacity:.75">Venceu em dia não útil — prorrogado para ` +
        `${escHtml(fmtData(efetivo))} (primeiro dia útil seguinte).</small>`
      : '') +
    `</li>` +
    `<li><strong>Data do cumprimento:</strong> ${escHtml(ds.cumpr ? fmtData(ds.cumpr) : '—')}</li>` +
    `<li><strong>Atraso:</strong> ${dias != null ? dias + ' dia(s)' : '—'}</li>` +
    `</ul>`;
  modal.style.display = 'flex';
}

// Injeta o markup do modal (uma vez) e registra os fechamentos.
function _initForaPrazoModal() {
  if (typeof document === 'undefined' || !document.body) return;
  if (document.getElementById('modal-fora-prazo')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML =
    `<div id="modal-fora-prazo" class="modal-backdrop" style="display:none">` +
    `<div class="modal" style="max-width:440px">` +
    `<div class="modal-header"><span>⚠️ Cumprida fora do prazo</span>` +
    `<button class="modal-close" id="fp-close" aria-label="Fechar">✕</button></div>` +
    `<div class="modal-body" id="fp-body"></div>` +
    `<div class="modal-footer"><button class="btn btn-default" id="fp-close2">Fechar</button></div>` +
    `</div></div>`;
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.getElementById('modal-fora-prazo');
  const hide = () => { modal.style.display = 'none'; };
  document.getElementById('fp-close').addEventListener('click', hide);
  document.getElementById('fp-close2').addEventListener('click', hide);
  modal.addEventListener('click', (e) => { if (e.target === modal) hide(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') hide();
  });
}

// Ativação por clique ou Enter/Espaço em qualquer .prazo-alerta (delegação).
function _onPrazoAlertaActivate(e) {
  const el = e.target && e.target.closest ? e.target.closest('.prazo-alerta') : null;
  if (!el) return;
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  abrirForaPrazo(el.dataset);
}

if (typeof document !== 'undefined') {
  // Pré-carrega os feriados (arquivo estático de ~0,5 KB) para que a checagem
  // síncrona de prorrogação de prazo já tenha o Set pronto quando as tabelas
  // forem renderizadas — elas só aparecem depois das consultas ao Firestore,
  // bem mais lentas que este fetch.
  carregarFeriadosMunicipais();
  document.addEventListener('click', _onPrazoAlertaActivate);
  document.addEventListener('keydown', _onPrazoAlertaActivate);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initForaPrazoModal);
  } else {
    _initForaPrazoModal();
  }
}

// ─────────────────────────────────────────────────────────────
// Alerta de pontuação zerada por não cumulatividade
// ─────────────────────────────────────────────────────────────
// A importação grava `zerado_motivo` quando a vistoria é zerada (Plantão
// item 9 — manual ou fiscal escalado pela gerência —, OPF item 18, REL-alta
// item 13). O ícone ⚠️ ao lado dos Pontos Requeridos é CLICÁVEL e abre um
// modal com o motivo e o dispositivo legal — antes era apenas um tooltip via
// `title` (cursor:help), que vira um "?" no desktop e não abre nada no
// celular. Mesmo padrão de modal único + delegação do alerta de prazo acima.

// HTML do ícone ⚠️ (só quando o lançamento tem zerado_motivo).
// Os dados do modal viajam no próprio elemento via data-* (sem lookup externo).
function zeradoWarningHtml(m) {
  if (!m || !m.zerado_motivo) return '';
  return ` <span class="zerado-alerta" role="button" tabindex="0"` +
    ` style="cursor:pointer;color:var(--amar)"` +
    ` title="Pontuação zerada — clique para detalhes"` +
    ` data-motivo="${escHtml(m.zerado_motivo)}"` +
    ` data-dispositivo="${escHtml(m.dispositivo_legal || '')}">⚠️</span>`;
}

// Preenche e exibe o modal a partir do dataset do ícone clicado.
function abrirZeradoMotivo(ds) {
  _initZeradoModal();
  const modal = document.getElementById('modal-zerado');
  if (!modal) return;
  modal.querySelector('#zr-body').innerHTML =
    `<p style="margin:0 0 12px">Este lançamento teve a pontuação zerada por não cumulatividade.</p>` +
    `<ul style="list-style:none;padding:0;margin:0;line-height:1.9">` +
    `<li><strong>Motivo:</strong> ${escHtml(ds.motivo || '—')}</li>` +
    (ds.dispositivo ? `<li><strong>Dispositivo legal:</strong> ${escHtml(ds.dispositivo)}</li>` : '') +
    `</ul>`;
  modal.style.display = 'flex';
}

// Injeta o markup do modal (uma vez) e registra os fechamentos.
function _initZeradoModal() {
  if (typeof document === 'undefined' || !document.body) return;
  if (document.getElementById('modal-zerado')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML =
    `<div id="modal-zerado" class="modal-backdrop" style="display:none">` +
    `<div class="modal" style="max-width:480px">` +
    `<div class="modal-header"><span>⚠️ Pontuação zerada</span>` +
    `<button class="modal-close" id="zr-close" aria-label="Fechar">✕</button></div>` +
    `<div class="modal-body" id="zr-body"></div>` +
    `<div class="modal-footer"><button class="btn btn-default" id="zr-close2">Fechar</button></div>` +
    `</div></div>`;
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.getElementById('modal-zerado');
  const hide = () => { modal.style.display = 'none'; };
  document.getElementById('zr-close').addEventListener('click', hide);
  document.getElementById('zr-close2').addEventListener('click', hide);
  modal.addEventListener('click', (e) => { if (e.target === modal) hide(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') hide();
  });
}

// Ativação por clique ou Enter/Espaço em qualquer .zerado-alerta (delegação).
function _onZeradoAlertaActivate(e) {
  const el = e.target && e.target.closest ? e.target.closest('.zerado-alerta') : null;
  if (!el) return;
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  abrirZeradoMotivo(el.dataset);
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', _onZeradoAlertaActivate);
  document.addEventListener('keydown', _onZeradoAlertaActivate);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initZeradoModal);
  } else {
    _initZeradoModal();
  }
}

// ── Lançamento REABERTO (reconciliação com o WCVS) ───────
// O inspecoes.csv é a fonte da verdade do mês aberto: se a inspeção foi alterada
// no WCVS depois de homologada (inclusive a data do documento, que a tira da
// competência), ou se outro lançamento do mesmo dia a tornou não cumulativa,
// a importação desfaz a homologação e grava `reaberto_*`.
// O fiscal precisa entender por que a pontuação dele caiu sem ele ter feito
// nada — daí o ícone 🔄 clicável com a explicação completa. Mesmo padrão de
// modal único + delegação usado no alerta de prazo e no de pontuação zerada.

function reabertoWarningHtml(m) {
  // Sem motivo não há o que explicar: é o caso do órfão já decidido pelo
  // administrador, que mantém `reaberto_tipo` só como marca interna anti-vaivém.
  if (!m || !m.reaberto_tipo || !m.reaberto_motivo) return '';
  let diffJson = '';
  try { diffJson = m.reaberto_diff ? JSON.stringify(m.reaberto_diff) : ''; } catch (_) {}
  return ` <span class="reaberto-alerta" role="button" tabindex="0"` +
    ` style="cursor:pointer;color:var(--amar)"` +
    ` title="Lançamento reaberto — clique para detalhes"` +
    ` data-tipo="${escHtml(m.reaberto_tipo)}"` +
    ` data-motivo="${escHtml(m.reaberto_motivo || '')}"` +
    ` data-anterior="${escHtml(m.reaberto_pontos_homologado_anterior == null ? '' : String(m.reaberto_pontos_homologado_anterior))}"` +
    ` data-diff="${escHtml(diffJson)}">🔄</span>`;
}

const _REABERTO_TITULO = {
  origem: 'Inspeção alterada no WCVS',
  orfao: 'Data da inspeção alterada no WCVS',
  cnae_reclassificado: 'Atividade não selecionada na inspeção (WCVS)',
  incompatibilidade: 'Lançamento incompatível no mesmo dia',
};

function abrirReaberto(ds) {
  _initReabertoModal();
  const modal = document.getElementById('modal-reaberto');
  if (!modal) return;

  let diff = [];
  try { diff = ds.diff ? JSON.parse(ds.diff) : []; } catch (_) { diff = []; }

  // Em CNAE não selecionado o próprio motivo já é a instrução completa (o que
  // fazer no WCVS para a atividade voltar a pontuar); um parágrafo de abertura
  // aqui só repetiria a mesma informação antes dela. Nos outros casos a abertura
  // tranquiliza quem vê a pontuação cair: o lançamento não foi perdido.
  const intro = ds.tipo === 'cnae_reclassificado'
    ? ''
    : `Este lançamento <strong>já tinha sido homologado</strong> e voltou para a conferência. ` +
      `Nada foi perdido: ele continua na sua lista e será homologado de novo assim que o ` +
      `administrador conferir.`;

  let html =
    (intro ? `<p style="margin:0 0 12px">${intro}</p>` : '') +
    `<p style="margin:0 0 12px">${escHtml(ds.motivo || '—')}</p>`;

  if (ds.anterior) {
    html += `<p style="margin:0 0 12px"><strong>Pontuação homologada anteriormente:</strong> ` +
            `${escHtml(ds.anterior)} pt(s).</p>`;
  }

  if (diff.length) {
    html += `<table style="width:100%;border-collapse:collapse;font-size:.92em">` +
      `<thead><tr>` +
      `<th style="text-align:left;padding:4px 6px;border-bottom:1px solid #e2e8f0">Campo</th>` +
      `<th style="text-align:left;padding:4px 6px;border-bottom:1px solid #e2e8f0">Como foi homologado</th>` +
      `<th style="text-align:left;padding:4px 6px;border-bottom:1px solid #e2e8f0">Como está hoje no WCVS</th>` +
      `</tr></thead><tbody>`;
    for (const d of diff) {
      html += `<tr>` +
        `<td style="padding:4px 6px"><strong>${escHtml(d.label || d.campo || '')}</strong></td>` +
        `<td style="padding:4px 6px">${escHtml(d.de === '' || d.de == null ? '—' : String(d.de))}</td>` +
        `<td style="padding:4px 6px">${escHtml(d.para === '' || d.para == null ? '—' : String(d.para))}</td>` +
        `</tr>`;
    }
    html += `</tbody></table>`;
  }

  modal.querySelector('#rb-title').textContent =
    '🔄 ' + (_REABERTO_TITULO[ds.tipo] || 'Lançamento reaberto');
  modal.querySelector('#rb-body').innerHTML = html;
  modal.style.display = 'flex';
}

function _initReabertoModal() {
  if (typeof document === 'undefined' || !document.body) return;
  if (document.getElementById('modal-reaberto')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML =
    `<div id="modal-reaberto" class="modal-backdrop" style="display:none">` +
    `<div class="modal" style="max-width:620px">` +
    `<div class="modal-header"><span id="rb-title">🔄 Lançamento reaberto</span>` +
    `<button class="modal-close" id="rb-close" aria-label="Fechar">✕</button></div>` +
    `<div class="modal-body" id="rb-body"></div>` +
    `<div class="modal-footer"><button class="btn btn-default" id="rb-close2">Entendi</button></div>` +
    `</div></div>`;
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.getElementById('modal-reaberto');
  const hide = () => { modal.style.display = 'none'; };
  document.getElementById('rb-close').addEventListener('click', hide);
  document.getElementById('rb-close2').addEventListener('click', hide);
  modal.addEventListener('click', (e) => { if (e.target === modal) hide(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') hide();
  });
}

function _onReabertoAlertaActivate(e) {
  const el = e.target && e.target.closest ? e.target.closest('.reaberto-alerta') : null;
  if (!el) return;
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  abrirReaberto(el.dataset);
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', _onReabertoAlertaActivate);
  document.addEventListener('keydown', _onReabertoAlertaActivate);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initReabertoModal);
  } else {
    _initReabertoModal();
  }
}

// ─────────────────────────────────────────────────────────────
// Coluna "Fiscais": contagem clicável + alerta de autorização
// ─────────────────────────────────────────────────────────────
// A importação VISA grava `fiscais_participantes` (lista de nomes) quando a
// inspeção tem 2+ fiscais. A contagem na coluna "Fiscais" vira CLICÁVEL e abre
// um modal com o nome de todos os participantes. Registros legados (sem
// reimportar) caem no fallback `qtd_fiscais` (número simples, não-clicável).
// Mesmo padrão de modal único + delegação dos alertas de prazo/zerado acima.

// HTML da contagem de fiscais (clicável quando há lista de participantes).
// Os dados do modal viajam no próprio elemento via data-* (nomes unidos por |).
function fiscaisCountHtml(m) {
  if (m && Array.isArray(m.fiscais_participantes) && m.fiscais_participantes.length >= 2) {
    return `<span class="fiscais-link" role="button" tabindex="0"` +
      ` style="cursor:pointer;text-decoration:underline"` +
      ` title="Clique para ver os fiscais participantes"` +
      ` data-fiscais="${escHtml(m.fiscais_participantes.join('|'))}">` +
      `${m.fiscais_participantes.length}</span>`;
  }
  return (m && m.qtd_fiscais != null) ? escHtml(String(m.qtd_fiscais)) : '—';
}

// Documento lavrado + o número impresso nele (coluna NUMERO do inspecoes.csv),
// que é o que o fiscal usa para localizar o papel. O número reinicia por talão,
// então acompanha o tipo e não aparece sozinho. Lançamentos importados antes
// deste campo existir ficam sem ele até a próxima importação sincronizar.
function documentoComNumeroHtml(m) {
  const tipo = (m && m.documento) ? String(m.documento).trim() : '';
  if (!tipo) return '—';
  const num = (m && m.numero != null) ? String(m.numero).trim() : '';
  if (!num) return escHtml(tipo);
  return `${escHtml(tipo)} <span class="text-muted">nº ${escHtml(num)}</span>`;
}

// Preenche e exibe o modal de participantes a partir do dataset do elemento.
function abrirFiscais(ds) {
  _initFiscaisModal();
  const modal = document.getElementById('modal-fiscais');
  if (!modal) return;
  const nomes = String(ds.fiscais || '').split('|').filter(Boolean);
  modal.querySelector('#fs-body').innerHTML =
    `<ul style="list-style:none;padding:0;margin:0;line-height:1.9">` +
    nomes.map(n => `<li>👤 ${escHtml(n)}</li>`).join('') +
    `</ul>`;
  modal.style.display = 'flex';
}

// Injeta o markup do modal (uma vez) e registra os fechamentos.
function _initFiscaisModal() {
  if (typeof document === 'undefined' || !document.body) return;
  if (document.getElementById('modal-fiscais')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML =
    `<div id="modal-fiscais" class="modal-backdrop" style="display:none">` +
    `<div class="modal" style="max-width:480px">` +
    `<div class="modal-header"><span>👥 Fiscais participantes</span>` +
    `<button class="modal-close" id="fs-close" aria-label="Fechar">✕</button></div>` +
    `<div class="modal-body" id="fs-body"></div>` +
    `<div class="modal-footer"><button class="btn btn-default" id="fs-close2">Fechar</button></div>` +
    `</div></div>`;
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.getElementById('modal-fiscais');
  const hide = () => { modal.style.display = 'none'; };
  document.getElementById('fs-close').addEventListener('click', hide);
  document.getElementById('fs-close2').addEventListener('click', hide);
  modal.addEventListener('click', (e) => { if (e.target === modal) hide(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') hide();
  });
}

// Ativação por clique ou Enter/Espaço em qualquer .fiscais-link (delegação).
function _onFiscaisActivate(e) {
  const el = e.target && e.target.closest ? e.target.closest('.fiscais-link') : null;
  if (!el) return;
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  abrirFiscais(el.dataset);
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', _onFiscaisActivate);
  document.addEventListener('keydown', _onFiscaisActivate);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initFiscaisModal);
  } else {
    _initFiscaisModal();
  }
}

// HTML do ícone ⚠️ de autorização pendente (só na conferência): inspeção com
// mais de dois fiscais E `motivo_pendencia` gravado (sem autorização prévia).
function fiscaisAlertaHtml(m) {
  if (!m || !Array.isArray(m.fiscais_participantes) ||
      m.fiscais_participantes.length <= 2 || !m.motivo_pendencia) return '';
  return ` <span class="fiscais-alerta" role="button" tabindex="0"` +
    ` style="cursor:pointer;color:var(--amar);font-size:1.4em;vertical-align:middle"` +
    ` title="Mais de dois fiscais sem autorização prévia — clique para detalhes"` +
    ` data-fiscais="${escHtml(m.fiscais_participantes.join('|'))}">⚠️</span>`;
}

// Preenche e exibe o modal do alerta a partir do dataset do ícone clicado.
function abrirFiscaisAlerta(ds) {
  _initFiscaisAlertaModal();
  const modal = document.getElementById('modal-fiscais-alerta');
  if (!modal) return;
  const nomes = String(ds.fiscais || '').split('|').filter(Boolean);
  modal.querySelector('#fa-body').innerHTML =
    `<p style="margin:0 0 12px">Esta inspeção foi realizada por <strong>mais de dois fiscais</strong> ` +
    `e <strong>não consta autorização prévia</strong>: a OS não está em requerimento.csv com ` +
    `prioridade, nem o Ofício em oficio.csv com Terceiro.</p>` +
    `<p style="margin:0 0 12px">Os dois primeiros fiscais entram normalmente; os lançamentos ` +
    `<strong>do 3º fiscal em diante</strong> permanecem <strong>pendentes</strong> até a ` +
    `autorização.</p>` +
    `<p style="margin:0 0 4px"><strong>Fiscais participantes:</strong></p>` +
    `<ul style="list-style:none;padding:0;margin:0;line-height:1.9">` +
    nomes.map(n => `<li>👤 ${escHtml(n)}</li>`).join('') +
    `</ul>`;
  modal.style.display = 'flex';
}

// Injeta o markup do modal (uma vez) e registra os fechamentos.
function _initFiscaisAlertaModal() {
  if (typeof document === 'undefined' || !document.body) return;
  if (document.getElementById('modal-fiscais-alerta')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML =
    `<div id="modal-fiscais-alerta" class="modal-backdrop" style="display:none">` +
    `<div class="modal" style="max-width:480px">` +
    `<div class="modal-header"><span>⚠️ Autorização de fiscais pendente</span>` +
    `<button class="modal-close" id="fa-close" aria-label="Fechar">✕</button></div>` +
    `<div class="modal-body" id="fa-body"></div>` +
    `<div class="modal-footer"><button class="btn btn-default" id="fa-close2">Fechar</button></div>` +
    `</div></div>`;
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.getElementById('modal-fiscais-alerta');
  const hide = () => { modal.style.display = 'none'; };
  document.getElementById('fa-close').addEventListener('click', hide);
  document.getElementById('fa-close2').addEventListener('click', hide);
  modal.addEventListener('click', (e) => { if (e.target === modal) hide(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') hide();
  });
}

// Ativação por clique ou Enter/Espaço em qualquer .fiscais-alerta (delegação).
function _onFiscaisAlertaActivate(e) {
  const el = e.target && e.target.closest ? e.target.closest('.fiscais-alerta') : null;
  if (!el) return;
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  abrirFiscaisAlerta(el.dataset);
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', _onFiscaisAlertaActivate);
  document.addEventListener('keydown', _onFiscaisAlertaActivate);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initFiscaisAlertaModal);
  } else {
    _initFiscaisAlertaModal();
  }
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
window.FATOR_30H             = FATOR_30H;
window.FISCAIS_30H           = FISCAIS_30H;
window.ehFiscal30h           = ehFiscal30h;
window.pontosComFator30h     = pontosComFator30h;
window.carregarFeriadosMunicipais = carregarFeriadosMunicipais;
window.feriadosEmCache          = feriadosEmCache;
window.feriadosMoveisNacionais  = feriadosMoveisNacionais;
window.ehDiaUtil                = ehDiaUtil;
window.prazoEfetivo             = prazoEfetivo;
window.cumpridoForaDoPrazo      = cumpridoForaDoPrazo;
window.diasUteisNoMes           = diasUteisNoMes;
window.MEDIA_PRODUTIVIDADE_OCORRENCIA = MEDIA_PRODUTIVIDADE_OCORRENCIA;
window.diasDaOcorrenciaPorMes   = diasDaOcorrenciaPorMes;
window.periodosSeSobrepoem      = periodosSeSobrepoem;
window.normalizarNome           = normalizarNome;
window.prazoWarningHtml          = prazoWarningHtml;
window.abrirForaPrazo            = abrirForaPrazo;
window.zeradoWarningHtml         = zeradoWarningHtml;
window.abrirZeradoMotivo         = abrirZeradoMotivo;
window.reabertoWarningHtml       = reabertoWarningHtml;
window.abrirReaberto             = abrirReaberto;
window.fiscaisCountHtml          = fiscaisCountHtml;
window.abrirFiscais              = abrirFiscais;
window.documentoComNumeroHtml    = documentoComNumeroHtml;
window.fiscaisAlertaHtml         = fiscaisAlertaHtml;
window.abrirFiscaisAlerta        = abrirFiscaisAlerta;
window.visaAppSidebarLink        = visaAppSidebarLink;
