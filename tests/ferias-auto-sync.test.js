// tests/ferias-auto-sync.test.js
// Testa a sincronização da escala de férias do VISA (js/ferias-auto-sync.js)
// carregando o CÓDIGO REAL do RMPF (utils.js, firestore.js, ferias-auto-sync.js)
// sobre o Firestore falso em memória de js/fake-firestore.js.
//
// Rodar: `node --test tests/` (Node ≥ 20, sem dependências).
//
// Cobertura: mapa obs→tipo (Férias e "Licença-prêmio anterior LC 548" viram
// ocorrência; "Licença-prêmio" comum é ignorada), corte na competência aberta,
// auto-aceite com rateio real (1000 ÷ dias úteis), dispositivo legal por tipo,
// idempotência por watermark, espelhamento ao trocar o tipo no VISA, bloqueio
// quando o dia já tem lançamento e o lock distribuído.

'use strict';
process.env.TZ = 'America/Sao_Paulo';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

const fake = require('../js/fake-firestore.js');
const RAIZ = path.resolve(__dirname, '..');

// ── Ambiente de navegador mínimo ──
global.window = global;
global.firebase = fake.firebase;
// Elemento DOM permissivo: utils.js liga listeners e mexe em elementos ao
// carregar; aqui tudo é aceito e nada é renderizado.
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
  getElementById: () => el(),
  createElement: () => el(),
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
// O toast do sync agenda um setTimeout de 12 s; sem unref o processo do teste
// ficaria vivo esperando por ele.
const _setTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => { const t = _setTimeout(fn, ms, ...args); if (t && t.unref) t.unref(); return t; };

const _info = console.info, _warn = console.warn;
console.info = () => {}; console.warn = () => {};

