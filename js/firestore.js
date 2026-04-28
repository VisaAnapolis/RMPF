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
    .sort((a, b) => (a.created_at?.toMillis?.() || 0) - (b.created_at?.toMillis?.() || 0));
}

async function getManuaisTodos(mes, ano) {
  const snap = await window.db.collection('manuais')
    .where('mes', '==', Number(mes))
    .where('ano', '==', Number(ano))
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.created_at?.toMillis?.() || 0) - (b.created_at?.toMillis?.() || 0));
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

async function getOcorrencias(fiscalEmail, mes, ano) {
  const snap = await window.db.collection('ocorrencias')
    .where('fiscal_email', '==', fiscalEmail)
    .where('mes', '==', Number(mes))
    .where('ano', '==', Number(ano))
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.created_at?.toMillis?.() || 0) - (b.created_at?.toMillis?.() || 0));
}

async function getOcorrenciasTodas(mes, ano) {
  const snap = await window.db.collection('ocorrencias')
    .where('mes', '==', Number(mes))
    .where('ano', '==', Number(ano))
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.created_at?.toMillis?.() || 0) - (b.created_at?.toMillis?.() || 0));
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
      const STALE_MS = 30 * 60 * 1000; // 30 min safety net
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

// ── Exports ──────────────────────────────────────────────

window.db_getManuais          = getManuais;
window.db_getManuaisTodos     = getManuaisTodos;
window.db_createManual        = createManual;
window.db_updateManual        = updateManual;
window.db_deleteManual        = deleteManual;
window.db_deleteManuaisTodosMes = deleteManuaisTodosMes;
window.db_getOcorrencias      = getOcorrencias;
window.db_getOcorrenciasTodas = getOcorrenciasTodas;
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
