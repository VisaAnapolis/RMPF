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

async function deleteOcorrencia(id) {
  await window.db.collection('ocorrencias').doc(id).delete();
}

/**
 * Retorna a primeira ocorrência (não recusada) do fiscal que se sobrepõe ao
 * período informado, ou null se não houver conflito. Consulta todos os meses
 * abrangidos pelo período (incluindo o lookback de getOcorrencias) para capturar
 * ocorrências que cruzam meses. Compartilhada entre o lançamento manual
 * (ocorrencias.html) e a sincronização automática de férias.
 *
 * opts.ignorarOrigem: quando definido, ignora ocorrências com esse `origem`
 * (ex.: a própria sincronização passa 'ferias_visa' para não conflitar consigo).
 */
async function ocorrenciaConflitante(email, inicio, fim, ignoreId, opts) {
  opts = opts || {};
  const periodos = window.diasDaOcorrenciaPorMes(inicio, fim);
  const existentes = new Map();
  for (const { mes, ano } of Object.values(periodos)) {
    const lista = await getOcorrencias(email, mes, ano);
    lista.forEach(o => existentes.set(o.id, o));
  }
  for (const o of existentes.values()) {
    if (ignoreId && o.id === ignoreId) continue;
    if (o.status === 'recusado') continue;
    if (opts.ignorarOrigem && o.origem === opts.ignorarOrigem) continue;
    if (window.periodosSeSobrepoem(inicio, fim, o.data_inicio, o.data_fim)) return o;
  }
  return null;
}

