// js/visa-import.js
// Módulo de importação de inspeções do VISA para o RMPF

const VISA_CSV_URL        = 'https://raw.githubusercontent.com/garrado/VISA/main/data/inspecoes.csv';
const VISA_IMPORT_INICIO_MES = 4;
const VISA_IMPORT_INICIO_ANO = 2026;

function visaMesAberto(mes, ano) {
  mes = Number(mes); ano = Number(ano);
  if (ano > VISA_IMPORT_INICIO_ANO) return true;
  if (ano === VISA_IMPORT_INICIO_ANO && mes >= VISA_IMPORT_INICIO_MES) return true;
  return false;
}

function normNomeVisa(v) {
  return String(v || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

function complexToItem(complexidade) {
  const c = String(complexidade || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (c === 'alta')  return { item: 1, pontos: 48 };
  if (c === 'baixa') return { item: 3, pontos: 6  };
  return { item: 2, pontos: 12 };
}

function visaDataToISO(dataStr) {
  if (!dataStr) return null;
  const s = String(dataStr).trim().replace(/"/g, '');
  const parts = s.split('.');
  if (parts.length === 3) {
    const [d, m, y] = parts;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  return null;
}

async function importarInspecoesVISA({ fiscalEmail, mes, ano, allFiscais, onProgress }) {
  mes = Number(mes); ano = Number(ano);

  if (!visaMesAberto(mes, ano)) {
    onProgress('⚠️ Mês anterior a Abril/2026 — impossível importar.', 'warn');
    return { criados: 0, atualizados: 0, ignorados: 0, erros: 0 };
  }

  onProgress('🔄 Buscando CSV de inspeções do VISA...', 'info');

  const resp = await fetch(VISA_CSV_URL + '?v=' + Date.now());
  if (!resp.ok) throw new Error('Não foi possível acessar o CSV do VISA: HTTP ' + resp.status);
  const text = await resp.text();

  const parsed = Papa.parse(text, {
    header: true,
    delimiter: ';',
    skipEmptyLines: true,
    transformHeader: h => h.replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim(),
  });
  const rows = parsed.data;

  const fiscalMap = new Map();
  for (const f of (allFiscais || [])) {
    if (f.nome) fiscalMap.set(normNomeVisa(f.nome), f.email || f.id);
  }

  const mesStr = String(mes).padStart(2, '0');
  const anoStr = String(ano);
  const rowsFiltradas = rows.filter(r => {
    const rawDt = String(r['DT_VISITA'] || '').replace(/"/g, '').trim();
    const dt = visaDataToISO(rawDt);
    return dt && dt.startsWith(`${anoStr}-${mesStr}-`);
  });

  onProgress(`📋 ${rowsFiltradas.length} inspeção(ões) encontrada(s) para ${mesStr}/${anoStr}.`, 'info');

  let criados = 0, atualizados = 0, ignorados = 0, erros = 0;
  const cnaeCache = new Map();

  for (const row of rowsFiltradas) {
    const controleVisa = String(row['CONTROLE'] || '').replace(/"/g, '').trim();
    if (!controleVisa) continue;

    const subclasse = String(row['Atividade'] || '').replace(/"/g, '').trim();
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
      cnaeInfo = cnaeCache.get(subclasse);
    }

    const { item, pontos } = complexToItem(cnaeInfo.complexidade);
    const dataISO = visaDataToISO(String(row['DT_VISITA'] || '').replace(/"/g, '').trim());
    const os = String(row['OS'] || row['NUMERO'] || '').replace(/"/g, '').trim();

    const descParts = ['Vistoria VISA'];
    if (os) descParts.push('OS ' + os);
    if (subclasse) descParts.push('CNAE ' + subclasse);
    if (cnaeInfo.descricao && cnaeInfo.descricao !== subclasse) descParts.push(cnaeInfo.descricao);
    const descricao = descParts.join(' — ');

    const fiscaisCsv = [
      String(row['Fiscal1'] || '').replace(/"/g, '').trim(),
      String(row['Fiscal2'] || '').replace(/"/g, '').trim(),
      String(row['Fiscal3'] || '').replace(/"/g, '').trim(),
    ].filter(Boolean);

    for (const nomeFiscalCsv of fiscaisCsv) {
      const emailFiscal = fiscalMap.get(normNomeVisa(nomeFiscalCsv));
      if (!emailFiscal) continue;
      if (fiscalEmail && emailFiscal !== fiscalEmail) continue;

      try {
        const existing = await window.db_getVISAManual(controleVisa, emailFiscal);

        if (existing) {
          if (existing.status === 'aceito' || existing.status === 'fechado') {
            ignorados++;
            onProgress(`⚠️ CONTROLE ${controleVisa} — ${nomeCurto(nomeFiscalCsv)}: já homologado, ignorado.`, 'warn');
            continue;
          }
          await window.db_upsertVISAManual(controleVisa, emailFiscal, {
            fiscal_nome: nomeFiscalCsv,
            mes, ano, data: dataISO,
            tipo_id: 1, tipo_codigo: 'VIS',
            tipo_nome: 'Vistoria ou atendimento a denúncia',
            item_pontuacao: item,
            complexidade: cnaeInfo.complexidade,
            pontos, descricao,
            origem: 'visa_csv',
            visa_controle: controleVisa,
          }, existing.id, false);
          atualizados++;
        } else {
          await window.db_upsertVISAManual(controleVisa, emailFiscal, {
            controle: 'VISA-' + controleVisa,
            fiscal_email: emailFiscal,
            fiscal_nome: nomeFiscalCsv,
            mes, ano, data: dataISO,
            tipo_id: 1, tipo_codigo: 'VIS',
            tipo_nome: 'Vistoria ou atendimento a denúncia',
            item_pontuacao: item,
            complexidade: cnaeInfo.complexidade,
            pontos, descricao,
            status: 'enviado',
            origem: 'visa_csv',
            visa_controle: controleVisa,
          }, null, true);
          criados++;
        }
      } catch(e) {
        erros++;
        onProgress('🚨 Erro CONTROLE ' + controleVisa + ': ' + e.message, 'danger');
      }
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
}

window.visaMesAberto         = visaMesAberto;
window.importarInspecoesVISA = importarInspecoesVISA;
