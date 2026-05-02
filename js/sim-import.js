// js/sim-import.js
// Módulo de importação de auditorias do SIM para o RMPF

const SIM_CSV_URL           = 'https://raw.githubusercontent.com/garrado/VISA/main/data/auditoria.csv';
const SIM_IMPORT_INICIO_MES = 4;
const SIM_IMPORT_INICIO_ANO = 2026;

function simMesAberto(mes, ano) {
  mes = Number(mes); ano = Number(ano);
  if (ano > SIM_IMPORT_INICIO_ANO) return true;
  if (ano === SIM_IMPORT_INICIO_ANO && mes >= SIM_IMPORT_INICIO_MES) return true;
  return false;
}

function normNomeSim(v) {
  return String(v || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

function normStatusSim(v) {
  return String(v || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}

function complexToItemSim(complexidade) {
  const c = String(complexidade || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (c === 'alta')  return { item: 1, pontos: 48 };
  if (c === 'baixa') return { item: 3, pontos: 6  };
  return { item: 2, pontos: 12 };
}

function simDataToISO(dataStr) {
  if (!dataStr) return null;
  const s = String(dataStr).trim().replace(/"/g, '');
  const parts = s.split('/');
  if (parts.length === 3) {
    const [d, m, y] = parts;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  return null;
}

async function importarAuditoriasSIM({ fiscalEmail, fiscalNome, mes, ano, allFiscais, onProgress, onProgressBar }) {
  mes = Number(mes); ano = Number(ano);

  if (!simMesAberto(mes, ano)) {
    onProgress('⚠️ Mês anterior a Abril/2026 — impossível importar.', 'warn');
    return { criados: 0, atualizados: 0, ignorados: 0, erros: 0 };
  }

  // Acquire distributed lock — throws if another import is already running for this month
  await window.db_acquireSimImportLock(mes, ano, fiscalEmail, fiscalNome || fiscalEmail);

  try {
    onProgress('🔄 Buscando CSV de auditorias do SIM...', 'info');

    const resp = await fetch(SIM_CSV_URL + '?v=' + Date.now());
    if (!resp.ok) throw new Error('Não foi possível acessar o CSV do SIM: HTTP ' + resp.status);
    const text = await resp.text();

    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: h => h.replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim(),
    });
    const rows = parsed.data;

    const fiscalMap = new Map();
    for (const f of (allFiscais || [])) {
      if (f.nome) fiscalMap.set(normNomeSim(f.nome), f.email || f.id);
    }

    const mesStr = String(mes).padStart(2, '0');
    const anoStr = String(ano);
    const rowsFiltradas = rows.filter(r => {
      if (normStatusSim(r['Status']) !== 'concluida') return false;
      const dtStatus = simDataToISO(String(r['Data do Status'] || '').replace(/"/g, '').trim());
      return dtStatus && dtStatus.startsWith(`${anoStr}-${mesStr}-`);
    });

    onProgress(`📋 ${rowsFiltradas.length} auditoria(s) concluída(s) encontrada(s) para ${mesStr}/${anoStr}.`, 'info');

    let criados = 0, atualizados = 0, ignorados = 0, erros = 0;
    const cnaeCache = new Map();

    for (let idx = 0; idx < rowsFiltradas.length; idx++) {
      const row = rowsFiltradas[idx];
      if (onProgressBar) onProgressBar(idx + 1, rowsFiltradas.length);

      const osNum = String(row['Número OS'] || '').replace(/"/g, '').trim();
      if (!osNum) continue;

      const nomeFiscalCsv = String(row['Fiscal'] || '').replace(/"/g, '').trim();
      if (!nomeFiscalCsv) continue;

      const emailFiscal = fiscalMap.get(normNomeSim(nomeFiscalCsv));
      if (!emailFiscal) continue;
      if (fiscalEmail && emailFiscal !== fiscalEmail) continue;

      const subclasse = String(row['CNAE'] || '').replace(/"/g, '').trim();
      let cnaeInfo = { complexidade: 'Média', descricao: '' };
      if (subclasse) {
        if (!cnaeCache.has(subclasse)) {
          try {
            const info = await window.db_getCNAEComplexidade(subclasse);
            cnaeCache.set(subclasse, info || { complexidade: 'Média', descricao: subclasse });
          } catch(_) {
            cnaeCache.set(subclasse, { complexidade: 'Média', descricao: subclasse });
          }
        }
        cnaeInfo = cnaeCache.get(subclasse) || { complexidade: 'Média', descricao: subclasse };
      }

      const { item, pontos } = complexToItemSim(cnaeInfo.complexidade);
      const dataISO = simDataToISO(String(row['Data do Status'] || '').replace(/"/g, '').trim());

      const descParts = ['Auditoria SIM', 'OS ' + osNum];
      if (subclasse) descParts.push('CNAE ' + subclasse);
      if (cnaeInfo.descricao && cnaeInfo.descricao !== subclasse) descParts.push(cnaeInfo.descricao);
      const descricao = descParts.join(' — ');

      try {
        const existing = await window.db_getSIMManual(osNum, emailFiscal);

        if (existing) {
          if (existing.status === 'aceito' || existing.status === 'fechado') {
            ignorados++;
            onProgress(`⚠️ OS ${osNum} — ${nomeFiscalCsv}: já homologado, ignorado.`, 'warn');
            continue;
          }
          const updateData = {
            fiscal_nome: nomeFiscalCsv,
            mes, ano, data: dataISO,
            tipo_id: 1, tipo_codigo: 'VIS',
            tipo_nome: 'Vistoria ou atendimento a denúncia',
            item_pontuacao: item,
            complexidade: cnaeInfo.complexidade,
            pontos, descricao,
            origem: 'sim_csv',
            sim_os: osNum,
          };
          if (existing.status === 'recusado') {
            updateData.status = 'enviado';
            updateData.motivo_recusa = null;
            onProgress(`🔄 OS ${osNum}: recusado anteriormente, resubmetido para conferência.`, 'info');
          }
          await window.db_upsertSIMManual(osNum, emailFiscal, updateData, existing.id, false);
          atualizados++;
        } else {
          const fechamento = await window.db_getFechamento(emailFiscal, mes, ano);
          if (fechamento) {
            ignorados++;
            onProgress(`⚠️ OS ${osNum} — ${nomeFiscalCsv}: competência fechada, ignorado.`, 'warn');
            continue;
          }
          await window.db_upsertSIMManual(osNum, emailFiscal, {
            controle: 'SIM-' + osNum,
            fiscal_email: emailFiscal,
            fiscal_nome: nomeFiscalCsv,
            mes, ano, data: dataISO,
            tipo_id: 1, tipo_codigo: 'VIS',
            tipo_nome: 'Vistoria ou atendimento a denúncia',
            item_pontuacao: item,
            complexidade: cnaeInfo.complexidade,
            pontos, descricao,
            status: 'enviado',
            origem: 'sim_csv',
            sim_os: osNum,
          }, null, true);
          criados++;
        }
      } catch(e) {
        erros++;
        onProgress('🚨 Erro OS ' + osNum + ': ' + e.message, 'danger');
      }
    }

    onProgress(
      `✅ Importação concluída: <strong>${criados}</strong> criado(s), ` +
      `<strong>${atualizados}</strong> atualizado(s), ` +
      `<strong>${ignorados}</strong> ignorado(s), ` +
      `<strong>${erros}</strong> erro(s).`,
      erros > 0 ? 'warn' : 'ok'
    );
    return { criados, atualizados, ignorados, erros };
  } finally {
    await window.db_releaseSimImportLock(mes, ano);
  }
}

window.simMesAberto        = simMesAberto;
window.importarAuditoriasSIM = importarAuditoriasSIM;
