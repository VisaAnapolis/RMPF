// tests/insp360-calculo.test.js
// Lançamento 360 (js/insp360.js): a mesma inspeção tem de pontuar EXATAMENTE
// igual pela importação do inspecoes.csv (importarInspecoesVISA) e pelo
// cálculo do 360 — os dois usam o mesmo motor (montarAlvosInspecaoVisa /
// regraDiaVistoriaVisa). Também cobre a gravação (inspeção + lançamentos só
// para participantes 360, edição, travas) e as regras de origem 'insp360'.
//
// Rodar: `node --test tests/` (Node ≥ 20, sem dependências).

'use strict';
process.env.TZ = 'America/Sao_Paulo';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

const fake = require('../js/fake-firestore.js');
const RAIZ = path.resolve(__dirname, '..');

// ── Ambiente de navegador mínimo (mesmo do visa-import-snapshot.test.js) ──
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
const _info = console.info, _warn = console.warn;
console.info = () => {}; console.warn = () => {};
for (const f of ['js/utils.js', 'js/firestore.js', 'js/visa-import.js', 'js/insp360.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(RAIZ, f), 'utf8'), { filename: f });
}
console.info = _info; console.warn = _warn;
window.datasEscaladoNoMes = async () => new Set();
window.dispararNotificacaoFiscal = undefined;
window.notificarRecusaAlterada = undefined;

// ── Cenário ──
const MES = 11, ANO = 2026;
const A = { email: 'a@teste', nome: 'Ana Alves' };
const B = { email: 'b@teste', nome: 'Bruno Braga' };
const C = { email: 'c@teste', nome: 'Carla Costa' };
const FISCAIS = [A, B, C];

const CNAE_CSV = [
  'Subclasse;Atividade;Complexidade;equipe',
  '1111-1/01;Atividade media;Media;XX',
  '2222-2/02;Atividade baixa;Baixa;XX',
  '3333-3/03;Atividade alta;Alta;XX',
  '5555-5/05;Restaurante;Alta;IA',
  '6666-6/06;Outra media;Media;XX',
].join('\n');
const REGULADOS_CSV = ['CODIGO;MUNICIPAL;RAZAO', 'R1;29.601;RESTAURANTE UM', 'R2;30.000;RESTAURANTE DOIS'].join('\n');
// taxa.csv: 2 linhas físicas por registro, inscrição no 5º campo.
const TAXA_CSV = ['a;b;c;d;inscricao;obs',
  'x;x;x;x;29601;Obs', '* Área: 150m²',
  'x;x;x;x;30000;Obs', '* Área: 80m²'].join('\n');

const CAB = 'CONTROLE;DT_VISITA;Atividade;tipo;Modalidade;OS;Oficio;Protocolo;Denuncia;NUMERO;Fiscal1;Fiscal2;Fiscal3;CODIGO;entrega';
// Cada caso: linha do CSV + o equivalente no formulário do 360.
const CASOS = [
  { ctrl: 2001, data: '03.11.2026', cnae: '1111-1/01', fiscais: [A], codigo: 'R9', tipo: 'TERMO DE INTIMAÇÃO' },
  { ctrl: 2002, data: '04.11.2026', cnae: '1111-1/01', fiscais: [A, B], codigo: 'R9', tipo: 'TERMO DE NOTIFICAÇÃO',
    extras: ['2222-2/02', '6666-6/06'] },                                   // dupla + extras sob o teto
  { ctrl: 2010, data: '14.11.2026', cnae: '1111-1/01', fiscais: [B], codigo: 'R9', tipo: 'TERMO DE NOTIFICAÇÃO',
    extras: ['3333-3/03'] },                                                // alta extra ocupa o teto de 48
  { ctrl: 2003, data: '05.11.2026', cnae: '5555-5/05', fiscais: [A], codigo: 'R1', tipo: 'TERMO DE INTIMAÇÃO' }, // 150 m² → 16
  { ctrl: 2004, data: '06.11.2026', cnae: '5555-5/05', fiscais: [B], codigo: 'R2', tipo: 'TERMO DE INTIMAÇÃO',
    extras: ['1111-1/01'] },                                                // 80 m² → 8 + média
  { ctrl: 2005, data: '07.11.2026', cnae: '1111-1/01', fiscais: [A, B, C], codigo: 'R9', tipo: 'AUTO DE INFRAÇÃO' }, // trio
  { ctrl: 2006, data: '10.11.2026', cnae: '3333-3/03', fiscais: [A], codigo: 'R9', tipo: 'CERTIDÃO' },
  { ctrl: 2007, data: '11.11.2026', cnae: '3333-3/03', fiscais: [B], codigo: 'R9', tipo: 'ANÁLISE DE PAS' },
  { ctrl: 2008, data: '12.11.2026', cnae: '1111-1/01', fiscais: [C], codigo: 'R9', tipo: 'TERMO DE INTIMAÇÃO', entregue: false,
    extras: ['2222-2/02'] },                                                // não entregue: só o informado
  { ctrl: 2009, data: '13.11.2026', cnae: '9999-9/99', fiscais: [C], codigo: 'R9', tipo: 'TERMO DE INTIMAÇÃO' }, // sem competência → média
];

function linhaCsv(c) {
  const f = c.fiscais;
  return [c.ctrl, c.data, c.cnae, c.tipo, '', '', '', '', '', '1' + c.ctrl,
          f[0] ? f[0].nome : '', f[1] ? f[1].nome : '', f[2] ? f[2].nome : '', c.codigo,
          c.entregue === false ? 'False' : ''].join(';');
}

function servir(inspecoes, inspCnae) {
  const arquivos = {
    'data/inspecoes.csv': inspecoes,
    'data/cnae.csv': CNAE_CSV,
    'data/inspecoes_cnae.csv': inspCnae,
    'data/inspecoes_fiscais.csv': 'CONTROLE;VISITA_CTRL;FISCAL',
    'data/regulados.csv': REGULADOS_CSV,
    'data/taxa.csv': TAXA_CSV,
  };
  window.fetchGitHubCSV = async (p) => (p in arquivos ? arquivos[p] : null);
}

const iso = (d) => { const [dd, mm, yy] = d.split('.'); return `${yy}-${mm}-${dd}`; };
const silencioso = () => {};

function formulario(c) {
  return {
    codigo: c.codigo, razao: '', data: iso(c.data), documento: c.tipo, numeroDoc: '1' + c.ctrl,
    entregue: c.entregue !== false, cnae: c.cnae, cnaesExtras: c.extras || [],
    fiscais: c.fiscais.map(f => ({ nome: f.nome, email: f.email, eh360: true })),
  };
}

const CAMPOS_COMPARADOS = ['fiscal_email', 'data', 'tipo_codigo', 'item_pontuacao', 'complexidade',
  'pontos', 'visa_cnae', 'cnae_origem', 'visa_area', 'qtd_fiscais', 'dispositivo_legal', 'status',
  'fiscais_participantes', 'descricao', 'complexidade_decreto'];
const recorte = (d) => Object.fromEntries(CAMPOS_COMPARADOS.map(k => [k, d[k] ?? null]));

test('mesma inspeção pontua igual na importação do CVS e no Lançamento 360', async () => {
  const db = new fake.FakeFirestore();
  window.db = db;
  fake.congelarRelogio(Date.UTC(2026, 10, 3, 12));
  const inspCnae = ['CONTROLE;VISITA_CTRL;SUBCLASSE']
    .concat(CASOS.flatMap((c, i) => (c.extras || []).map((x, j) => `${i}${j};${c.ctrl};${x}`))).join('\n');
  servir([CAB, ...CASOS.map(linhaCsv)].join('\n'), inspCnae);
  await importarInspecoesVISA({
    fiscalEmail: null, mes: MES, ano: ANO, allFiscais: FISCAIS,
    onProgress: silencioso, onProgressBar: silencioso,
  });
  const importados = db.todos('manuais');
  const cnaeMap = await insp360CarregarCnaeMap();

  for (const c of CASOS) {
    const insp = formulario(c);
    const calc = await calcularInspecao360(insp, {
      cnaeMap, regraAreaAtiva: true, resolverArea: insp360ResolverAreaRegulado,
    });
    const doCvs = importados.filter(d => d.visa_controle === String(c.ctrl))
      .map(recorte).sort((x, y) => (x.fiscal_email + x.visa_cnae).localeCompare(y.fiscal_email + y.visa_cnae));
    const do360 = calc.porFiscal.flatMap(f => f.lancamentos.map(l =>
      recorte(montarDocLancamento360('360-2026-00001', insp, calc, f, l))))
      .sort((x, y) => (x.fiscal_email + x.visa_cnae).localeCompare(y.fiscal_email + y.visa_cnae));
    assert.deepEqual(do360, doCvs, `CONTROLE ${c.ctrl}`);
  }
  // Sanidade do cenário: os casos exercitam de fato as regras.
  const p = (ctrl, f, cnae) => importados.find(d => d.visa_controle === String(ctrl) &&
    d.fiscal_email === f.email && d.visa_cnae === cnae);
  assert.equal(p(2003, A, '5555-5/05').pontos, 16);          // área 150 m²
  assert.equal(p(2004, B, '5555-5/05').pontos, 8);           // área 80 m²
  assert.equal(p(2002, A, '1111-1/01').pontos, 9);           // dupla: média 12 → 9
  assert.equal(p(2002, A, '2222-2/02').pontos, 3);           // dupla: baixa 6 → 3
  assert.equal(p(2010, B, '1111-1/01'), undefined);          // não coube no teto
  assert.equal(p(2010, B, '3333-3/03').pontos, 48);
  assert.equal(p(2005, C, '1111-1/01').status, 'pendente');  // 3º fiscal
  // Não entregue: o CVS não expande os CNAEs extras — pontua só o informado.
  assert.deepEqual(importados.filter(d => d.visa_controle === '2008').map(d => [d.visa_cnae, d.pontos]),
    [['1111-1/01', 12]]);
});

test('regras do dia do fiscal logado: REL alta e plantão manual zeram a vistoria', async () => {
  const db = new fake.FakeFirestore();
  window.db = db;
  servir([CAB].join('\n'), 'CONTROLE;VISITA_CTRL;SUBCLASSE');
  db.semear('manuais', 'rel', { fiscal_email: A.email, mes: MES, ano: ANO, data: '2026-11-16',
    origem: 'insp360', tipo_codigo: 'REL', item_pontuacao: 10, status: 'enviado', pontos: 48 });
  db.semear('manuais', 'plt', { fiscal_email: A.email, mes: MES, ano: ANO, data: '2026-11-17',
    origem: 'manual', tipo_codigo: 'PLT', status: 'enviado', pontos: 48 });
  const cnaeMap = await insp360CarregarCnaeMap();
  const docs = await db_getManuais(A.email, MES, ANO);
  for (const [data, item] of [['2026-11-16', 13], ['2026-11-17', 9]]) {
    const estado = await _getEstadoPontosVisa(new Map(), A.email, MES, ANO, A.nome, docs);
    const insp = { ...formulario(CASOS[0]), data, fiscais: [{ ...A, eh360: true }, { ...B, eh360: true }] };
    const calc = await calcularInspecao360(insp, {
      cnaeMap, usuarioEmail: A.email, estadoPontosUsuario: estado,
    });
    const [fa, fb] = calc.porFiscal;
    assert.equal(fa.lancamentos[0].pontos, 0, `zerado em ${data}`);
    assert.match(fa.lancamentos[0].zeradoMotivo, new RegExp(`item ${item}`));
    assert.equal(fb.lancamentos[0].pontos, 9, 'colega: nominal (dupla)');
    assert.equal(fb.regrasDoDia, false);
  }
});

test('salvar: inspeção + lançamentos só para participantes 360; edição respeita travas', async () => {
  const db = new fake.FakeFirestore();
  window.db = db;
  servir([CAB].join('\n'), 'CONTROLE;VISITA_CTRL;SUBCLASSE');
  const cnaeMap = await insp360CarregarCnaeMap();
  const ctx = { cnaeMap, regraAreaAtiva: true, resolverArea: insp360ResolverAreaRegulado, usuarioEmail: A.email };
  const insp = {
    ...formulario(CASOS[1]),                                     // dupla com 3 extras
    fiscais: [{ ...A, eh360: true }, { ...B, eh360: false }, { ...C, eh360: true }],
  };
  const calc = await calcularInspecao360(insp, ctx);
  const r = await salvarInspecao360({ insp, calc, existente: null, usuario: A });
  assert.equal(r.numero, '360-2026-00001');
  const manuais = db.todos('manuais');
  assert.ok(manuais.every(m => m.origem === 'insp360' && m.motivo_os === 'TRANSIÇÃO 360' && m.prazo_os === null));
  assert.deepEqual([...new Set(manuais.map(m => m.fiscal_email))].sort(), [A.email, C.email]);  // B fica com o CVS
  assert.ok(manuais.filter(m => m.fiscal_email === C.email).every(m => m.status === 'pendente')); // 3º fiscal
  assert.ok(manuais.every(m => m.qtd_fiscais === 3 || m.complexidade === 'alta'));
  const insp360 = await db_getInsp360(r.numero);
  assert.deepEqual(insp360.editores, [A.email, C.email]);
  assert.equal((await db_getInsp360Fiscal(C.email, MES, ANO)).length, 1);
  assert.equal((await db_getInsp360Fiscal(B.email, MES, ANO)).length, 0);

  // Gestor homologa um lançamento da Ana; Ana tira um CNAE extra e corrige o nº.
  const homologado = manuais.find(m => m.fiscal_email === A.email && m.visa_cnae === '1111-1/01');
  db._col('manuais').set(homologado.id, { ...db._col('manuais').get(homologado.id), status: 'aceito' });
  const insp2 = { ...insp, numeroDoc: '999', cnaesExtras: ['2222-2/02'] };
  const calc2 = await calcularInspecao360(insp2, ctx);
  const r2 = await salvarInspecao360({ insp: insp2, calc: calc2, existente: insp360, usuario: A });
  assert.equal(r2.numero, r.numero);
  assert.equal(r2.preservados.length, 1);
  const depois = db.todos('manuais');
  assert.equal(db._col('manuais').get(homologado.id).status, 'aceito');
  assert.equal(db._col('manuais').get(homologado.id).numero, '1' + CASOS[1].ctrl, 'travado: intocado');
  assert.ok(!depois.some(m => m.visa_cnae === '6666-6/06'), 'CNAE retirado: lançamentos removidos');
  assert.ok(depois.filter(m => m.id !== homologado.id).every(m => m.numero === '999'));

  // Exclusão bloqueada enquanto houver lançamento travado.
  await assert.rejects(excluirInspecao360(await db_getInsp360(r.numero)), /aceito/);
  db._col('manuais').set(homologado.id, { ...db._col('manuais').get(homologado.id), status: 'enviado' });
  const n = await excluirInspecao360(await db_getInsp360(r.numero));
  assert.equal(n, depois.length);
  assert.equal(db.todos('manuais').length, 0);
  assert.equal(await db_getInsp360(r.numero), null);
});

test('origem insp360 nas regras de não cumulatividade', () => {
  const plt360 = { origem: 'insp360', tipo_codigo: 'PLT', status: 'enviado' };
  const vis360 = { origem: 'insp360', tipo_codigo: 'VIS', status: 'enviado' };
  const rel360 = { origem: 'insp360', tipo_codigo: 'REL', item_pontuacao: 10, status: 'enviado' };
  assert.equal(ehPlantaoManual(plt360), false, 'PRORROGAÇÃO do 360 não é plantão manual');
  assert.equal(ehAtividadeDiaInteiroManual(plt360), false);
  assert.equal(ehOpfManual({ ...plt360, tipo_codigo: 'OPF' }), false);
  assert.equal(ehVistoriaQualquer(vis360), true);
  assert.equal(ehRelAltaImportada(rel360), true);
  assert.equal(ehPlantaoManual({ origem: 'manual', tipo_codigo: 'PLT', status: 'enviado' }), true);
});

test('Conferência: duplicidade CVS × 360 pela mesma inspeção', () => {
  const base = { fiscal_email: A.email, data: '2026-11-05', codigo: 'R1', visa_cnae: '1111-1/01', status: 'enviado' };
  const lista = [
    { ...base, id: 'cvs', origem: 'visa_csv' },
    { ...base, id: 'i360', origem: 'insp360' },
    { ...base, id: 'outro_cnae', origem: 'insp360', visa_cnae: '2222-2/02' },
    { ...base, id: 'outro_fiscal', origem: 'visa_csv', fiscal_email: B.email },
  ];
  assert.deepEqual([...idsDuplicidade360(lista)].sort(), ['cvs', 'i360']);
  // Resolvida pelo gestor (um recusado): sem alerta.
  lista[0].status = 'recusado';
  assert.equal(idsDuplicidade360(lista).size, 0);
});

test('validação para salvar: tudo o que a chefia confere precisa estar informado', async () => {
  servir([CAB].join('\n'), 'CONTROLE;VISITA_CTRL;SUBCLASSE');
  const cnaeMap = await insp360CarregarCnaeMap();
  const ctx = { cnaeMap, hoje: '2026-11-30', usuarioEmail: A.email };
  const ok = {
    codigo: 'R1', data: '2026-11-04', documento: 'TERMO DE INTIMAÇÃO', numeroDoc: '127236',
    entregue: true, cnae: '1111-1/01', cnaesExtras: ['2222-2/02'],
    fiscais: [{ ...A, eh360: true }, { ...B, eh360: false }],
  };
  const campos = (insp) => validarInspecao360(insp, ctx).map(e => e.campo);
  assert.deepEqual(campos(ok), []);

  // Nº obrigatório em TODO documento lavrado…
  assert.deepEqual(campos({ ...ok, numeroDoc: '' }), ['f-numero-doc']);
  assert.deepEqual(campos({ ...ok, numeroDoc: '   ' }), ['f-numero-doc']);
  assert.deepEqual(campos({ ...ok, documento: 'CERTIDÃO', numeroDoc: '' }), ['f-numero-doc']);
  // …em qualquer formato (a numeração do 360 não é a do talão do CVS).
  assert.deepEqual(campos({ ...ok, numeroDoc: '360/2026-15' }), []);
  assert.deepEqual(campos({ ...ok, numeroDoc: '7' }), []);
  // Demais campos.
  assert.deepEqual(campos({ ...ok, codigo: '' }), ['f-regulado-busca']);
  assert.deepEqual(campos({ ...ok, data: '' }), ['f-data']);
  assert.deepEqual(campos({ ...ok, data: '2026-12-01' }), ['f-data']);           // futura
  assert.deepEqual(campos({ ...ok, data: '2026-03-31' }), ['f-data']);           // antes de abr/2026
  assert.deepEqual(campos({ ...ok, data: '2026-10-31' }), ['f-data']);           // outubro (fechado)
  assert.deepEqual(campos({ ...ok, data: '2026-11-02' }), ['f-data']);           // véspera do início
  assert.deepEqual(campos({ ...ok, data: '2026-11-03' }), []);                   // início da Transição 360
  assert.deepEqual(campos({ ...ok, documento: '' }), ['f-documento']);
  assert.deepEqual(campos({ ...ok, entregue: null }), ['f-entregue']);
  assert.deepEqual(campos({ ...ok, cnae: '' }), ['f-cnae']);
  assert.deepEqual(campos({ ...ok, cnae: '1234-5/67' }), ['f-cnae']);           // fora da tabela
  assert.deepEqual(campos({ ...ok, cnaesExtras: ['8888-8/88'] }), ['f-cnae-extra']);
  assert.deepEqual(campos({ ...ok, fiscais: [] }), ['fiscais-linhas']);
  assert.deepEqual(campos({ ...ok, fiscais: [{ ...B, eh360: false }] }), ['fiscais-linhas']); // sem o logado
  assert.deepEqual(campos({ ...ok, fiscais: [{ ...A, eh360: true }, { ...A, eh360: true }] }), ['fiscais-linhas']);
});

// ── Revalidação do mês com lançamentos 360 (regras do dia dos colegas) ──
test('revalidação: regras do dia aplicadas aos lançamentos 360 igual ao CSV', async () => {
  const db = new fake.FakeFirestore();
  window.db = db;
  servir([CAB].join('\n'), 'CONTROLE;VISITA_CTRL;SUBCLASSE');
  const vis360 = (id, data, extra) => db.semear('manuais', id, {
    fiscal_email: B.email, fiscal_nome: B.nome, mes: MES, ano: ANO, data,
    origem: 'insp360', controle: '360-2026-00009', tipo_codigo: 'VIS', item_pontuacao: 2,
    status: 'enviado', pontos: 9, pontos_nominal: 9, qtd_fiscais: 2,
    dispositivo_legal_nominal: 'Item 2 + E.2', dispositivo_legal: 'Item 2 + E.2', ...(extra || {}),
  });
  vis360('v_plt', '2026-11-05');                         // colega com plantão manual no dia
  vis360('v_esc', '2026-11-06');                         // colega escalado pela gerência
  vis360('v_ocr', '2026-11-07');                         // dia coberto por ocorrência aceita
  vis360('v_ok1', '2026-11-10'); vis360('v_ok2', '2026-11-10');   // duas vistorias: acumulam
  vis360('v_hom', '2026-11-11', { status: 'aceito', pontos_homologado: 9 }); // homologado em conflito
  db.semear('manuais', 'plt5', { fiscal_email: B.email, mes: MES, ano: ANO, data: '2026-11-05',
    origem: 'manual', tipo_codigo: 'PLT', status: 'enviado', pontos: 48 });
  db.semear('manuais', 'opf11', { fiscal_email: B.email, mes: MES, ano: ANO, data: '2026-11-11',
    origem: 'manual', tipo_codigo: 'OPF', status: 'enviado', pontos: 48 });
  db.semear('ocorrencias', 'o1', { fiscal_email: B.email, mes: MES, ano: ANO, status: 'aceito',
    data_inicio: '2026-11-07', data_fim: '2026-11-07', tipo: 'ferias' });
  const escalaOrig = window.datasEscaladoNoMes;
  window.datasEscaladoNoMes = async (nome) => new Set(nome === B.nome ? ['2026-11-06'] : []);
  const doc = (id) => db._col('manuais').get(id);
  try {
    const r = await revalidarMesVISA({ mes: MES, ano: ANO });
    assert.equal(doc('v_plt').pontos, 0);
    assert.match(doc('v_plt').zerado_motivo, /plantão fiscal manual/);
    assert.equal(doc('v_esc').pontos, 0);
    assert.match(doc('v_esc').zerado_motivo, /escalado/);
    assert.equal(doc('v_ocr'), undefined, 'dia de ocorrência: o CSV nem criaria — excluído');
    assert.equal(doc('v_ok1').pontos, 9); assert.equal(doc('v_ok2').pontos, 9);
    assert.equal(doc('v_hom').status, 'enviado', 'homologado em conflito é reaberto');
    assert.equal(doc('v_hom').pontos, 0);
    assert.equal(r.excluidos_360, 1);
    assert.equal(db.todos('visa_import_locks').length, 0, 'lock liberado');

    // Gerente decide homologar com pontos mesmo assim (discricionário): fica.
    db._col('manuais').set('v_hom', { ...doc('v_hom'), status: 'aceito', pontos_homologado: 9 });
    // O colega apaga o plantão: a vistoria volta a pontuar (o CSV recalcularia).
    db._col('manuais').delete('plt5');
    window.datasEscaladoNoMes = async () => new Set();
    const r2 = await revalidarMesVISA({ mes: MES, ano: ANO });
    assert.equal(doc('v_plt').pontos, 9);
    assert.equal(doc('v_plt').zerado_motivo, null);
    assert.equal(doc('v_plt').dispositivo_legal, 'Item 2 + E.2');
    assert.equal(doc('v_esc').pontos, 9, 'saiu da escala: volta a pontuar');
    assert.equal(doc('v_hom').status, 'aceito', 'decisão do gerente preservada');
    assert.equal(doc('v_hom').pontos_homologado, 9);
    assert.equal(r2.restaurados_360, 2);
    assert.equal(r2.reabertos_incompat, 0);
  } finally {
    window.datasEscaladoNoMes = escalaOrig;
  }
});

test('lançamento 360 grava a pontuação nominal (base para devolver os pontos)', async () => {
  const db = new fake.FakeFirestore();
  window.db = db;
  servir([CAB].join('\n'), 'CONTROLE;VISITA_CTRL;SUBCLASSE');
  db.semear('manuais', 'plt', { fiscal_email: A.email, mes: MES, ano: ANO, data: '2026-11-17',
    origem: 'manual', tipo_codigo: 'PLT', status: 'enviado', pontos: 48 });
  const cnaeMap = await insp360CarregarCnaeMap();
  const estado = await _getEstadoPontosVisa(new Map(), A.email, MES, ANO, A.nome, await db_getManuais(A.email, MES, ANO));
  const insp = { ...formulario(CASOS[0]), data: '2026-11-17', fiscais: [{ ...A, eh360: true }] };
  const calc = await calcularInspecao360(insp, { cnaeMap, usuarioEmail: A.email, estadoPontosUsuario: estado });
  const d = montarDocLancamento360('360-2026-00001', insp, calc, calc.porFiscal[0], calc.porFiscal[0].lancamentos[0]);
  assert.equal(d.pontos, 0);
  assert.equal(d.pontos_nominal, 12);
  assert.match(d.dispositivo_legal_nominal, /Item 2/);
});

test('salvar e excluir no 360 marcam insp360_sequencia/rev (dispara a revalidação)', async () => {
  const db = new fake.FakeFirestore();
  window.db = db;
  servir([CAB].join('\n'), 'CONTROLE;VISITA_CTRL;SUBCLASSE');
  const cnaeMap = await insp360CarregarCnaeMap();
  assert.equal(await db_getRevisaoInsp360(), null);
  fake.congelarRelogio(Date.UTC(2026, 10, 5, 12));
  const insp = { ...formulario(CASOS[0]), data: '2026-11-05', fiscais: [{ ...A, eh360: true }] };
  const calc = await calcularInspecao360(insp, { cnaeMap });
  const r = await salvarInspecao360({ insp, calc, existente: null, usuario: A });
  const rev1 = await db_getRevisaoInsp360();
  assert.ok(rev1 > 0);
  assert.equal(db._col('insp360_sequencia').get('rev').por, A.email);
  fake.congelarRelogio(Date.UTC(2026, 10, 5, 13));
  await excluirInspecao360(await db_getInsp360(r.numero));
  assert.ok((await db_getRevisaoInsp360()) > rev1);
});

test('importação automática: 360 mudou e CSVs não → só a revalidação do mês', async () => {
  vm.runInThisContext(fs.readFileSync(path.join(RAIZ, 'js/visa-auto-import.js'), 'utf8'),
    { filename: 'js/visa-auto-import.js' });
  const db = new fake.FakeFirestore();
  window.db = db;
  const shas = { 'data/inspecoes.csv': 'aaa', 'data/cnae.csv': 'bbb' };
  window.fetchGitHubDirBlobShas = async () => shas;
  const compOrig = window.db_getProximaCompetencia;
  window.db_getProximaCompetencia = async () => ({ mes: MES, ano: ANO });
  const importOrig = window.importarInspecoesVISA;
  let importou = 0;
  window.importarInspecoesVISA = async () => { importou++; return {}; };
  try {
    db.semear('app_config', 'import_state', { visa: { blob_shas: shas, mes: MES, ano: ANO }, insp360_rev: 1000 });
    db.semear('manuais', 'v360', { fiscal_email: B.email, fiscal_nome: B.nome, mes: MES, ano: ANO,
      data: '2026-11-05', origem: 'insp360', controle: '360-2026-00001', tipo_codigo: 'VIS',
      item_pontuacao: 2, status: 'enviado', pontos: 9, pontos_nominal: 9 });
    db.semear('manuais', 'plt', { fiscal_email: B.email, mes: MES, ano: ANO, data: '2026-11-05',
      origem: 'manual', tipo_codigo: 'PLT', status: 'enviado', pontos: 48 });
    const admin = { perfil: 'Administrador', email: 'gestor@teste', nome: 'Gestor' };

    // Marca do 360 igual à já revalidada: nada a fazer.
    fake.congelarRelogio(1000);
    db.semear('insp360_sequencia', 'rev', { em: firebase.firestore.FieldValue.serverTimestamp(), por: A.email });
    await verificarEImportarVISA(admin);
    assert.equal(db._col('manuais').get('v360').pontos, 9);

    // Fiscal salvou no 360 depois: revalida o mês, sem reimportar o CSV.
    fake.congelarRelogio(5000);
    db.semear('insp360_sequencia', 'rev', { em: firebase.firestore.FieldValue.serverTimestamp(), por: A.email });
    await verificarEImportarVISA(admin);
    assert.equal(importou, 0, 'não reimporta o CSV');
    assert.equal(db._col('manuais').get('v360').pontos, 0, 'regra do dia aplicada ao colega');
    const st = db._col('app_config').get('import_state');
    assert.equal(st.insp360_rev, 5000);
    assert.equal(st.runs.at(-1).tipo, 'revalida_360');

    // Próximo ciclo sem novidade: não roda de novo.
    db._col('manuais').set('v360', { ...db._col('manuais').get('v360'), pontos: 7 });
    await verificarEImportarVISA(admin);
    assert.equal(db._col('manuais').get('v360').pontos, 7);
  } finally {
    window.db_getProximaCompetencia = compOrig;
    window.importarInspecoesVISA = importOrig;
  }
});