// Todas as ocorrências com um dado `origem` (ex.: 'ferias_visa'), sem filtro de
// mês/ano — usada pela sincronização de férias para reconciliar o que já criou.
// `origem` sozinho usa o índice de campo único automático do Firestore.
async function getOcorrenciasPorOrigem(origem) {
  const snap = await window.db.collection('ocorrencias')
    .where('origem', '==', origem)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Manuais gerados por uma ocorrência aceita (origem:'ocorrencia', ocorrencia_id).
// Usada para apagar os pontos quando a ocorrência de férias correspondente é
// removida no VISA e precisa ser desfeita no RMPF.
async function getManuaisPorOcorrencia(ocorrenciaId) {
  const snap = await window.db.collection('manuais')
    .where('ocorrencia_id', '==', ocorrenciaId)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Aceita uma ocorrência: rateia MEDIA_PRODUTIVIDADE_OCORRENCIA (1000) pelos dias
// úteis do mês e gera 1 manual por dia útil (status 'homologado', origem
// 'ocorrencia', ocorrencia_id), depois marca a ocorrência como 'aceito'.
// Lógica compartilhada entre o aceite manual (ocorrencias.html) e o auto-aceite
// da sincronização de férias — mesmo rateio e mesma pré-checagem.
// Pré-checagem: recusa se algum dia coberto já tiver pontos de OUTRO lançamento
// (não-'ocorrencia', não-'recusado'). Retorna { ok:true } ou
// { ok:false, motivo:'dia_com_lancamento', dia, pontos }.
async function aceitarOcorrencia(o, opts) {
  opts = opts || {};
  const porMes = window.diasDaOcorrenciaPorMes(o.data_inicio, o.data_fim);

  // 1. Nenhum dia coberto pode ter outra atividade lançada.
  for (const { mes, ano, dias } of Object.values(porMes)) {
    const manuais = await getManuais(o.fiscal_email, mes, ano);
    for (const dia of dias) {
      const totalDia = manuais.reduce((acc, m) => {
        if (!m || m.data !== dia) return acc;
        if (m.origem === 'ocorrencia') return acc;
        if (m.status === 'recusado') return acc;
        return acc + (Number(m.pontos) || 0);
      }, 0);
      if (totalDia > 0) return { ok: false, motivo: 'dia_com_lancamento', dia, pontos: totalDia };
    }
  }

  // 2. Gerar 1 manual por dia útil, rateando 1000 pts pelos dias úteis do mês.
  const feriados = await window.carregarFeriadosMunicipais();
  const label  = window.labelOcorrencia ? window.labelOcorrencia(o.tipo) : o.tipo;
  const sufixo = opts.sufixoDescricao || 'aceita pelo administrador';
  const obs    = opts.obsAdmin || null;
  for (const { mes, ano, dias } of Object.values(porMes)) {
    const totalUteis = window.diasUteisNoMes(mes, ano, feriados);
    const taxa = totalUteis > 0
      ? Math.round((window.MEDIA_PRODUTIVIDADE_OCORRENCIA / totalUteis) * 100) / 100 : 0;
    for (const dia of dias) {
      if (!window.ehDiaUtil(dia, feriados)) continue;
      await createManual({
        controle:       `OCR-${ano}-${String(mes).padStart(2,'0')}-${dia.replace(/-/g,'')}`,
        fiscal_email:   o.fiscal_email,
        fiscal_nome:    o.fiscal_nome,
        mes, ano,
        data:           dia,
        tipo_id:        99,
        tipo_codigo:    'OCR',
        tipo_nome:      'Ocorrência',
        item_pontuacao: null,
        complexidade:   '—',
        pontos:         taxa,
        pontos_homologado: taxa,
        descricao:      `Ocorrência: ${label} — ${sufixo}`,
        obs:            obs,
        status:         'homologado',
        origem:         'ocorrencia',
        ocorrencia_id:  o.id,
        dispositivo_legal: window.dispositivoLegalOcorrencia
          ? window.dispositivoLegalOcorrencia(o.tipo)
          : 'Art. 11 da Lei Complementar nº 548/2023',
      });
    }
  }

  // 3. Marcar a ocorrência como aceita.
  await updateOcorrencia(o.id, { status: 'aceito', obs_admin: obs });
  return { ok: true };
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
    .where('perfil', '==', 'Fiscal')
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

// ID do lançamento VISA. Desde a importação multi-CNAE, uma mesma inspeção
// (CONTROLE) gera N lançamentos — um por CNAE de competência do regulado —,
// portanto o CNAE entra na chave para garantir unicidade.
// `cnae` é opcional: quando omitido, reproduz o ID legado (1 lançamento por
// controle/fiscal), usado para localizar registros homologados antigos.
function _visaDocId(visaControle, fiscalEmail, cnae) {
  const emailSan = String(fiscalEmail).replace(/[.@+]/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
  const cnaePart = cnae ? String(cnae).replace(/[^a-zA-Z0-9]/g, '') + '_' : '';
  return 'visa_' + String(visaControle).trim() + '_' + cnaePart + emailSan;
}

async function getVISAManual(visaControle, fiscalEmail, cnae) {
  const id   = _visaDocId(visaControle, fiscalEmail, cnae);
  const snap = await window.db.collection('manuais').doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function upsertVISAManual(visaControle, fiscalEmail, data, existingId, isNew, cnae) {
  const id  = existingId || _visaDocId(visaControle, fiscalEmail, cnae);
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

// Renova o timestamp do lock para evitar que uma importação longa (todos os
// fiscais) seja considerada "stale" (> 3 min) por outra sessão e gere
// importação duplicada. Chamada como heartbeat durante o loop de importação.
async function refreshVisaImportLock(mes, ano) {
  const docId = _visaLockDocId(mes, ano);
  await window.db.collection('visa_import_locks').doc(docId).set({
    locked_at: firebase.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ── SIM Manuais (importados da coleção ordens_servico) ───

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

// ── Ordens de Serviço (fonte das auditorias do SIM) ──────
// Substitui o antigo CSV `data/auditoria.csv`. Lê as ordens de serviço
// concluídas cuja `dataCumprimento` cai dentro do mês/ano informado.
// A query usa intervalo sobre `dataCumprimento` (+ igualdade em `fiscalEmail`
// quando informado); o status é filtrado no cliente para tolerar variações de
// caixa/acentuação ("Concluida" / "concluída" / "CONCLUÍDA").
async function getOrdensServicoConcluidas(mes, ano, fiscalEmail) {
  mes = Number(mes); ano = Number(ano);
  const inicio = firebase.firestore.Timestamp.fromDate(new Date(ano, mes - 1, 1, 0, 0, 0, 0));
  const fim    = firebase.firestore.Timestamp.fromDate(new Date(ano, mes, 1, 0, 0, 0, 0));
  let q = window.db.collection('ordens_servico')
    .where('dataCumprimento', '>=', inicio)
    .where('dataCumprimento', '<',  fim);
  if (fiscalEmail) q = q.where('fiscalEmail', '==', fiscalEmail);
  const snap = await q.get();
  return snap.docs.map(d => ({ _docId: d.id, ...d.data() }));
}

// Maior updatedAt (ms) em ordens_servico — detector barato de mudança (1 leitura).
// Retorna 0 se a coleção estiver vazia. Usa o índice de campo único de updatedAt.
async function getMaxUpdatedOrdemServico() {
  const snap = await window.db.collection('ordens_servico')
    .orderBy('updatedAt', 'desc').limit(1).get();
  if (snap.empty) return 0;
  const v = snap.docs[0].data().updatedAt;
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
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
    window.db.collection('usuarios').where('perfil', '==', 'Fiscal').get(),
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

// ── App Config / Notificações Push ─────────────────────────
// Configuração das notificações push, persistida em app_config/notif_config.
// Lida por initFCM (js/firebase-config.js):
//   denied_reminder_dias : frequência (dias) do lembrete para quem NEGOU.
//   promo_dias           : frequência (dias) do convite para quem ainda NÃO
//                          decidiu (permission 'default'). Padrão 7.
//   promo_campaign       : marcador (epoch ms) de campanha "re-oferecer agora";
//                          ao mudar, o convite reaparece para todos os 'default'
//                          no próximo acesso, ignorando o throttle de dias.

async function db_getNotifConfig() {
  const doc = await window.db.collection('app_config').doc('notif_config').get();
  const d = doc.exists ? (doc.data() || {}) : {};
  const rem   = Number(d.denied_reminder_dias);
  const promo = Number(d.promo_dias);
  return {
    denied_reminder_dias: (Number.isFinite(rem)   && rem   > 0) ? rem   : 15,
    promo_dias:           (Number.isFinite(promo) && promo > 0) ? promo : 7,
    promo_campaign:       Number(d.promo_campaign) || 0,
  };
}

// Atualiza apenas os campos presentes em `patch` (objeto parcial), sempre com
// { merge: true } para não sobrescrever os demais campos do documento.
async function db_updateNotifConfig(patch) {
  const out = { last_updated: firebase.firestore.FieldValue.serverTimestamp() };
  if (patch && patch.denied_reminder_dias != null) out.denied_reminder_dias = Number(patch.denied_reminder_dias);
  if (patch && patch.promo_dias           != null) out.promo_dias           = Number(patch.promo_dias);
  if (patch && patch.promo_campaign       != null) out.promo_campaign       = Number(patch.promo_campaign);
  await window.db.collection('app_config').doc('notif_config').set(out, { merge: true });
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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 s
  let resp;
  try {
    resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github.v3.raw',
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Tempo limite excedido ao conectar com o GitHub (20 s). Verifique sua conexão ou se api.github.com está acessível na sua rede.');
    }
    throw new Error('Falha de rede ao acessar o GitHub. Verifique sua conexão com a internet e se api.github.com está acessível.');
  } finally {
    clearTimeout(timeoutId);
  }

  if (resp.status === 401) throw new Error('Token do GitHub inválido ou expirado. Acesse Admin → 🔑 Token do GitHub para atualizar.');
  if (resp.status === 403) throw new Error('Acesso negado ao repositório VISA. Verifique as permissões do token do GitHub.');
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error('Não foi possível acessar o arquivo do repositório VISA: HTTP ' + resp.status);
  return resp.text();
}

/**
 * Retorna o SHA do último commit que tocou um arquivo no repositório VISA.
 * Usado como "token de mudança" barato para detectar quando o CSV foi
 * atualizado, sem baixar o arquivo inteiro.
 * @param {string} filePath  Caminho dentro do repo, ex.: 'data/inspecoes.csv'
 * @returns {Promise<string|null>} SHA do commit mais recente, ou null se não houver.
 */
async function fetchGitHubFileCommitSha(filePath) {
  const token = await db_getGitHubToken();
  if (!token) throw new Error('Token do GitHub não configurado. Acesse Admin → 🔑 Token do GitHub para configurar.');
  const url = `https://api.github.com/repos/garrado/VISA/commits?path=${encodeURIComponent(filePath)}&per_page=1`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 s
  let resp;
  try {
    resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Tempo limite excedido ao consultar o GitHub (20 s).');
    }
    throw new Error('Falha de rede ao consultar o GitHub.');
  } finally {
    clearTimeout(timeoutId);
  }

  if (resp.status === 401) throw new Error('Token do GitHub inválido ou expirado.');
  if (resp.status === 403) throw new Error('Acesso negado ao repositório VISA. Verifique as permissões do token.');
  if (!resp.ok) throw new Error('Não foi possível consultar commits do repositório VISA: HTTP ' + resp.status);
  const arr = await resp.json();
  return Array.isArray(arr) && arr.length ? (arr[0].sha || null) : null;
}

// ── App Config / Estado de Importação (detecção de mudança) ──
// Guarda o "token de mudança" da última importação automática por fonte,
// ex.: { visa: { commit_sha, mes, ano, imported_at } }. Evita reimportar
// quando o CSV não mudou desde a última execução.

async function getImportState() {
  const doc = await window.db.collection('app_config').doc('import_state').get();
  return doc.exists ? (doc.data() || {}) : {};
}

async function setImportState(patch) {
  await window.db.collection('app_config').doc('import_state').set({
    ...patch,
    last_updated: firebase.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
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

// ── Férias (VISA) → sincronização ────────────────────────
// A escala de férias é mantida pela gestão no app VISA num doc único
// `ferias/escala` → { periodos: [{nome, inicio, fim, obs?}], updatedAt, updatedBy }.
// Compartilham o mesmo projeto Firestore (visam-3a30b); a regra permite leitura
// a qualquer autenticado. Uma única leitura de documento, sem índice.
async function getFeriasEscala() {
  const snap = await window.db.collection('ferias').doc('escala').get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

// ── Ferias Sync Lock ─────────────────────────────────────
// Transação atômica (check+set). Doc único ferias_sync_locks/escala (a escala é
// um doc global, então um lock basta). Lock obsoleto (> 5 min) é sobrescrito.
async function acquireFeriasSyncLock(fiscalEmail, fiscalNome) {
  const ref = window.db.collection('ferias_sync_locks').doc('escala');
  await window.db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data();
      const lockedAt = data.locked_at?.toMillis?.() || 0;
      const ageMs = Date.now() - lockedAt;
      const STALE_MS = 5 * 60 * 1000; // 5 min safety net
      if (ageMs < STALE_MS) {
        throw new Error(
          `Sincronização de férias já em andamento por ${data.locked_by_nome || data.locked_by}. Aguarde a conclusão.`
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

async function releaseFeriasSyncLock() {
  await window.db.collection('ferias_sync_locks').doc('escala').delete();
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
window.db_getOcorrenciasPorOrigem = getOcorrenciasPorOrigem;
window.db_getManuaisPorOcorrencia = getManuaisPorOcorrencia;
window.db_createOcorrencia    = createOcorrencia;
window.db_updateOcorrencia    = updateOcorrencia;
window.db_deleteOcorrencia    = deleteOcorrencia;
window.db_aceitarOcorrencia   = aceitarOcorrencia;
window.ocorrenciaConflitante  = ocorrenciaConflitante;
window.db_getFeriasEscala     = getFeriasEscala;
window.db_acquireFeriasSyncLock = acquireFeriasSyncLock;
window.db_releaseFeriasSyncLock = releaseFeriasSyncLock;
window.db_getCvsOverride      = getCvsOverride;
window.db_setCvsOverride      = setCvsOverride;
window.db_getUsuario          = getUsuario;
window.db_getTodosFiscais     = getTodosFiscais;
window.db_getTodosUsuarios    = getTodosUsuarios;
window.db_updateUsuario       = updateUsuario;
window.db_deleteUsuario        = deleteUsuario;
window.db_getVISAManual        = getVISAManual;
window.db_upsertVISAManual     = upsertVISAManual;
window.db_acquireVisaImportLock = acquireVisaImportLock;
window.db_releaseVisaImportLock = releaseVisaImportLock;
window.db_refreshVisaImportLock = refreshVisaImportLock;
window.db_getSIMManual          = getSIMManual;
window.db_upsertSIMManual       = upsertSIMManual;
window.db_acquireSimImportLock  = acquireSimImportLock;
window.db_releaseSimImportLock  = releaseSimImportLock;
window.db_getOrdensServicoConcluidas = getOrdensServicoConcluidas;
window.db_getMaxUpdatedOrdemServico  = getMaxUpdatedOrdemServico;
window.db_getGitHubToken        = db_getGitHubToken;
window.db_setGitHubToken        = db_setGitHubToken;
window.fetchGitHubCSV           = fetchGitHubCSV;
window.fetchGitHubFileCommitSha = fetchGitHubFileCommitSha;
window.db_getImportState        = getImportState;
window.db_setImportState        = setImportState;
window.db_getAnexosPorMes       = getAnexosPorMes;
window.db_getFechamentosTodos   = getFechamentosTodos;
window.db_uploadAnexoManual     = uploadAnexoManual;
window.db_removeAnexoManual     = removeAnexoManual;
window.db_getCompetenciaAberta  = getCompetenciaAberta;
window.db_setCompetenciaAberta  = setCompetenciaAberta;
window.db_deleteCompetenciaAberta = deleteCompetenciaAberta;
window.db_getDeadlineConfig     = db_getDeadlineConfig;
window.db_updateDeadlineConfig  = db_updateDeadlineConfig;
window.db_getNotifConfig        = db_getNotifConfig;
window.db_updateNotifConfig     = db_updateNotifConfig;
window.db_validateDeadlineReleaseDate = db_validateDeadlineReleaseDate;