for (const f of ['js/utils.js', 'js/firestore.js', 'js/ferias-auto-sync.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(RAIZ, f), 'utf8'), { filename: f });
}
console.info = _info; console.warn = _warn;

// ── Cenário base ──
const ADMIN = { email: 'admin@teste', nome: 'Admin', perfil: 'Administrador' };
const A = { email: 'a@teste', nome: 'Ana Alves' };
const B = { email: 'b@teste', nome: 'Bruno Braga' };
const C = { email: 'c@teste', nome: 'Carla Costa' };

const T1 = Date.UTC(2026, 8, 1); // watermark inicial da escala
const T2 = T1 + 60_000;

// Outubro/2026: 22 dias de semana − 12/10 (feriado nacional) = 21 dias úteis,
// sem feriado municipal no CSV. Taxa = round2(1000 / 21).
const DIAS_UTEIS_OUT = 21;
const TAXA_OUT = Math.round((1000 / DIAS_UTEIS_OUT) * 100) / 100; // 47.62
const DISPOSITIVO_LP = 'Licença-prêmio com período concessivo anterior à Lei Complementar nº 548/2023 — direito adquirido ao pagamento da produtividade';

let db;
function escala(periodos, watermark) {
  db.semear('ferias', 'escala', { periodos, updatedAt: new fake.FakeTimestamp(watermark), updatedBy: 'master@visa' });
}
function ocorrenciasDe(email) { return db.todos('ocorrencias').filter(o => o.fiscal_email === email); }
function manuaisDe(email, origem) {
  return db.todos('manuais').filter(m => m.fiscal_email === email && (!origem || m.origem === origem));
}
async function sincronizar() { return window.verificarESincronizarFerias(ADMIN); }

beforeEach(() => {
  db = new fake.FakeFirestore();
  window.db = db;
  for (const f of [A, B, C]) db.semear('usuarios', f.email, { email: f.email, nome: f.nome, perfil: 'Fiscal', ativo: true });
  db.semear('app_config', 'competencia_aberta', { mes: 10, ano: 2026 });
});

test('Férias que cruzam meses: só a fatia da competência aberta, aceita e rateada', async () => {
  escala([{ nome: A.nome, inicio: '2026-09-15', fim: '2026-10-14', obs: 'Férias' }], T1);
  const r = await sincronizar();
  assert.deepEqual({ criadas: r.criadas, aceitas: r.aceitas, removidas: r.removidas, ignorados: r.ignorados },
                   { criadas: 1, aceitas: 1, removidas: 0, ignorados: 0 });

  const [o] = ocorrenciasDe(A.email);
  assert.equal(ocorrenciasDe(A.email).length, 1);
  assert.equal(o.tipo, 'ferias');
  assert.equal(o.status, 'aceito');
  assert.equal(o.origem, 'ferias_visa');
  assert.equal(o.data_inicio, '2026-10-01');
  assert.equal(o.data_fim, '2026-10-14');
  assert.equal(o.mes, 10); assert.equal(o.ano, 2026);
  assert.equal(o.dispositivo_legal, 'Art. 11, inciso I, da Lei Complementar nº 548/2023');
  assert.match(o.descricao, /^Férias — sincronizado automaticamente do VISA$/);

  // 01–14/10/2026: dias úteis = 1,2,5,6,7,8,9,13,14 (12/10 é feriado) → 9
  const ms = manuaisDe(A.email, 'ocorrencia');
  assert.equal(ms.length, 9);
  for (const m of ms) {
    assert.equal(m.pontos, TAXA_OUT);
    assert.equal(m.pontos_homologado, TAXA_OUT);
    assert.equal(m.status, 'homologado');
    assert.equal(m.tipo_codigo, 'OCR');
    assert.equal(m.ocorrencia_id, o.id);
    assert.equal(m.dispositivo_legal, 'Art. 11, inciso I, da Lei Complementar nº 548/2023');
    assert.match(m.descricao, /Ocorrência: Férias — sincronizada automaticamente do VISA \(1000 pts ÷ 21 dias úteis/);
  }
  assert.ok(!ms.some(m => m.data === '2026-10-12'), 'feriado de 12/10 não gera OCR');
  assert.ok(!ms.some(m => m.data < '2026-10-01'), 'setembro (fechado) não é tocado');
});

test('"Licença-prêmio anterior LC 548" vira ocorrência própria com o mesmo rateio das férias', async () => {
  escala([{ nome: B.nome, inicio: '2026-10-05', fim: '2026-10-23', obs: 'Licença-prêmio anterior LC 548' }], T1);
  const r = await sincronizar();
  assert.equal(r.criadas, 1); assert.equal(r.aceitas, 1); assert.equal(r.ignorados, 0);

  const [o] = ocorrenciasDe(B.email);
  assert.equal(o.tipo, 'licenca_premio_pre_lc548');
  assert.equal(o.status, 'aceito');
  assert.equal(o.dispositivo_legal, DISPOSITIVO_LP);
  assert.equal(o.descricao, 'Licença-prêmio anterior à LC 548 — sincronizado automaticamente do VISA');

  // 05–23/10: 5-9 (5) + 13-16 (4, sem 12/10) + 19-23 (5) = 14 dias úteis
  const ms = manuaisDe(B.email, 'ocorrencia');
  assert.equal(ms.length, 14);
  assert.ok(ms.every(m => m.pontos === TAXA_OUT), 'mesma taxa diária das férias');
  assert.ok(ms.every(m => m.dispositivo_legal === DISPOSITIVO_LP));
  assert.match(ms[0].descricao, /^Ocorrência: Licença-prêmio anterior à LC 548 — sincronizada automaticamente do VISA \(/);
  // Soma do mês inteiro nunca passa do teto: 14 × 47,62 < 1000
  const soma = ms.reduce((s, m) => s + m.pontos, 0);
  assert.ok(soma < 1000 && soma > 600, `soma ${soma}`);
});

test('"Licença-prêmio" comum (pós-LC 548) é ignorada: nada criado', async () => {
  escala([{ nome: C.nome, inicio: '2026-10-01', fim: '2026-10-10', obs: 'Licença-prêmio' }], T1);
  const r = await sincronizar();
  assert.equal(r.criadas, 0);
  assert.equal(r.ignorados, 1);
  assert.equal(ocorrenciasDe(C.email).length, 0);
  assert.equal(manuaisDe(C.email).length, 0);
});

test('obs desconhecido também é ignorado; nome sem fiscal no cadastro é reportado', async () => {
  escala([
    { nome: A.nome, inicio: '2026-10-01', fim: '2026-10-02', obs: 'Recesso' },
    { nome: 'Fulano Inexistente', inicio: '2026-10-01', fim: '2026-10-02', obs: 'Férias' },
  ], T1);
  const r = await sincronizar();
  assert.equal(r.criadas, 0);
  assert.equal(r.ignorados, 1);
  assert.equal(r.naoResolvidos, 1);
});

test('Os três tipos juntos: dois sincronizam, um é ignorado; segunda rodada é idempotente', async () => {
  escala([
    { nome: A.nome, inicio: '2026-09-15', fim: '2026-10-14', obs: 'Férias' },
    { nome: B.nome, inicio: '2026-10-05', fim: '2026-10-23', obs: 'Licença-prêmio anterior LC 548' },
    { nome: C.nome, inicio: '2026-10-01', fim: '2026-10-10', obs: 'Licença-prêmio' },
  ], T1);
  const r1 = await sincronizar();
  assert.deepEqual([r1.criadas, r1.aceitas, r1.ignorados], [2, 2, 1]);
  const antesO = db.todos('ocorrencias').length, antesM = db.todos('manuais').length;
  assert.equal(antesO, 2); assert.equal(antesM, 9 + 14);

  // watermark igual e nada pendente → sai cedo sem retorno e sem gravar
  const st = (await window.db_getImportState()).ferias;
  assert.deepEqual([st.watermark, st.mes, st.ano], [T1, 10, 2026]);
  const r2 = await sincronizar();
  assert.equal(r2, undefined);
  assert.equal(db.todos('ocorrencias').length, antesO);
  assert.equal(db.todos('manuais').length, antesM);
  assert.equal(db.todos('ferias_sync_locks').length, 0, 'lock liberado');
});

test('Trocar o tipo no VISA (pré-LC → comum) remove a ocorrência e os pontos; os demais ficam', async () => {
  escala([
    { nome: A.nome, inicio: '2026-09-15', fim: '2026-10-14', obs: 'Férias' },
    { nome: B.nome, inicio: '2026-10-05', fim: '2026-10-23', obs: 'Licença-prêmio anterior LC 548' },
  ], T1);
  await sincronizar();
  const idA = ocorrenciasDe(A.email)[0].id;

  escala([
    { nome: A.nome, inicio: '2026-09-15', fim: '2026-10-14', obs: 'Férias' },
    { nome: B.nome, inicio: '2026-10-05', fim: '2026-10-23', obs: 'Licença-prêmio' },
  ], T2);
  const r = await sincronizar();
  assert.deepEqual([r.criadas, r.removidas, r.ignorados], [0, 1, 1]);
  assert.equal(ocorrenciasDe(B.email).length, 0);
  assert.equal(manuaisDe(B.email).length, 0, 'OCRs de B apagados junto');
  assert.equal(ocorrenciasDe(A.email)[0].id, idA, 'A não foi recriada');
  assert.equal(manuaisDe(A.email, 'ocorrencia').length, 9);
});

test('Trocar o tipo no VISA (Férias → pré-LC 548) recria com o tipo e o dispositivo novos', async () => {
  escala([{ nome: A.nome, inicio: '2026-10-01', fim: '2026-10-09', obs: 'Férias' }], T1);
  await sincronizar();
  const idAntigo = ocorrenciasDe(A.email)[0].id;

  escala([{ nome: A.nome, inicio: '2026-10-01', fim: '2026-10-09', obs: 'Licença-prêmio anterior LC 548' }], T2);
  const r = await sincronizar();
  assert.deepEqual([r.criadas, r.removidas, r.aceitas], [1, 1, 1]);
  const [o] = ocorrenciasDe(A.email);
  assert.notEqual(o.id, idAntigo);
  assert.equal(o.tipo, 'licenca_premio_pre_lc548');
  assert.equal(o.dispositivo_legal, DISPOSITIVO_LP);
  const ms = manuaisDe(A.email, 'ocorrencia');
  assert.equal(ms.length, 7); // 1,2,5,6,7,8,9
  assert.ok(ms.every(m => m.ocorrencia_id === o.id && m.dispositivo_legal === DISPOSITIVO_LP));
});

test('Dia coberto já com outro lançamento: ocorrência fica pendente, sem OCR, e é reportada', async () => {
  db.semear('manuais', 'm-manual', {
    fiscal_email: C.email, fiscal_nome: C.nome, mes: 10, ano: 2026, data: '2026-10-06',
    pontos: 20, status: 'pendente', origem: 'manual', tipo_codigo: 'INS',
  });
  escala([{ nome: C.nome, inicio: '2026-10-01', fim: '2026-10-10', obs: 'Licença-prêmio anterior LC 548' }], T1);
  const r = await sincronizar();
  assert.deepEqual([r.criadas, r.aceitas, r.bloqueadas], [1, 0, 1]);
  const [o] = ocorrenciasDe(C.email);
  assert.equal(o.status, 'pendente');
  assert.equal(manuaisDe(C.email, 'ocorrencia').length, 0);
  assert.equal(manuaisDe(C.email, 'manual').length, 1, 'lançamento manual intacto');

  // Removido o lançamento manual, a próxima rodada aceita a pendente mesmo
  // sem mudança na escala (watermark igual).
  db.collection('manuais').doc('m-manual').delete();
  const r2 = await sincronizar();
  assert.deepEqual([r2.criadas, r2.aceitas], [0, 1]);
  assert.equal(ocorrenciasDe(C.email)[0].status, 'aceito');
  assert.equal(manuaisDe(C.email, 'ocorrencia').length, 7);
});

test('Conflito com ocorrência manual sobreposta: período não é criado', async () => {
  db.semear('ocorrencias', 'ocr-manual', {
    fiscal_email: B.email, fiscal_nome: B.nome, mes: 10, ano: 2026, tipo: 'licenca_medica',
    data_inicio: '2026-10-10', data_fim: '2026-10-12', status: 'pendente', origem: 'manual',
  });
  escala([{ nome: B.nome, inicio: '2026-10-05', fim: '2026-10-23', obs: 'Licença-prêmio anterior LC 548' }], T1);
  const r = await sincronizar();
  assert.deepEqual([r.criadas, r.conflitos], [0, 1]);
  assert.equal(ocorrenciasDe(B.email).length, 1);
  assert.equal(ocorrenciasDe(B.email)[0].id, 'ocr-manual');
});

test('Lock distribuído: recente bloqueia; obsoleto (> 5 min) é sobrescrito', async () => {
  escala([{ nome: A.nome, inicio: '2026-10-01', fim: '2026-10-02', obs: 'Férias' }], T1);

  db.semear('ferias_sync_locks', 'escala', { locked_by: 'outro@admin', locked_at: new fake.FakeTimestamp(Date.now() - 30_000) });
  const r1 = await sincronizar();
  assert.equal(r1, undefined);
  assert.equal(ocorrenciasDe(A.email).length, 0, 'nada gravado com lock ativo');

  db.semear('ferias_sync_locks', 'escala', { locked_by: 'outro@admin', locked_at: new fake.FakeTimestamp(Date.now() - 6 * 60_000) });
  const r2 = await sincronizar();
  assert.equal(r2.criadas, 1);
  assert.equal(db.todos('ferias_sync_locks').length, 0, 'lock liberado ao final');
});

test('Sessão que não é de Administrador não sincroniza', async () => {
  escala([{ nome: A.nome, inicio: '2026-10-01', fim: '2026-10-02', obs: 'Férias' }], T1);
  const r = await window.verificarESincronizarFerias({ ...A, perfil: 'Fiscal' });
  assert.equal(r, undefined);
  assert.equal(ocorrenciasDe(A.email).length, 0);
});

test('Normalização do obs tolera maiúsculas/acentos e espaços extras', async () => {
  escala([
    { nome: A.nome, inicio: '2026-10-01', fim: '2026-10-02', obs: '  FÉRIAS ' },
    { nome: B.nome, inicio: '2026-10-01', fim: '2026-10-02', obs: 'Licenca-Premio  anterior LC 548' },
  ], T1);
  const r = await sincronizar();
  assert.equal(r.criadas, 2);
  assert.equal(ocorrenciasDe(A.email)[0].tipo, 'ferias');
  assert.equal(ocorrenciasDe(B.email)[0].tipo, 'licenca_premio_pre_lc548');
});
