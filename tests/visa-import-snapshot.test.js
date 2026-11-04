// tests/visa-import-snapshot.test.js
// Valida o snapshot do mês na importação VISA (js/visa-import.js): a versão
// nova tem de produzir EXATAMENTE o mesmo resultado que a anterior — mesmo
// banco final e mesmo relatório de ações — lendo menos do Firestore.
//
// Carrega o CÓDIGO REAL (utils.js, firestore.js, visa-import.js) sobre o
// Firestore falso em memória de js/fake-firestore.js. A versão anterior é
// lida do git (commit BASE); sem git disponível, o teste de equivalência é
// pulado e os demais rodam normalmente.
//
// Rodar: `node --test tests/` (Node ≥ 20, sem dependências).

'use strict';
process.env.TZ = 'America/Sao_Paulo';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');
const { execFileSync } = require('node:child_process');

const fake = require('../js/fake-firestore.js');
const RAIZ = path.resolve(__dirname, '..');
// Último commit da main ANTES do snapshot do mês (versão de referência).
const BASE = '7da00da';

// ── Ambiente de navegador mínimo ──
global.window = global;
global.firebase = fake.firebase;
function el() {
  return {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    innerHTML: '', textContent: '', value: '', hidden: false,
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    remove() {}, setAttribute() {}, getAttribute: () => null, focus() {}, click() {},
    querySelector: () => el(), querySelectorAll: () => [], closest: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  };
}
global.document = Object.assign(el(), {
  getElementById: () => el(), createElement: () => el(),
  body: el(), documentElement: el(), referrer: '',
});
global.matchMedia = () => ({ matches: false });
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.fetch = async (url) => {
  if (String(url).endsWith('data/feriados.csv')) {
    return { ok: true, text: async () => fs.readFileSync(path.join(RAIZ, 'data/feriados.csv'), 'utf8') };
  }
  throw new Error(`fetch inesperado: ${url}`);
};
const _setTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => { const t = _setTimeout(fn, ms, ...args); if (t && t.unref) t.unref(); return t; };

// Papa.parse mínimo: cabeçalho, delimitador explícito ou detectado (; ou ,),
// sem campos com delimitador embutido — suficiente para os CSVs de teste.
global.Papa = {
  parse(text, opts) {
    opts = opts || {};
    const linhas = String(text).replace(/\r/g, '').split('\n')
      .filter(l => !(opts.skipEmptyLines && !l.trim()));
    if (!linhas.length) return { data: [] };
    const delim = opts.delimiter || (linhas[0].includes(';') ? ';' : ',');
    const th = opts.transformHeader || (h => h);
    const cab = linhas[0].split(delim).map(h => th(h));
    const data = linhas.slice(1).map(l => {
      const cols = l.split(delim);
      const o = {};
      cab.forEach((h, i) => { o[h] = cols[i] !== undefined ? cols[i] : ''; });
      return o;
    });
    return { data };
  },
};

