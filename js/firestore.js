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

async function getCNAEComplexidade(subclasse) {
  const snap = await window.db.collection('cnae_complexidade').doc(subclasse).get();
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
    const ref = window.db.collection('cnae_complexidade').doc(sub);
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

// ── Exports ──────────────────────────────────────────────

window.db_getManuais          = getManuais;
window.db_getManuaisTodos     = getManuaisTodos;
window.db_createManual        = createManual;
window.db_updateManual        = updateManual;
window.db_deleteManual        = deleteManual;
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
