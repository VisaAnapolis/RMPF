// js/plantao-escala.js
// Leitura da escala de plantão fiscal gerenciada no site VISA.
//
// RMPF e VISA compartilham o MESMO projeto Firebase (visam-3a30b); a escala
// fica na coleção `plantao` (1 documento por mês, id "AAAA-MM") e as regras
// do Firestore liberam a leitura a qualquer usuário autenticado. Cada item de
// `dias[]` traz os fiscais escalados por NOME COMPLETO nos campos `matutino`,
// `vespertino` (strings) e `integral` (array) — por isso o match usa a mesma
// normalização de nome do pipeline de importação (acentos/caixa/espaços).
//
// Política fail-open (decisão de 03/07/2026, docs/validacao-escala-plantao.md):
// mês sem escala publicada ou falha de leitura NÃO bloqueia nem zera nada;
// as validações só agem quando a escala do mês existe. Dia ausente do array
// `dias[]` de uma escala publicada conta como "ninguém escalado".

// Cache por mês (só resultados de leitura bem-sucedida; erro não é cacheado
// para permitir nova tentativa na próxima chamada).
const _escalaMesCache = new Map(); // mesKey -> { ok:true, doc:Object|null }

function _normNomeEscala(v) {
  return String(v || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

// Lê plantao/AAAA-MM. Retorna { ok:true, doc } (doc = null quando o mês não
// tem escala publicada) ou { ok:false, doc:null } em erro de leitura.
async function db_getEscalaMes(mesKey) {
  if (_escalaMesCache.has(mesKey)) return _escalaMesCache.get(mesKey);
  try {
    const snap = await window.db.collection('plantao').doc(mesKey).get();
    const res = { ok: true, doc: snap.exists ? snap.data() : null };
    _escalaMesCache.set(mesKey, res);
    return res;
  } catch (e) {
    console.warn('[Escala] Falha ao ler plantao/' + mesKey + ':', e);
    return { ok: false, doc: null };
  }
}

// Nomes (normalizados) escalados em um dia da escala, somando os três turnos.
function _escaladosDoDia(dia) {
  const nomes = [];
  if (dia) {
    if (dia.matutino)   nomes.push(dia.matutino);
    if (dia.vespertino) nomes.push(dia.vespertino);
    (Array.isArray(dia.integral) ? dia.integral : []).forEach(n => { if (n) nomes.push(n); });
  }
  return nomes.map(_normNomeEscala).filter(Boolean);
}

// Situação do fiscal na escala em uma data:
//   { status: 'escalado' }     — o nome consta na data (qualquer turno);
//   { status: 'nao_escalado' } — a escala do mês existe e o nome não consta;
//   { status: 'sem_escala' }   — mês sem escala publicada, erro de leitura ou
//                                parâmetros ausentes → chamadores aplicam fail-open.
async function fiscalEscaladoNoDia(nomeFiscal, dataISO) {
  if (!nomeFiscal || !dataISO) return { status: 'sem_escala' };
  const mesKey = String(dataISO).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(mesKey)) return { status: 'sem_escala' };
  const res = await db_getEscalaMes(mesKey);
  if (!res.ok || !res.doc) return { status: 'sem_escala' };
  const dia = (res.doc.dias || []).find(d => d && d.date === dataISO);
  return _escaladosDoDia(dia).includes(_normNomeEscala(nomeFiscal))
    ? { status: 'escalado' }
    : { status: 'nao_escalado' };
}

// Set de datas (yyyy-mm-dd) do mês em que o fiscal está escalado. Retorna Set
// vazio quando o mês não tem escala ou em erro de leitura (fail-open: sem
// escala confirmada, nenhuma vistoria é zerada por escala na importação).
async function datasEscaladoNoMes(nomeFiscal, mes, ano) {
  const s = new Set();
  if (!nomeFiscal || !mes || !ano) return s;
  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
  const res = await db_getEscalaMes(mesKey);
  if (!res.ok || !res.doc) return s;
  const alvo = _normNomeEscala(nomeFiscal);
  for (const dia of (res.doc.dias || [])) {
    if (dia && dia.date && _escaladosDoDia(dia).includes(alvo)) s.add(dia.date);
  }
  return s;
}

// Nome cadastrado do fiscal (coleção `usuarios`, doc = e-mail), com cache.
// Usado quando o chamador só tem o e-mail (ex.: revalidação na homologação).
const _nomeFiscalCache = new Map();
async function nomeFiscalPorEmail(email) {
  if (!email) return null;
  if (_nomeFiscalCache.has(email)) return _nomeFiscalCache.get(email);
  let nome = null;
  try {
    const snap = await window.db.collection('usuarios').doc(email).get();
    if (snap.exists) nome = (snap.data() || {}).nome || null;
  } catch (e) {
    console.warn('[Escala] Falha ao resolver nome do fiscal ' + email + ':', e);
    return null; // não cacheia erro
  }
  _nomeFiscalCache.set(email, nome);
  return nome;
}

window.db_getEscalaMes     = db_getEscalaMes;
window.fiscalEscaladoNoDia = fiscalEscaladoNoDia;
window.datasEscaladoNoMes  = datasEscaladoNoMes;
window.nomeFiscalPorEmail  = nomeFiscalPorEmail;