const _info = console.info, _warn = console.warn, _err = console.error;
console.info = () => {}; console.warn = () => {};
for (const f of ['js/utils.js', 'js/firestore.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(RAIZ, f), 'utf8'), { filename: f });
}
console.info = _info; console.warn = _warn;

// Cada versão roda isolada num escopo de função (as constantes de topo do
// arquivo não colidem) e devolve a sua importarInspecoesVISA.
function carregarImportador(codigo, nome) {
  const antes = window.importarInspecoesVISA;
  vm.runInThisContext(`(function(){\n${codigo}\n})();`, { filename: nome });
  const fn = window.importarInspecoesVISA;
  window.importarInspecoesVISA = antes;
  return fn;
}
const importarNovo = carregarImportador(
  fs.readFileSync(path.join(RAIZ, 'js/visa-import.js'), 'utf8'), 'visa-import.js(novo)');
let importarAntigo = null;
try {
  const codigo = execFileSync('git', ['show', `${BASE}:js/visa-import.js`],
    { cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  importarAntigo = carregarImportador(codigo, 'visa-import.js(antigo)');
} catch (_) { importarAntigo = null; }

// Escala de plantão e notificações ficam fora do teste (iguais nas duas versões).
window.datasEscaladoNoMes = async () => new Set();
window.dispararNotificacaoFiscal = undefined;
window.notificarRecusaAlterada = undefined;

// ── Contador de leituras (doc.get = 1; consulta = docs devolvidos, mín. 1) ──
const _db0 = new fake.FakeFirestore();
const DocProto   = Object.getPrototypeOf(_db0.collection('x').doc('y'));
const QueryProto = Object.getPrototypeOf(Object.getPrototypeOf(_db0.collection('x')));
let leituras = 0;
let ganchoConsulta = null; // (query, snap) → chamado após cada consulta
const _docGet = DocProto.get, _queryGet = QueryProto.get;
DocProto.get = async function () { leituras += 1; return _docGet.call(this); };
QueryProto.get = async function () {
  const snap = await _queryGet.call(this);
  leituras += Math.max(1, snap.size);
  if (ganchoConsulta) await ganchoConsulta(this, snap);
  return snap;
};

// ── Cenário (competência Novembro/2026) ──
const MES = 11, ANO = 2026;
const A = { email: 'a@teste', nome: 'Ana Alves' };
const B = { email: 'b@teste', nome: 'Bruno Braga' };
const C = { email: 'c@teste', nome: 'Carla Costa' };
const D = { email: 'd@teste', nome: 'Davi Dias' };
const FISCAIS = [A, B, C, D];

const CNAE_CSV = [
  'Subclasse;Atividade;Complexidade;equipe',
  '1111-1/01;Atividade media;Media;XX',
  '2222-2/02;Atividade baixa;Baixa;XX',
  '3333-3/03;Atividade alta;Alta;XX',
].join('\n');

const CAB = 'CONTROLE;DT_VISITA;Atividade;tipo;Modalidade;OS;Oficio;Protocolo;Denuncia;NUMERO;Fiscal1;Fiscal2;Fiscal3;CODIGO;entrega';
function linha(ctrl, data, cnae, f1, f2, f3, tipo) {
  return [ctrl, data, cnae, tipo || 'VISTORIA', '', '', '', '', '', '1' + ctrl,
          f1 ? f1.nome : '', f2 ? f2.nome : '', f3 ? f3.nome : '', 'R' + ctrl, ''].join(';');
}
// v1: estado em que a conferência foi feita.
const INSP_V1 = [CAB,
  linha(1001, '05.11.2026', '1111-1/01', A, B),       // homologado, sem mudança
  linha(1002, '06.11.2026', '1111-1/01', A),          // homologado, data muda na v2
  linha(1003, '06.11.2026', '1111-1/01', B, C),       // homologado, C sai na v2
  linha(1004, '10.11.2026', '1111-1/01', C),          // enviado, sem mudança
  linha(1005, '11.11.2026', '1111-1/01', A),          // recusado, data muda na v2
  linha(1006, '12.11.2026', '1111-1/01', B),          // enviado, sai do CSV na v2
  linha(1007, '13.11.2026', '1111-1/01', C),          // homologado, sai do CSV na v2
  linha(1008, '14.11.2026', '1111-1/01', A),          // homologado, CNAE reclassificado na v2
  linha(1009, '14.11.2026', '2222-2/02', B),          // homologado; PLT manual no dia → zera
  linha(1011, '16.11.2026', '3333-3/03', C, null, null, 'RELATORIO TECNICO'), // REL alta
  linha(1012, '16.11.2026', '1111-1/01', C),          // vistoria no dia do REL alta
  linha(1013, '17.11.2026', '1111-1/01', A),          // fechado, data muda na v2
  linha(1014, '18.11.2026', '1111-1/01', A),          // legado homologado
  linha(1015, '19.11.2026', '1111-1/01', A, B, C),    // 3º fiscal sem autorização
].join('\n');
// v2: o que o WCVS tem hoje.
const INSP_V2 = [CAB,
  linha(1001, '05.11.2026', '1111-1/01', A, B),
  linha(1002, '07.11.2026', '1111-1/01', A),
  linha(1003, '06.11.2026', '1111-1/01', B),
  linha(1004, '10.11.2026', '1111-1/01', C),
  linha(1005, '12.11.2026', '1111-1/01', A),
  linha(1008, '14.11.2026', '3333-3/03', A),
  linha(1009, '14.11.2026', '2222-2/02', B),
  linha(1010, '15.11.2026', '1111-1/01', A, D),       // nova; D com mês fechado
  linha(1011, '16.11.2026', '3333-3/03', C, null, null, 'RELATORIO TECNICO'),
  linha(1012, '16.11.2026', '1111-1/01', C),
  linha(1013, '18.11.2026', '1111-1/01', A),
  linha(1014, '18.11.2026', '1111-1/01', A),
  linha(1015, '19.11.2026', '1111-1/01', A, B, C),
].join('\n');

function servirCSVs(inspecoes) {
  const arquivos = {
    'data/inspecoes.csv': inspecoes,
    'data/cnae.csv': CNAE_CSV,
    'data/inspecoes_cnae.csv': 'CONTROLE;VISITA_CTRL;SUBCLASSE',
    'data/inspecoes_fiscais.csv': 'CONTROLE;VISITA_CTRL;FISCAL',
  };
  window.fetchGitHubCSV = async (p) => (p in arquivos ? arquivos[p] : null);
}

const silencioso = () => {};
async function rodar(importar, opts) {
  return importar({
    fiscalEmail: null, mes: MES, ano: ANO, allFiscais: FISCAIS,
    onProgress: silencioso, onProgressBar: silencioso, ...(opts || {}),
  });
}

// Monta o banco "como a conferência deixou": importa a v1 e aplica as
// decisões do administrador. Sempre com a versão NOVA, para os dois lados
// partirem do mesmo estado.
async function montarBanco() {
  const db = new fake.FakeFirestore();
  window.db = db;
  fake.congelarRelogio(Date.UTC(2026, 10, 3, 12));
  servirCSVs(INSP_V1);
  await rodar(importarNovo);
  const id = (ctrl, f, cnae) => window.db_visaDocId(ctrl, f.email, cnae);
  const homologar = (docId) => {
    const d = db._col('manuais').get(docId);
    assert.ok(d, `doc ausente: ${docId}`);
    db._col('manuais').set(docId, { ...d, status: 'aceito', pontos_homologado: d.pontos });
  };
  for (const [ctrl, f] of [[1001, A], [1001, B], [1002, A], [1003, B], [1003, C], [1007, C],
                           [1008, A], [1009, B], [1012, C]]) {
    homologar(id(ctrl, f, ctrl === 1009 ? '2222-2/02' : '1111-1/01'));
  }
  const rec = id(1005, A, '1111-1/01');
  db._col('manuais').set(rec, { ...db._col('manuais').get(rec), status: 'recusado' });
  const fch = id(1013, A, '1111-1/01');
  db._col('manuais').set(fch, { ...db._col('manuais').get(fch), status: 'fechado' });
  // Legado (esquema antigo, sem CNAE no id) homologado — a linha 1014 de A
  // deve ser preservada; remove o lançamento por CNAE criado pela v1.
  db._col('manuais').delete(id(1014, A, '1111-1/01'));
  db.semear('manuais', id(1014, A), {
    fiscal_email: A.email, fiscal_nome: A.nome, mes: MES, ano: ANO, data: '2026-11-18',
    origem: 'visa_csv', visa_controle: '1014', visa_cnae: '1111-1/01', status: 'aceito',
    pontos: 12, pontos_homologado: 12, tipo_codigo: 'VIS',
  });
  // Plantão manual do B no dia da vistoria 1009 (lançado depois da homologação).
  db.semear('manuais', 'manual_plt_b', {
    fiscal_email: B.email, fiscal_nome: B.nome, mes: MES, ano: ANO, data: '2026-11-14',
    origem: 'manual', tipo_codigo: 'PLT', status: 'enviado', pontos: 48,
  });
  // Davi já teve a competência fechada.
  db.semear('fechamentos', `${ANO}-${MES}-d_teste`, { fiscal_email: D.email, mes: MES, ano: ANO });
  return db;
}

function clonar(db) {
  const novo = new fake.FakeFirestore();
  for (const [col, mapa] of db._dados) {
    for (const [docId, dados] of mapa) novo._col(col).set(docId, JSON.parse(JSON.stringify(dados)));
  }
  return novo;
}

const CAMPOS_TEMPO = new Set(['created_at', 'updated_at', 'reaberto_em', 'recusa_alterado_em',
  'cnae_migrado_em', 'fechado_em', 'ts', 'expira_em', 'iniciado_em', 'heartbeat']);
function normalizar(v) {
  if (Array.isArray(v)) return v.map(normalizar);
  if (v && typeof v === 'object') {
    if (typeof v.toMillis === 'function') return '<ts>';
    const o = {};
    for (const k of Object.keys(v).sort()) if (!CAMPOS_TEMPO.has(k)) o[k] = normalizar(v[k]);
    return o;
  }
  return v;
}
const manuais = db => normalizar(Object.fromEntries([...db._col('manuais').entries()]));

async function executar(importar, base, opts) {
  const db = clonar(base);
  window.db = db;
  servirCSVs(INSP_V2);
  leituras = 0;
  const r = await rodar(importar, opts);
  return { db, r, leituras };
}

test('equivalência: versão nova = versão anterior (banco final e relatório)', { skip: !importarAntigo && 'git indisponível' }, async () => {
  const base = await montarBanco();
  const antigo = await executar(importarAntigo, base);
  const novo   = await executar(importarNovo, base);

  assert.deepEqual(manuais(novo.db), manuais(antigo.db), 'banco final diferente');
  assert.deepEqual(normalizar(novo.r.relatorio), normalizar(antigo.r.relatorio), 'relatório diferente');
  for (const k of ['criados', 'atualizados', 'ignorados', 'excluidos', 'migrados', 'erros',
                   'reabertos', 'reabertos_orfaos', 'reabertos_incompat', 'zerados_incompat', 'sincronizados']) {
    assert.equal(novo.r[k], antigo.r[k], `contador ${k}`);
  }
  assert.ok(novo.leituras < antigo.leituras,
    `leituras: nova ${novo.leituras} deveria ser < anterior ${antigo.leituras}`);
  console.log(`   leituras: anterior ${antigo.leituras} → nova ${novo.leituras}; ` +
              `atalhos ${novo.r.snap_atalhos}, releituras ${novo.r.snap_releituras}`);
});

test('equivalência também em modo simulação (nada gravado, mesmo relatório)', { skip: !importarAntigo && 'git indisponível' }, async () => {
  const base = await montarBanco();
  const antigo = await executar(importarAntigo, base, { simulacao: true });
  const novo   = await executar(importarNovo, base, { simulacao: true });
  assert.deepEqual(normalizar(novo.r.relatorio), normalizar(antigo.r.relatorio));
  assert.deepEqual(manuais(novo.db), manuais(base), 'simulação gravou algo');
});

test('regras preservadas: homologado alterado reabre; sem alteração fica; fechado intocável', async () => {
  const base = await montarBanco();
  const { db, r } = await executar(importarNovo, base);
  const get = (ctrl, f, cnae) => db._col('manuais').get(window.db_visaDocId(ctrl, f.email, cnae));

  // Homologado sem nenhuma mudança no CSV → intacto, decidido pela memória.
  assert.equal(get(1001, A, '1111-1/01').status, 'aceito');
  assert.equal(get(1001, B, '1111-1/01').status, 'aceito');
  assert.ok(r.snap_atalhos >= 2);
  // Homologado cuja data mudou no WCVS → reaberto para nova conferência.
  const d1002 = get(1002, A, '1111-1/01');
  assert.equal(d1002.status, 'enviado');
  assert.equal(d1002.reaberto_tipo, 'origem');
  assert.equal(d1002.data, '2026-11-07');
  // Fiscal retirado da inspeção → devolvido à conferência.
  assert.equal(get(1003, C, '1111-1/01').reaberto_tipo, 'fiscal_removido');
  // Vistoria homologada que passou a coincidir com plantão manual → reaberta.
  assert.equal(get(1009, B, '2222-2/02').status, 'enviado');
  // Recusado continua recusado (só ganha o alerta).
  const d1005 = get(1005, A, '1111-1/01');
  assert.equal(d1005.status, 'recusado');
  assert.ok(Array.isArray(d1005.recusa_alterado_diff) && d1005.recusa_alterado_diff.length);
  // Fechado: nada muda, nem a data.
  const d1013 = get(1013, A, '1111-1/01');
  assert.equal(d1013.status, 'fechado');
  assert.equal(d1013.data, '2026-11-17');
  // Fiscal com competência fechada não recebe lançamento novo.
  assert.equal(get(1010, D, '1111-1/01'), undefined);
  assert.ok(get(1010, A, '1111-1/01'));
});

test('concorrência: homologação feita durante a rodada não é atropelada', async () => {
  const base = await montarBanco();
  const db = clonar(base);
  window.db = db;
  // CSV em que a 1004 (enviada) mudou de data.
  servirCSVs(INSP_V2.replace('1004;10.11.2026', '1004;11.11.2026'));
  const id1004 = window.db_visaDocId(1004, C.email, '1111-1/01');
  const id1001 = window.db_visaDocId(1001, A.email, '1111-1/01');
  // Logo depois do snapshot (1ª consulta do mês inteiro): o administrador
  // homologa a 1004 e recusa a 1001 — a memória da rodada fica desatualizada.
  let disparou = false;
  ganchoConsulta = async (q, snap) => {
    const filtros = q._filtros.map(f => f[0]).join(',');
    if (!disparou && q._col === 'manuais' && filtros === 'mes,ano') {
      disparou = true;
      const m = db._col('manuais');
      m.set(id1004, { ...m.get(id1004), status: 'aceito', pontos_homologado: 12 });
      m.set(id1001, { ...m.get(id1001), status: 'recusado' });
    }
  };
  try { await rodar(importarNovo); } finally { ganchoConsulta = null; }
  assert.ok(disparou);
  // 1004: homologada no meio da rodada E alterada na origem → reaberta.
  const d1004 = db._col('manuais').get(id1004);
  assert.equal(d1004.status, 'enviado');
  assert.equal(d1004.reaberto_tipo, 'origem');
  assert.equal(d1004.data, '2026-11-11');
  // 1001: recusada no meio da rodada, sem mudança na origem → recusa mantida.
  assert.equal(db._col('manuais').get(id1001).status, 'recusado');
});

test('sem snapshot (falha na leitura do mês) segue o caminho antigo', async () => {
  const base = await montarBanco();
  const db = clonar(base);
  window.db = db;
  servirCSVs(INSP_V2);
  const orig = window.db_getManuaisTodos;
  let chamadas = 0;
  window.db_getManuaisTodos = async (...a) => {
    chamadas += 1;
    if (chamadas === 1) throw new Error('falha simulada');
    return orig(...a);
  };
  console.warn = () => {};
  let r;
  try { r = await rodar(importarNovo); } finally { window.db_getManuaisTodos = orig; console.warn = _warn; }
  assert.equal(r.snap_atalhos, 0);
  assert.equal(r.erros, 0);
  assert.equal(db._col('manuais').get(window.db_visaDocId(1002, A.email, '1111-1/01')).status, 'enviado');
});

process.on('exit', () => { console.error = _err; });
