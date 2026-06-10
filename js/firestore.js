// js/firestore.js
// CRUD helpers — all return Promises; set on window.db_*

// ── Manuais ──────────────────────────────────────────────

async function getManuais(fiscalEmail, mes, ano) {
  const snap = await window.db.collection('manuais')
    .where('fiscal_email', '==', fiscalEmail)
    .where('mes', '==', Number(mes))
    .where('ano', '==', Number(ano))
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.data || '').localeCompare(b.data || '') || (a.created_at?.toMillis?.() || 0) - (b.created_at?.toMillis?.() || 0));
}

async function getManuaisTodos(mes, ano) {
  const snap = await window.db.collection('manuais')
    .where('mes', '==', Number(mes))
    .where('ano', '==', Number(ano))
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.created_at?.toMillis?.() || 0) - (b.created_at?.toMillis?.() || 0));
}

async function getManuaisRecusados(fiscalEmail, mes, ano) {
  const snap = await window.db.collection('manuais')
    .where('fiscal_email', '==', fiscalEmail)
    .where('mes', '==', Number(mes))
    .where('ano', '==', Number(ano))
    .where('status', '==', 'recusado')
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function createManual(data) {
  const ref = await window.db.collection('manuais').add({
    ...data,
    created_at: firebase.firestore.FieldValue.serverTimestamp(),
    updated_at: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

async function updateManual(id, data) {
  await window.db.collection('manuais').doc(id).update({
    ...data,
    updated_at: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

async function deleteManual(id) {
  await window.db.collection('manuais').doc(id).delete();
}

// ── Ocorrências ──────────────────────────────────────────

// Maximum number of prior periods to look back when searching for occurrences
// that started in a previous month but extend into the queried period.
// 6 months covers the longest legal absence in the system (maternity leave: up to 180 days).
const _OCR_MAX_LOOKBACK = 6;

/**
 * Returns successive previous periods up to `count` steps back.
 * Used to find occurrences registered in a prior period that span into the
 * requested period (e.g. a medical certificate starting 15 May and ending 15 June
 * is stored with mes=5 but must also appear when querying mes=6).
 */
function _periodosMesAnterior(mes, ano, count) {
  const result = [];
  let m = Number(mes), a = Number(ano);
  for (let i = 0; i < count; i++) {
    m--; if (m === 0) { m = 12; a--; }
    result.push({ mes: m, ano: a });
  }
  return result;
}

/**
 * Merges two arrays of occurrence documents, deduplicating by id, and keeps
 * only cross-period docs (from previous periods) whose data_fim reaches into
 * the requested period (>= first day of mes/ano).
 * NOTE: data_fim is expected to be stored in ISO date string format (YYYY-MM-DD)
 * so that lexicographic string comparison works correctly for date ordering.
 */
function _mergeOcorrs(current, previous, mes, ano) {
  const firstDay = `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}-01`;
  const seen = new Set(current.map(d => d.id));
  const extras = previous.filter(d => !seen.has(d.id) && d.data_fim && d.data_fim >= firstDay);
  return [...current, ...extras]
    .sort((a, b) => (a.created_at?.toMillis?.() || 0) - (b.created_at?.toMillis?.() || 0));
}

async function getOcorrencias(fiscalEmail, mes, ano) {
  // Collect queries for the requested period plus up to _OCR_MAX_LOOKBACK previous
  // periods to capture occurrences that span across competency boundaries.
  const periodos = [{ mes: Number(mes), ano: Number(ano) }, ..._periodosMesAnterior(mes, ano, _OCR_MAX_LOOKBACK)];
  const snaps = await Promise.all(
    periodos.map(p =>
      window.db.collection('ocorrencias')
        .where('fiscal_email', '==', fiscalEmail)
        .where('mes', '==', p.mes)
        .where('ano', '==', p.ano)
        .get()
    )
  );
  const current  = snaps[0].docs.map(d => ({ id: d.id, ...d.data() }));
  const previous = snaps.slice(1).flatMap(s => s.docs.map(d => ({ id: d.id, ...d.data() })));
  return _mergeOcorrs(current, previous, mes, ano);
}

async function getOcorrenciasTodas(mes, ano) {
  // Same cross-period logic without the fiscal_email constraint.
  const periodos = [{ mes: Number(mes), ano: Number(ano) }, ..._periodosMesAnterior(mes, ano, _OCR_MAX_LOOKBACK)];
  const snaps = await Promise.all(
    periodos.map(p =>
      window.db.collection('ocorrencias')
        .where('mes', '==', p.mes)
        .where('ano', '==', p.ano)
        .get()
    )
  );
  const current  = snaps[0].docs.map(d => ({ id: d.id, ...d.data() }));
  const previous = snaps.slice(1).flatMap(s => s.docs.map(d => ({ id: d.id, ...d.data() })));
  return _mergeOcorrs(current, previous, mes, ano);
}

async function createOcorrencia(data) {
  const ref = await window.db.collection('ocorrencias').add({
    ...data,
    created_at: firebase.firestore.FieldValue.serverTimestamp(),
    updated_at: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

async function updateOcorrencia(id, data) {
  await window.db.collection('ocorrencias').doc(id).update({
    ...data,
    updated_at: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

// ── CVS Override ─────────────────────────────────────────

async function getCvsOverride(id) {
  const snap = await window.db.collection('cvs_override').doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function setCvsOverride(id, data) {
  await window.db.collection('cvs_override').doc(id).set({
    ...data,
    updated_at: firebase.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ── Usuários ─────────────────────────────────────────────

async function getUsuario(email) {
  const snap = await window.db.collection('usuarios').doc(email).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function getTodosFiscais() {
  const snap = await window.db.collection('usuarios')
    .where('grupo', '==', 'Fiscal')
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
}

async function getTodosUsuarios() {
  const snap = await window.db.collection('usuarios').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
}

async function updateUsuario(email, data) {
  await window.db.collection('usuarios').doc(email).update({
    ...data,
    updated_at: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

async function deleteUsuario(email) {
  await window.db.collection('usuarios').doc(email).delete();
}

// ── CNAE Complexidade ─────────────────────────────────────

// Sanitiza o código CNAE para uso como ID de documento no Firestore.
// A barra '/' é interpretada como separador de caminho — substituímos por '_'.
function _cnaeDocId(subclasse) {
  return String(subclasse).replace(/\//g, '_');
}

async function getCNAEComplexidade(subclasse) {
  const snap = await window.db.collection('cnae_complexidade').doc(_cnaeDocId(subclasse)).get();
  return snap.exists ? snap.data() : null;
}

async function seedCNAEComplexidade(rows) {
  const BATCH_SIZE = 499;
  let batch = window.db.batch();
  let count = 0;
  for (const row of rows) {
    const sub = String(
      row['Subclasse'] || row['subclasse'] || row['SUBCLASSE'] || ''
    ).replace(/"/g, '').trim();
    if (!sub) continue;
    const complexidade = String(
      row['Complexidade'] || row['complexidade'] || row['COMPLEXIDADE'] || ''
    ).replace(/"/g, '').trim();
    const descricao = String(
      row['Descrição'] || row['Descricao'] || row['descricao'] ||
      row['Denominação'] || row['Denominacao'] || row['denominacao'] ||
      row['Atividade'] || row['atividade'] || ''
    ).replace(/"/g, '').trim();
    const ref = window.db.collection('cnae_complexidade').doc(_cnaeDocId(sub));
    batch.set(ref, {
      subclasse: sub,
      complexidade,
      descricao,
      updated_at: firebase.firestore.FieldValue.serverTimestamp(),
    });
    count++;
    if (count % BATCH_SIZE === 0) {
      await batch.commit();
      batch = window.db.batch();
    }
  }
  if (count % BATCH_SIZE !== 0 && count > 0) await batch.commit();
  return count;
}

// ── Delete all manuais for a month (Administrador) ───────

async function deleteManuaisTodosMes(mes, ano) {
  const snap = await window.db.collection('manuais')
    .where('mes', '==', Number(mes))
    .where('ano', '==', Number(ano))
    .get();
  const BATCH_SIZE = 499;
  let batch = window.db.batch();
  let count = 0;
  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    count++;
    if (count % BATCH_SIZE === 0) {
      await batch.commit();
      batch = window.db.batch();
    }
  }
  if (count % BATCH_SIZE !== 0 && count > 0) await batch.commit();
  return count;
}

// ── Delete manuais for a specific fiscal in a month ──────
async function deleteManuaisFiscalMes(fiscalEmail, mes, ano) {
  const snap = await window.db.collection('manuais')
    .where('fiscal_email', '==', fiscalEmail)
    .where('mes', '==', Number(mes))
    .where('ano', '==', Number(ano))
    .get();
  const BATCH_SIZE = 499;
  let batch = window.db.batch();
  let count = 0;
  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    count++;
    if (count % BATCH_SIZE === 0) {
      await batch.commit();
      batch = window.db.batch();
    }
  }
  if (count % BATCH_SIZE !== 0 && count > 0) await batch.commit();
  return count;
}

// ── Delete only imported (VISA/SIM) manuais for a month ──
// Lançamentos manuais feitos pelos fiscais NÃO são apagados.
// Identificação: IDs de importação sempre começam com "visa_" ou "sim_".

async function deleteImportadosMes(mes, ano) {
  const snap = await window.db.collection('manuais')
    .where('mes', '==', Number(mes))
    .where('ano', '==', Number(ano))
    .get();
  const importados = snap.docs.filter(
    d => d.id.startsWith('visa_') || d.id.startsWith('sim_')
  );
  const BATCH_SIZE = 499;
  let batch = window.db.batch();
  let count = 0;
  for (const doc of importados) {
    batch.delete(doc.ref);
    count++;
    if (count % BATCH_SIZE === 0) {
      await batch.commit();
      batch = window.db.batch();
    }
  }
  if (count % BATCH_SIZE !== 0 && count > 0) await batch.commit();
  return count;
}

// ── VISA Manuais (importados do CSV) ─────────────────────

function _visaDocId(visaControle, fiscalEmail) {
  return 'visa_' + String(visaControle).trim() + '_' +
    String(fiscalEmail).replace(/[.@+]/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}

async function getVISAManual(visaControle, fiscalEmail) {
  const id   = _visaDocId(visaControle, fiscalEmail);
  const snap = await window.db.collection('manuais').doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function upsertVISAManual(visaControle, fiscalEmail, data, existingId, isNew) {
  const id  = existingId || _visaDocId(visaControle, fiscalEmail);
  const ref = window.db.collection('manuais').doc(id);
  if (isNew) {
    await ref.set({
      ...data,
      fiscal_email: fiscalEmail,
      created_at: firebase.firestore.FieldValue.serverTimestamp(),
      updated_at: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    await ref.update({
      ...data,
      updated_at: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }
  return id;
}

// ── VISA Import Lock ─────────────────────────────────────
// Uses a Firestore transaction so the check+set is atomic.
// Lock document: visa_import_locks/{ano}-{mes}
// A stale lock (> 30 min) is automatically overridden as a safety net.

function _visaLockDocId(mes, ano) {
  return `${ano}-${String(mes).padStart(2, '0')}`;
}

async function acquireVisaImportLock(mes, ano, fiscalEmail, fiscalNome) {
  const docId = _visaLockDocId(mes, ano);
  const ref = window.db.collection('visa_import_locks').doc(docId);
  await window.db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data();
      const lockedAt = data.locked_at?.toMillis?.() || 0;
      const ageMs = Date.now() - lockedAt;
      const STALE_MS = 3 * 60 * 1000; // 3 min safety net
      if (ageMs < STALE_MS) {
        throw new Error(
          `Importação já em andamento por ${data.locked_by_nome || data.locked_by}. Aguarde a conclusão.`
        );
      }
    }
    tx.set(ref, {
      locked_by:      fiscalEmail,
      locked_by_nome: fiscalNome || fiscalEmail,
      locked_at:      firebase.firestore.FieldValue.serverTimestamp(),
    });
  });
}

async function releaseVisaImportLock(mes, ano) {
  const docId = _visaLockDocId(mes, ano);
  await window.db.collection('visa_import_locks').doc(docId).delete();
}

// ── SIM Manuais (importados do CSV auditoria.csv) ────────

function _simDocId(osNum, fiscalEmail) {
  return 'sim_' + String(osNum).trim() + '_' +
    String(fiscalEmail).replace(/[.@+]/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}

async function getSIMManual(osNum, fiscalEmail) {
  const id   = _simDocId(osNum, fiscalEmail);
  const snap = await window.db.collection('manuais').doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function upsertSIMManual(osNum, fiscalEmail, data, existingId, isNew) {
  const id  = existingId || _simDocId(osNum, fiscalEmail);
  const ref = window.db.collection('manuais').doc(id);
  if (isNew) {
    await ref.set({
      ...data,
      fiscal_email: fiscalEmail,
      created_at: firebase.firestore.FieldValue.serverTimestamp(),
      updated_at: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    await ref.update({
      ...data,
      updated_at: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }
  return id;
}

// ── SIM Import Lock ──────────────────────────────────────
// Uses a Firestore transaction so the check+set is atomic.
// Lock document: sim_import_locks/{ano}-{mes}
// A stale lock (> 3 min) is automatically overridden as a safety net.

function _simLockDocId(mes, ano) {
  return `${ano}-${String(mes).padStart(2, '0')}`;
}

async function acquireSimImportLock(mes, ano, fiscalEmail, fiscalNome) {
  const docId = _simLockDocId(mes, ano);
  const ref = window.db.collection('sim_import_locks').doc(docId);
  await window.db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data();
      const lockedAt = data.locked_at?.toMillis?.() || 0;
      const ageMs = Date.now() - lockedAt;
      const STALE_MS = 3 * 60 * 1000; // 3 min safety net
      if (ageMs < STALE_MS) {
        throw new Error(
          `Importação SIM já em andamento por ${data.locked_by_nome || data.locked_by}. Aguarde a conclusão.`
        );
      }
    }
    tx.set(ref, {
      locked_by:      fiscalEmail,
      locked_by_nome: fiscalNome || fiscalEmail,
      locked_at:      firebase.firestore.FieldValue.serverTimestamp(),
    });
  });
}

async function releaseSimImportLock(mes, ano) {
  const docId = _simLockDocId(mes, ano);
  await window.db.collection('sim_import_locks').doc(docId).delete();
}

// ── Fechamentos ──────────────────────────────────────────
// Document ID: {ano}-{mes_padded}-{fiscal_email_sanitized}

function _fechamentoDocId(fiscalEmail, mes, ano) {
  const emailSan = String(fiscalEmail).replace(/[.@+]/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
  return `${ano}-${String(mes).padStart(2, '0')}-${emailSan}`;
}

async function getFechamento(fiscalEmail, mes, ano) {
  const id   = _fechamentoDocId(fiscalEmail, mes, ano);
  const snap = await window.db.collection('fechamentos').doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function saveFechamento(fiscalEmail, mes, ano, data) {
  const id  = _fechamentoDocId(fiscalEmail, mes, ano);
  const ref = window.db.collection('fechamentos').doc(id);
  await ref.set({
    ...data,
    fiscal_email: fiscalEmail,
    mes:          Number(mes),
    ano:          Number(ano),
    fechado_em:   firebase.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return id;
}

async function deleteFechamento(fiscalEmail, mes, ano) {
  const id = _fechamentoDocId(fiscalEmail, mes, ano);
  await window.db.collection('fechamentos').doc(id).delete();
}

// Retorna os fechamentos do fiscal que são POSTERIORES ao mês/ano indicado.
// Usado para impedir a reabertura de uma competência quando existe
// pelo menos um mês mais recente já fechado para o mesmo fiscal.
async function getFechamentosPosterioresFiscal(fiscalEmail, mes, ano) {
  // Busca todos os fechamentos do fiscal e filtra client-side para evitar
  // a necessidade de índice composto com campo de inequidade (>=).
  // O índice existente tem `ano DESCENDING`, incompatível com queries de range.
  const snap = await window.db.collection('fechamentos')
    .where('fiscal_email', '==', fiscalEmail)
    .get();
  return snap.docs
    .map(d => d.data())
    .filter(f =>
      Number(f.ano) > Number(ano) ||
      (Number(f.ano) === Number(ano) && Number(f.mes) > Number(mes))
    )
    .sort((a, b) => Number(a.ano) - Number(b.ano) || Number(a.mes) - Number(b.mes));
}

// Retorna true se o mês/ano estiver fechado para o fiscal — seja por fechamento
// direto daquele mês, seja porque um mês POSTERIOR já foi fechado (tornando
// todos os anteriores implicitamente fechados).
async function isMesFechado(fiscalEmail, mes, ano) {
  const direto = await getFechamento(fiscalEmail, mes, ano);
  if (direto) return true;
  const posteriores = await getFechamentosPosterioresFiscal(fiscalEmail, mes, ano);
  return posteriores.length > 0;
}

// ── Última competência fechada ────────────────────────────
// Retorna {mes, ano} da competência mais recente com fechamento
// registrado na coleção `fechamentos`. Filtra por fiscal quando
// `fiscalEmail` for fornecido; caso contrário consulta globalmente.
// Fallback: mês corrente se nenhum fechamento for encontrado.

async function getUltimoMesFechado(fiscalEmail) {
  const now = new Date();
  // Para fiscal individual: usa orderBy + limit(1) — retorna apenas 1 documento.
  // Para admin (sem fiscalEmail): busca todos pois precisa agrupar por fiscal.
  // Nota: requer índice composto em `fechamentos` para (fiscal_email ASC, ano DESC, mes DESC).
  if (fiscalEmail) {
    const snap = await window.db.collection('fechamentos')
      .where('fiscal_email', '==', fiscalEmail)
      .orderBy('ano', 'desc')
      .orderBy('mes', 'desc')
      .limit(1)
      .get();
    if (snap.empty) return { mes: now.getMonth() + 1, ano: now.getFullYear() };
    const d = snap.docs[0].data();
    return { mes: d.mes, ano: d.ano };
  }
  const snap = await window.db.collection('fechamentos').get();
  if (snap.empty) return { mes: now.getMonth() + 1, ano: now.getFullYear() };
  const docs = snap.docs.map(d => d.data());
  docs.sort((a, b) => b.ano - a.ano || b.mes - a.mes);
  return { mes: docs[0].mes, ano: docs[0].ano };
}

// Alias mantido por compatibilidade
const getUltimoMesAberto = getUltimoMesFechado;

// ── Próxima competência aberta ────────────────────────────
// Retorna {mes, ano} imediatamente após o último fechamento registrado
// na coleção `fechamentos`.
// Para fiscal: considera apenas os fechamentos desse fiscal — retorna o
//   mês seguinte ao seu último fechamento.
// Para admin (sem fiscalEmail): agrupa todos os fechamentos por fiscal,
//   determina o último fechamento de cada um e retorna o mês seguinte ao
//   MÍNIMO desses últimos fechamentos. Assim, enquanto qualquer fiscal
//   ainda estiver no mês X, o admin continua vendo X+1 como mês aberto.
// Fallback: mês corrente se nenhum fechamento for encontrado.

async function getProximaCompetencia(fiscalEmail) {
  const now = new Date();

  // Para fiscal individual: busca todos os fechamentos do fiscal e ordena
  //   client-side para evitar a necessidade de índice composto no Firestore.
  // Para admin (sem fiscalEmail): busca todos pois precisa agrupar por fiscal e
  //   determinar o fiscal mais atrasado (mínimo dos últimos fechamentos de cada um).
  if (fiscalEmail) {
    // Cada fiscal tem no máximo um fechamento por mês (≈12–24 docs por ano),
    // por isso a ordenação client-side é eficiente e dispensa índice composto.
    const snap = await window.db.collection('fechamentos')
      .where('fiscal_email', '==', fiscalEmail)
      .get();
    if (snap.empty) return { mes: now.getMonth() + 1, ano: now.getFullYear() };
    const docs = snap.docs.map(d => d.data());
    docs.sort((a, b) => Number(b.ano) - Number(a.ano) || Number(b.mes) - Number(a.mes));
    if (!docs.length) return { mes: now.getMonth() + 1, ano: now.getFullYear() };
    const refDoc = docs[0];
    let mes = Number(refDoc.mes) + 1;
    let ano = Number(refDoc.ano);
    if (mes > 12) { mes = 1; ano++; }
    return { mes, ano };
  }

  // Para admin: verificar cache antes de varrer toda a coleção `fechamentos`.
  const cached = await getCompetenciaAberta();
  if (cached) return cached;

  const [snap, fiscaisSnap] = await Promise.all([
    window.db.collection('fechamentos').get(),
    window.db.collection('usuarios').where('grupo', '==', 'Fiscal').get(),
  ]);
  if (snap.empty) return { mes: now.getMonth() + 1, ano: now.getFullYear() };

  const docs = snap.docs.map(d => d.data());
  const todosFiscaisEmails = new Set(fiscaisSnap.docs.map(d => d.data().email || d.id));

  // Para admin: agrupa por fiscal e pega o mínimo dos últimos fechamentos
  //   de cada fiscal (o fiscal mais atrasado define o mês aberto).
  // Se algum fiscal ativo não tem nenhum fechamento, retorna mês corrente.
  let refDoc;
  {
    // Agrupar por fiscal_email → pegar o mais recente de cada um
    const porFiscal = {};
    for (const d of docs) {
      const email = d.fiscal_email;
      if (!porFiscal[email]) {
        porFiscal[email] = d;
      } else {
        const cur = porFiscal[email];
        if (Number(d.ano) > Number(cur.ano) || (Number(d.ano) === Number(cur.ano) && Number(d.mes) > Number(cur.mes))) {
          porFiscal[email] = d;
        }
      }
    }

    // Se há fiscais ativos sem nenhum fechamento, o mês aberto é o mês corrente
    const fiscaisSemFechamento = [...todosFiscaisEmails].filter(e => !porFiscal[e]);
    if (fiscaisSemFechamento.length > 0) {
      return { mes: now.getMonth() + 1, ano: now.getFullYear() };
    }

    // Pegar o mínimo (fiscal mais atrasado)
    const ultimos = Object.values(porFiscal);
    ultimos.sort((a, b) => Number(a.ano) - Number(b.ano) || Number(a.mes) - Number(b.mes));
    refDoc = ultimos[0];
  }

  let mes = Number(refDoc.mes) + 1;
  let ano = Number(refDoc.ano);
  if (mes > 12) { mes = 1; ano++; }
  return { mes, ano };
}

// ── Fechamentos de um mês/ano (todos os fiscais) ──────────

async function getFechamentosMes(mes, ano) {
  const snap = await window.db.collection('fechamentos')
    .where('mes', '==', Number(mes))
    .where('ano', '==', Number(ano))
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── Apaga todos os fechamentos de um mês/ano ──────────────
// Usado ao deletar lançamentos para manter consistência com a
// coleção `manuais` (se não há lançamentos, não deve haver fechamento).

async function deleteFechamentosMes(mes, ano) {
  const snap = await window.db.collection('fechamentos')
    .where('mes', '==', Number(mes))
    .where('ano', '==', Number(ano))
    .get();
  if (!snap.docs.length) return 0;
  const BATCH_SIZE = 499;
  let batch = window.db.batch();
  let count = 0;
  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    count++;
    if (count % BATCH_SIZE === 0) {
      await batch.commit();
      batch = window.db.batch();
    }
  }
  if (count % BATCH_SIZE !== 0) await batch.commit();
  return count;
}

// ── App Config / Competência Aberta (cache admin) ─────────
// Armazena o mês/ano aberto calculado após "Fechar para Todos".
// Evita varredura de toda a coleção `fechamentos` a cada load.

async function getCompetenciaAberta() {
  const doc = await window.db.collection('app_config').doc('competencia_aberta').get();
  if (!doc.exists) return null;
  const d = doc.data();
  if (!d || !d.mes || !d.ano) return null;
  return { mes: Number(d.mes), ano: Number(d.ano) };
}

async function setCompetenciaAberta(mes, ano) {
  await window.db.collection('app_config').doc('competencia_aberta').set({
    mes: Number(mes),
    ano: Number(ano),
    last_updated: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

async function deleteCompetenciaAberta() {
  await window.db.collection('app_config').doc('competencia_aberta').delete();
}

// ── App Config / GitHub Token ─────────────────────────────

async function db_getGitHubToken() {
  const doc = await window.db.collection('app_config').doc('github_token').get();
  return doc.exists ? (doc.data().token || null) : null;
}

async function db_setGitHubToken(token) {
  await window.db.collection('app_config').doc('github_token').set({ token });
}

// ── App Config / Prazo de Lançamentos Fiscais ──────────────

async function db_getDeadlineConfig() {
  const doc = await window.db.collection('app_config').doc('fiscal_deadline').get();
  if (!doc.exists) return { dias_prazo: 7, ativo: true };
  const d = doc.data();
  return {
    dias_prazo: Number(d.dias_prazo || 7),
    ativo: Boolean(d.ativo !== false),
  };
}

async function db_updateDeadlineConfig(dias_prazo, ativo) {
  await window.db.collection('app_config').doc('fiscal_deadline').set({
    dias_prazo: Number(dias_prazo),
    ativo: Boolean(ativo),
    last_updated: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

// Valida se a data do lançamento está dentro do prazo permitido
// Retorna { permitido: boolean, diasAtraso: number, prazoDias: number, mensagem: string }
async function db_validateDeadlineReleaseDate(dataISO) {
  const config = await db_getDeadlineConfig();
  if (!config.ativo) return { permitido: true, diasAtraso: 0, prazoDias: config.dias_prazo, mensagem: '' };

  if (!dataISO) return { permitido: true, diasAtraso: 0, prazoDias: config.dias_prazo, mensagem: '' };

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const data = new Date(dataISO + 'T00:00:00');

  const diffMs = hoje - data;
  const diasAtraso = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const permitido = diasAtraso <= config.dias_prazo;

  return {
    permitido,
    diasAtraso,
    prazoDias: config.dias_prazo,
    mensagem: !permitido
      ? 'Data de lançamento superior ao prazo estabelecido pela gerencia'
      : '',
  };
}

/**
 * Fetches a file from the private garrado/VISA repository using the stored
 * GitHub PAT and the GitHub Contents API with the raw media type.
 * @param {string} filePath  Path inside the repo, e.g. 'data/inspecoes.csv'
 * @returns {Promise<string>} Raw text content of the file
 */
async function fetchGitHubCSV(filePath) {
  const token = await db_getGitHubToken();
  if (!token) throw new Error('Token do GitHub não configurado. Acesse Admin → 🔑 Token do GitHub para configurar.');
  const url = `https://api.github.com/repos/garrado/VISA/contents/${filePath}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github.v3.raw',
    },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error('Não foi possível acessar o arquivo do repositório VISA: HTTP ' + resp.status);
  return resp.text();
}

// ── Anexos de Manuais (Upload / Remoção) ─────────────────

const ANEXO_TIPOS_ACEITOS = {
  'application/pdf': true,
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
  'image/gif': true,
};
const ANEXO_EXTENSOES_ACEITAS = {
  '.pdf':  'application/pdf',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
};

/**
 * Faz upload de um PDF ou imagem para o Firebase Storage e atualiza os campos
 * de anexo no documento da coleção `manuais`.
 *
 * @param {string}   docId      - ID do documento na coleção manuais
 * @param {File}     file       - arquivo PDF ou imagem (máx 10 MB)
 * @param {function(number):void} [onProgress] - callback com % de 0–100
 * @returns {Promise<{url: string, path: string}>}
 */
async function uploadAnexoManual(docId, file, onProgress) {
  const MAX_BYTES = 10 * 1024 * 1024;
  if (!file) throw new Error('Nenhum arquivo selecionado.');
  const ext = '.' + file.name.toLowerCase().split('.').pop();
  if (!ANEXO_TIPOS_ACEITOS[file.type] && !ANEXO_EXTENSOES_ACEITAS[ext]) {
    throw new Error('Apenas arquivos PDF ou imagens (JPEG, PNG, WebP, GIF) são permitidos.');
  }
  if (file.size > MAX_BYTES) {
    throw new Error(`O arquivo excede o limite de 10 MB (tamanho: ${(file.size / 1024 / 1024).toFixed(1)} MB).`);
  }

  const path = `anexos/${docId}/${file.name}`;
  const storageRef = firebase.storage().ref(path);
  const contentType = file.type || ANEXO_EXTENSOES_ACEITAS[ext] || 'application/octet-stream';
  const uploadTask = storageRef.put(file, { contentType });

  return new Promise((resolve, reject) => {
    uploadTask.on(
      'state_changed',
      (snapshot) => {
        const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
        if (onProgress) onProgress(pct);
      },
      (error) => reject(error),
      async () => {
        try {
          const url = await uploadTask.snapshot.ref.getDownloadURL();
          await window.db.collection('manuais').doc(docId).update({
            anexo_url:   url,
            anexo_nome:  file.name,
            anexo_path:  path,
            anexo_bytes: file.size,
            updated_at:  firebase.firestore.FieldValue.serverTimestamp(),
          });
          resolve({ url, path });
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

/**
 * Remove o anexo (PDF ou imagem) do Firebase Storage e limpa os campos de anexo no Firestore.
 *
 * @param {string} docId      - ID do documento na coleção manuais
 * @param {string} anexoPath  - caminho do arquivo no Storage (ex: anexos/{docId}/{nome})
 * @returns {Promise<void>}
 */
async function removeAnexoManual(docId, anexoPath) {
  if (anexoPath) {
    try {
      await firebase.storage().ref(anexoPath).delete();
    } catch (err) {
      if (err.code !== 'storage/object-not-found') throw err;
    }
  }
  await window.db.collection('manuais').doc(docId).update({
    anexo_url:   null,
    anexo_nome:  null,
    anexo_path:  null,
    anexo_bytes: null,
    updated_at:  firebase.firestore.FieldValue.serverTimestamp(),
  });
}

// ── Armazenamento — Anexos por competência ────────────────

async function getAnexosPorMes() {
  // Filtra server-side apenas manuais com anexo_bytes > 0, evitando full scan.
  // Usa source:'server' para garantir dados atualizados após exclusões recentes.
  const snap = await window.db.collection('manuais')
    .where('anexo_bytes', '>', 0)
    .get({ source: 'server' });
  const porMes = {};
  let totalBytes = 0;
  snap.docs.forEach(d => {
    const data = d.data();
    if (!data.anexo_bytes) return;
    const key = `${data.mes}-${data.ano}`;
    if (!porMes[key]) porMes[key] = { mes: data.mes, ano: data.ano, count: 0, bytes: 0 };
    porMes[key].count++;
    porMes[key].bytes += data.anexo_bytes;
    totalBytes += data.anexo_bytes;
  });
  const lista = Object.values(porMes).sort((a, b) => a.ano - b.ano || a.mes - b.mes);
  return { porMes: lista, totalBytes };
}

async function getFechamentosTodos() {
  const snap = await window.db.collection('fechamentos').limit(500).get();
  return snap.docs.map(d => d.data());
}

// ── Lançamentos por data específica ──────────────────────
async function getManuaisPorData(fiscalEmail, dataISO) {
  const parts = dataISO.split('-');
  const ano = Number(parts[0]);
  const mes = Number(parts[1]);
  const snap = await window.db.collection('manuais')
    .where('fiscal_email', '==', fiscalEmail)
    .where('mes', '==', mes)
    .where('ano', '==', ano)
    .get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(d => d.data === dataISO);
}

async function deleteLancamentosDia(fiscalEmail, dataISO) {
  const docs = await getManuaisPorData(fiscalEmail, dataISO);
  if (!docs.length) return 0;
  const BATCH_SIZE = 499;
  let batch = window.db.batch();
  let count = 0;
  for (const doc of docs) {
    batch.delete(window.db.collection('manuais').doc(doc.id));
    count++;
    if (count % BATCH_SIZE === 0) { await batch.commit(); batch = window.db.batch(); }
  }
  if (count > 0) await batch.commit();
  return count;
}

// Retorna TODAS as ocorrências aceitas (sem filtro de mês/ano) — usado pelo script de migração
async function getOcorrenciasAceitasTodas() {
  const snap = await window.db.collection('ocorrencias')
    .where('status', '==', 'aceito')
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── Exports ──────────────────────────────────────────────

window.db_getFechamento                  = getFechamento;
window.db_saveFechamento                 = saveFechamento;
window.db_deleteFechamento               = deleteFechamento;
window.db_isMesFechado                   = isMesFechado;
window.db_getFechamentosPosterioresFiscal = getFechamentosPosterioresFiscal;
window.db_getUltimoMesFechado            = getUltimoMesFechado;
window.db_getUltimoMesAberto    = getUltimoMesAberto; // alias
window.db_getProximaCompetencia = getProximaCompetencia;
window.db_getFechamentosMes     = getFechamentosMes;
window.db_deleteFechamentosMes  = deleteFechamentosMes;
window.db_getManuais          = getManuais;
window.db_getManuaisTodos     = getManuaisTodos;
window.db_getManuaisPorData   = getManuaisPorData;
window.db_getManuaisRecusados = getManuaisRecusados;
window.db_createManual        = createManual;
window.db_updateManual        = updateManual;
window.db_deleteManual        = deleteManual;
window.db_deleteLancamentosDia = deleteLancamentosDia;
window.db_deleteManuaisTodosMes = deleteManuaisTodosMes;
window.db_deleteManuaisFiscalMes = deleteManuaisFiscalMes;
window.db_deleteImportadosMes   = deleteImportadosMes;
window.db_getOcorrencias      = getOcorrencias;
window.db_getOcorrenciasTodas = getOcorrenciasTodas;
window.db_getOcorrenciasAceitasTodas = getOcorrenciasAceitasTodas;
window.db_createOcorrencia    = createOcorrencia;
window.db_updateOcorrencia    = updateOcorrencia;
window.db_getCvsOverride      = getCvsOverride;
window.db_setCvsOverride      = setCvsOverride;
window.db_getUsuario          = getUsuario;
window.db_getTodosFiscais     = getTodosFiscais;
window.db_getTodosUsuarios    = getTodosUsuarios;
window.db_updateUsuario       = updateUsuario;
window.db_deleteUsuario        = deleteUsuario;
window.db_getCNAEComplexidade  = getCNAEComplexidade;
window.db_seedCNAEComplexidade = seedCNAEComplexidade;
window.db_getVISAManual        = getVISAManual;
window.db_upsertVISAManual     = upsertVISAManual;
window.db_acquireVisaImportLock = acquireVisaImportLock;
window.db_releaseVisaImportLock = releaseVisaImportLock;
window.db_getSIMManual          = getSIMManual;
window.db_upsertSIMManual       = upsertSIMManual;
window.db_acquireSimImportLock  = acquireSimImportLock;
window.db_releaseSimImportLock  = releaseSimImportLock;
window.db_getGitHubToken        = db_getGitHubToken;
window.db_setGitHubToken        = db_setGitHubToken;
window.fetchGitHubCSV           = fetchGitHubCSV;
window.db_getAnexosPorMes       = getAnexosPorMes;
window.db_getFechamentosTodos   = getFechamentosTodos;
window.db_uploadAnexoManual     = uploadAnexoManual;
window.db_removeAnexoManual     = removeAnexoManual;
window.db_getCompetenciaAberta  = getCompetenciaAberta;
window.db_setCompetenciaAberta  = setCompetenciaAberta;
window.db_deleteCompetenciaAberta = deleteCompetenciaAberta;
window.db_getDeadlineConfig     = db_getDeadlineConfig;
window.db_updateDeadlineConfig  = db_updateDeadlineConfig;
window.db_validateDeadlineReleaseDate = db_validateDeadlineReleaseDate;
