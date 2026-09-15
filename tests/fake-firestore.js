// tests/fake-firestore.js
// Firestore "compat" FALSO, em memória, com a superfície mínima que js/firestore.js
// usa: collection().doc().get/set/update/delete, collection().add,
// where()/orderBy()/limit()/get(), db.batch() e db.runTransaction().
// Serve para exercitar o código real do RMPF em Node, sem tocar no projeto
// Firebase de produção. Só o operador '==' é implementado no where().

'use strict';

let _seq = 0;
function novoId() { _seq += 1; return `fake${String(_seq).padStart(5, '0')}`; }

class FakeTimestamp {
  constructor(ms) { this._ms = ms; }
  toMillis() { return this._ms; }
  toDate() { return new Date(this._ms); }
}

let _relogio = null; // permite congelar "serverTimestamp" nos testes
const ServerTimestamp = { __serverTimestamp: true };

function resolverSentinelas(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[k] = (v && v.__serverTimestamp) ? new FakeTimestamp(_relogio != null ? _relogio : Date.now()) : v;
  }
  return out;
}

class DocSnapshot {
  constructor(id, data) { this.id = id; this._data = data; }
  get exists() { return this._data !== undefined; }
  data() { return this._data === undefined ? undefined : { ...this._data }; }
}

class QuerySnapshot {
  constructor(docs) { this.docs = docs; }
  get empty() { return this.docs.length === 0; }
  get size() { return this.docs.length; }
  forEach(fn) { this.docs.forEach(fn); }
}

class DocRef {
  constructor(db, col, id) { this._db = db; this._col = col; this.id = id; }
  _store() { return this._db._col(this._col); }
  async get() { return new DocSnapshot(this.id, this._store().get(this.id)); }
  async set(data, opts) {
    const atual = this._store().get(this.id);
    const novo = resolverSentinelas(data);
    this._store().set(this.id, (opts && opts.merge && atual) ? { ...atual, ...novo } : novo);
  }
  async update(data) {
    const atual = this._store().get(this.id);
    if (atual === undefined) throw new Error(`update em doc inexistente: ${this._col}/${this.id}`);
    this._store().set(this.id, { ...atual, ...resolverSentinelas(data) });
  }
  async delete() { this._store().delete(this.id); }
  collection(nome) { return new ColRef(this._db, `${this._col}/${this.id}/${nome}`); }
}

class Query {
  constructor(db, col, filtros, ordem, limite) {
    this._db = db; this._col = col;
    this._filtros = filtros || []; this._ordem = ordem || []; this._limite = limite || null;
  }
  where(campo, op, valor) {
    if (op !== '==') throw new Error(`fake-firestore: operador não suportado: ${op}`);
    return new Query(this._db, this._col, [...this._filtros, [campo, valor]], this._ordem, this._limite);
  }
  orderBy(campo, dir) { return new Query(this._db, this._col, this._filtros, [...this._ordem, [campo, dir || 'asc']], this._limite); }
  limit(n) { return new Query(this._db, this._col, this._filtros, this._ordem, n); }
  async get() {
    let docs = [...this._db._col(this._col).entries()]
      .filter(([, d]) => this._filtros.every(([c, v]) => d[c] === v))
      .map(([id, d]) => new DocSnapshot(id, d));
    for (const [campo, dir] of [...this._ordem].reverse()) {
      docs.sort((a, b) => {
        const x = a._data[campo], y = b._data[campo];
        const vx = (x && x.toMillis) ? x.toMillis() : x;
        const vy = (y && y.toMillis) ? y.toMillis() : y;
        const r = vx < vy ? -1 : vx > vy ? 1 : 0;
        return dir === 'desc' ? -r : r;
      });
    }
    if (this._limite) docs = docs.slice(0, this._limite);
    return new QuerySnapshot(docs);
  }
}

class ColRef extends Query {
  constructor(db, col) { super(db, col); }
  doc(id) { return new DocRef(this._db, this._col, id || novoId()); }
  async add(data) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

class Batch {
  constructor() { this._ops = []; }
  set(ref, data, opts) { this._ops.push(() => ref.set(data, opts)); return this; }
  update(ref, data) { this._ops.push(() => ref.update(data)); return this; }
  delete(ref) { this._ops.push(() => ref.delete()); return this; }
  async commit() { for (const op of this._ops) await op(); }
}

class Transaction {
  constructor() { this._writes = []; }
  async get(ref) { return ref.get(); }
  set(ref, data, opts) { this._writes.push(() => ref.set(data, opts)); return this; }
  update(ref, data) { this._writes.push(() => ref.update(data)); return this; }
  delete(ref) { this._writes.push(() => ref.delete()); return this; }
}

class FakeFirestore {
  constructor() { this._dados = new Map(); }
  _col(nome) {
    if (!this._dados.has(nome)) this._dados.set(nome, new Map());
    return this._dados.get(nome);
  }
  collection(nome) { return new ColRef(this, nome); }
  batch() { return new Batch(); }
  async runTransaction(fn) {
    const tx = new Transaction();
    const r = await fn(tx);          // lança → nada é gravado (como no Firestore)
    for (const w of tx._writes) await w();
    return r;
  }
  // ── utilidades de teste ──
  limpar() { this._dados.clear(); }
  todos(col) { return [...this._col(col).entries()].map(([id, d]) => ({ id, ...d })); }
  semear(col, id, data) { this._col(col).set(id, resolverSentinelas(data)); }
}

// Global `firebase` como o SDK compat expõe, no que o código usa.
const firebase = {
  firestore: Object.assign(function () { throw new Error('use window.db'); }, {
    FieldValue: { serverTimestamp: () => ServerTimestamp },
    Timestamp: {
      fromMillis: ms => new FakeTimestamp(ms),
      fromDate: d => new FakeTimestamp(d.getTime()),
      now: () => new FakeTimestamp(Date.now()),
    },
  }),
};

module.exports = {
  FakeFirestore, FakeTimestamp, firebase,
  congelarRelogio(ms) { _relogio = ms; },
  descongelarRelogio() { _relogio = null; },
};
