// js/insp360.js
// Lançamento 360 — inspeção digitada no RMPF durante a fase de transição do
// CVS (WCVS/Paradox) para o novo sistema transacional "360".
// Regras e modelo de dados: docs/lancamento-360.md.
//
// O CÁLCULO é o mesmo da importação do inspecoes.csv: montarAlvosInspecaoVisa
// e regraDiaVistoriaVisa (js/visa-import.js). Este módulo só monta as entradas
// a partir do formulário, aplica o que é próprio do 360 (modalidade fixa, sem
// OS) e grava inspeção + lançamentos.
//
// Depende de: js/utils.js, js/firestore.js, js/visa-import.js (e, no navegador,
// js/plantao-escala.js para a escala de plantão do fiscal logado).

(function () {
  'use strict';

  // Modalidade única do 360 enquanto os dados de OS não migram: sem número de
  // OS/Ofício/Protocolo/Denúncia, sem prazo e sem "fora do prazo".
  const MODALIDADE_360 = 'TRANSIÇÃO 360';

  // Documentos lavrados (campo TIPO do inspecoes.csv), na grafia do WCVS.
  const DOCUMENTOS_360 = [
    'TERMO DE INTIMAÇÃO',
    'TERMO DE NOTIFICAÇÃO',
    'AUTO DE INFRAÇÃO',
    'AUTO DE IMPOSIÇÃO DE PENALIDADE',
    'ORIENTAÇÃO SANITÁRIA',
    'ANÁLISE DE RPA',
    'CERTIDÃO',
    'ANÁLISE DE PAS',
    'MANIFESTAÇÃO DO FISCAL AUTUANTE',
    'PRORROGAÇÃO',
    'RELATÓRIO TÉCNICO',
    'RELATÓRIO HARMONIZADO',
    'TERMO DE COLETA DE AMOSTRA',
  ];

  // Sem OS não há autorização prévia a conferir: o 3º fiscal em diante entra
  // pendente e o administrador autoriza na Conferência, como no CVS.
  const MOTIVO_PENDENCIA_360 =
    'Inspeção com mais de dois fiscais — no Lançamento 360 não há OS para conferir a autorização prévia; aguarda autorização do administrador';

  // Status que travam o lançamento: o 360 nunca os altera nem apaga.
  const STATUS_TRAVADOS = ['aceito', 'homologado', 'fechado', 'recusado'];
  const ehTravado = (m) => !!m && STATUS_TRAVADOS.includes(m.status);

  function ehParticipante360(usuario) {
    return !!usuario && usuario.transicao360 === true && usuario.ativo !== false;
  }

  // ── Dados de referência (repositório VISA, via fetchGitHubCSV) ─────────
  const _cache = { cnaeMap: null, regIndex: null, municipal: null, taxa: null, regAtiv: new Map() };

  async function carregarCnaeMap() {
    if (_cache.cnaeMap) return _cache.cnaeMap;
    const txt = await window.fetchGitHubCSV('data/cnae.csv');
    if (txt === null) throw new Error('data/cnae.csv não encontrado no repositório VISA.');
    _cache.cnaeMap = window.montarCnaeMapVisa(txt);
    return _cache.cnaeMap;
  }

  async function carregarIndiceRegulados() {
    if (_cache.regIndex) return _cache.regIndex;
    const txt = await window.fetchGitHubCSV('data/index_regulados.json');
    if (txt === null) throw new Error('data/index_regulados.json não encontrado no repositório VISA.');
    const json = JSON.parse(String(txt).replace(/^﻿/, ''));
    _cache.regIndex = (json.dados || []).map(r => ({
      codigo: String(r.codigo),
      razao: r.razao || '',
      fantasia: r.fantasia || '',
      documento: r.documento || '',
      _busca: window.normNomeVisa([r.codigo, r.razao, r.fantasia, r.documento,
        String(r.documento || '').replace(/\D/g, '')].join(' ')),
    }));
    return _cache.regIndex;
  }

  // Atividades cadastradas do regulado (data/reg/XX/XXXXX.json) — só sugestão
  // de CNAE no formulário; a pontuação vem sempre do cnae.csv.
  async function carregarAtividadesRegulado(codigo) {
    const cod = String(codigo || '').trim();
    if (!cod) return [];
    if (_cache.regAtiv.has(cod)) return _cache.regAtiv.get(cod);
    let lista = [];
    try {
      const p = cod.padStart(5, '0');
      const txt = await window.fetchGitHubCSV(`data/reg/${p.slice(0, 2)}/${p}.json`);
      if (txt) {
        const j = JSON.parse(String(txt).replace(/^﻿/, ''));
        lista = (j.atividades || []).map(a => ({
          subclasse: a.subclasse, tipo: a.tipo || '', atividade: a.atividade || '',
        })).filter(a => a.subclasse);
      }
    } catch (e) {
      console.warn('[360] Atividades do regulado indisponíveis:', e && e.message);
    }
    _cache.regAtiv.set(cod, lista);
    return lista;
  }

  // Área (m²) do regulado: CODIGO → inscrição municipal (regulados.csv) →
  // metragem (taxa.csv). Mesma cadeia da importação; os dois arquivos são
  // grandes e só são baixados quando há CNAE de alta complexidade de alimentação.
  async function resolverAreaRegulado(codigo) {
    const cod = String(codigo || '').trim();
    if (!cod) return null;
    try {
      if (!_cache.municipal) {
        const txt = await window.fetchGitHubCSV('data/regulados.csv');
        const mapa = new Map();
        if (txt !== null) {
          const parsed = Papa.parse(txt, {
            header: true, delimiter: ';', skipEmptyLines: true,
            transformHeader: h => h.replace(/^﻿/, '').replace(/^"|"$/g, '').trim(),
          });
          for (const r of parsed.data) {
            const c = String(r['CODIGO'] || r['Codigo'] || '').replace(/"/g, '').trim();
            if (!c || mapa.has(c)) continue;
            mapa.set(c, window.normMunicipalVisa(r['MUNICIPAL'] || r['Municipal'] || ''));
          }
        }
        _cache.municipal = mapa;
      }
      const municipal = _cache.municipal.get(cod) || '';
      if (!municipal) return null;
      if (!_cache.taxa) {
        const txt = await window.fetchGitHubCSV('data/taxa.csv');
        _cache.taxa = txt !== null ? window.parseTaxaArea(txt) : new Map();
      }
      const area = _cache.taxa.get(municipal);
      return area == null ? null : area;
    } catch (e) {
      console.warn('[360] Área do regulado indisponível — pontuação máxima (48):', e && e.message);
      return null;
    }
  }

  function municipalDoRegulado(codigo) {
    return (_cache.municipal && _cache.municipal.get(String(codigo || '').trim())) || '';
  }

  // ── Cálculo ────────────────────────────────────────────────────────────
  // `insp` (formulário):
  //   { numero?, codigo, razao, data (ISO), documento, numeroDoc, entregue (bool),
  //     cnae, cnaesExtras: [], fiscais: [{ nome, email, eh360 }] }
  // `ctx`:
  //   { cnaeMap, regraAreaAtiva, resolverArea(codigo),
  //     usuarioEmail,                    // fiscal logado (regras do dia só para ele)
  //     estadoPontosUsuario,             // _getEstadoPontosVisa do logado (ou null)
  //     diaCobertoUsuario }              // true = dia coberto por ocorrência aceita
  // Retorna { tipoInfo, alvos, naoLancados, extrasDesconsiderados, semCompetencia, porFiscal: [...] }.
  async function calcularInspecao360(insp, ctx) {
    const cnaeMap = ctx.cnaeMap;
    const subclasse = String(insp.cnae || '').trim();
    const subInfo = subclasse ? cnaeMap.get(subclasse) : null;
    const cnaeInfo = subInfo
      ? { complexidade: subInfo.complexidade, descricao: subInfo.descricao }
      : { complexidade: 'média', descricao: subclasse };
    const complexidadeOrigemInformado = subInfo ? (subInfo.complexidade_origem || null) : null;
    const tipoRaw = String(insp.documento || '').trim();
    const tipoInfo = window.resolverTipoVisa(tipoRaw, cnaeInfo.complexidade);

    // Fiscais: dedup por nome normalizado, na ordem informada (1º, 2º, 3º…).
    const vistos = new Set();
    const fiscais = [];
    for (const f of (insp.fiscais || [])) {
      const nome = String(f && f.nome || '').trim();
      const norm = window.normNomeVisa(nome);
      if (!norm || vistos.has(norm)) continue;
      vistos.add(norm);
      fiscais.push({ nome, email: f.email || null, eh360: !!f.eh360 });
    }
    const nomesParticipantes = fiscais.map(f => f.nome);

    const cnaesExtras = [];
    for (const c of (insp.cnaesExtras || [])) {
      const v = String(c || '').trim();
      if (v && v !== subclasse && !cnaesExtras.includes(v)) cnaesExtras.push(v);
    }
    const semCompetencia = [];
    const alvos = await window.montarAlvosInspecaoVisa({
      tipoInfo,
      entregaFalse: insp.entregue === false,
      subclasse, subInfo, cnaeInfo, complexidadeOrigemInformado,
      cnaesExtras, cnaeMap,
      qtdFiscais: fiscais.length,
      regraAreaAtiva: ctx.regraAreaAtiva !== false,
      resolverArea: () => (ctx.resolverArea ? ctx.resolverArea(insp.codigo) : null),
      onCnaeSemCompetencia: (c) => semCompetencia.push(c),
    });
    const lancados = new Set(alvos.map(a => a.cnae));
    const ehVis = tipoInfo.tipo_codigo === 'VIS';
    // Vistoria com documento NÃO entregue: como no CVS, os CNAEs extras não são
    // considerados — pontua só o CNAE informado. Demais tipos nunca usam extras.
    const extrasDesconsiderados = (!ehVis || insp.entregue === false) ? cnaesExtras.slice() : [];
    const naoLancados = (ehVis && insp.entregue !== false)
      ? [subclasse, ...cnaesExtras].filter(c => c && !lancados.has(c) && !semCompetencia.includes(c))
      : [];

    const dataISO = insp.data || null;
    const porFiscal = fiscais.map((f, idx) => {
      const isTerceiro = idx >= 2;
      const ehUsuario = !!(ctx.usuarioEmail && f.email === ctx.usuarioEmail);
      const res = {
        ...f, isTerceiro, ehUsuario, regrasDoDia: ehUsuario && !!ctx.estadoPontosUsuario,
        geraLancamento: !!(f.eh360 && f.email), ignoradoMotivo: null, lancamentos: [],
      };
      if (ehUsuario && ctx.diaCobertoUsuario) {
        res.geraLancamento = false;
        res.ignoradoMotivo = 'dia coberto por ocorrência aceita — não admite outros lançamentos';
      }
      // Estado do dia: o do logado (lido do banco) ou vazio para colegas — os
      // lançamentos deles não podem ser lidos pelo fiscal; a revalidação
      // automática da importação confere as regras do dia depois.
      const estado = res.regrasDoDia ? ctx.estadoPontosUsuario : {
        plantaoDatas: new Set(), escalaDatas: new Set(), opfDatas: new Set(), relAltaDatas: new Set(),
      };
      for (const alvo of alvos) {
        const tipoInfoA = window.resolverTipoVisa(tipoRaw, alvo.complexidade);
        const pontosBaseA = (alvo.pontos != null) ? alvo.pontos : tipoInfoA.pontos;
        const r = window.regraDiaVistoriaVisa({
          tipoInfoA, dataISO, pontosFinalA: pontosBaseA, pontosBaseA,
          plantaoFiscalOS: false, estadoPontos: estado, alvo,
        });
        const descParts = [];
        if (alvo.cnae) descParts.push('CNAE ' + alvo.cnae);
        if (alvo.descricao && alvo.descricao !== alvo.cnae) descParts.push(alvo.descricao);
        const status = isTerceiro ? 'pendente' : 'enviado';
        res.lancamentos.push({
          alvo, tipoInfoA, pontos: r.pontosFiscal, zeradoMotivo: r.zeradoMotivo,
          status,
          dispositivo_legal: window.dispositivoLegal
            ? window.dispositivoLegal(tipoInfoA.item_pontuacao, r.pontosFiscal, alvo.qtd_fiscais != null,
                r.itemDecretoZerado || r.itemDecretoAlimentacao || undefined)
            : null,
          descricao: descParts.join(' — ') || tipoInfoA.descLabel,
        });
      }
      res.totalPontos = window.round2
        ? window.round2(res.lancamentos.reduce((s, l) => s + (Number(l.pontos) || 0), 0))
        : res.lancamentos.reduce((s, l) => s + (Number(l.pontos) || 0), 0);
      return res;
    });

    return { tipoInfo, alvos, naoLancados, extrasDesconsiderados, semCompetencia, porFiscal, nomesParticipantes };
  }

  // Documento `manuais` de um lançamento — mesmos campos que a importação do
  // CVS grava, com a origem e a modalidade do 360.
  function montarDocLancamento360(numero, insp, calc, fiscal, lanc) {
    const [ano, mes] = String(insp.data).split('-').map(Number);
    const fiscais = calc.porFiscal;
    return {
      controle: numero,
      fiscal_email: fiscal.email,
      fiscal_nome: fiscal.nome,
      mes, ano, data: insp.data,
      tipo_id: lanc.tipoInfoA.tipo_id, tipo_codigo: lanc.tipoInfoA.tipo_codigo,
      tipo_nome: lanc.tipoInfoA.tipo_nome,
      item_pontuacao: lanc.tipoInfoA.item_pontuacao,
      complexidade: lanc.alvo.complexidade,
      complexidade_decreto: !!lanc.alvo.complexidade_origem,
      complexidade_origem: lanc.alvo.complexidade_origem || null,
      pontos: lanc.pontos,
      descricao: lanc.descricao,
      zerado_motivo: lanc.zeradoMotivo,
      motivo_os: MODALIDADE_360,
      os_numero: '',
      prazo_os: null,
      fora_do_prazo: false,
      documento: String(insp.documento || '').trim(),
      numero: insp.numeroDoc ? String(insp.numeroDoc).trim() : null,
      status: lanc.status,
      motivo_pendencia: lanc.status === 'pendente' ? MOTIVO_PENDENCIA_360 : null,
      origem: 'insp360',
      insp360_numero: numero,
      insp360_editores: fiscais.filter(f => f.eh360 && f.email).map(f => f.email),
      visa_cnae: lanc.alvo.cnae,
      cnae_origem: lanc.alvo.cnae_origem,
      codigo: String(insp.codigo || ''),
      razao: insp.razao || '',
      municipal: insp.municipal || '',
      visa_area: lanc.alvo.visa_area ?? null,
      qtd_fiscais: lanc.alvo.qtd_fiscais ?? null,
      fiscais_participantes: fiscais.length >= 2 ? calc.nomesParticipantes : null,
      dispositivo_legal: lanc.dispositivo_legal,
    };
  }

  // ── Gravação ───────────────────────────────────────────────────────────
  // `existente`: doc insp360 quando é edição (null para nova inspeção).
  // Só cria/atualiza/apaga lançamentos editáveis (enviado/pendente); os
  // travados (homologado, fechado, recusado) ficam intocados e continuam
  // ligados à inspeção. Retorna { numero, criados, atualizados, removidos, preservados }.
  async function salvarInspecao360({ insp, calc, existente, usuario }) {
    const [ano, mes] = String(insp.data).split('-').map(Number);
    const numero = existente ? existente.numero : await window.db_proximoNumeroInsp360(ano);
    const editores = calc.porFiscal.filter(f => f.eh360 && f.email).map(f => f.email);
    if (!editores.includes(usuario.email)) {
      throw new Error('Você precisa constar entre os fiscais da inspeção para salvá-la.');
    }

    const criar = [], atualizar = [], remover = [], preservados = [];
    const alvosIds = new Set();
    for (const f of calc.porFiscal) {
      if (!f.geraLancamento) continue;
      for (const l of f.lancamentos) {
        const id = window.db_insp360DocId(numero, f.email, l.alvo.cnae);
        alvosIds.add(id);
        const data = montarDocLancamento360(numero, insp, calc, f, l);
        const atual = existente ? await window.db_getManualPorId(id) : null;
        if (!atual) criar.push({ id, data });
        else if (ehTravado(atual)) preservados.push(atual);
        else atualizar.push({ id, data });
      }
    }
    for (const id of ((existente && existente.lancamentos) || [])) {
      if (alvosIds.has(id)) continue;
      const atual = await window.db_getManualPorId(id);
      if (!atual) continue;                       // já não existe (ex.: apagado por ocorrência)
      if (ehTravado(atual)) preservados.push(atual);
      else remover.push(id);
    }

    const lancamentos = [...alvosIds].filter(id => !preservados.some(p => p.id === id))
      .concat(preservados.map(p => p.id));
    const chaves = [...new Set([
      ...editores.map(e => window.db_insp360ChaveListagem(mes, ano, e)),
      // Preserva a listagem para quem tinha lançamento travado nesta inspeção.
      ...preservados.map(p => window.db_insp360ChaveListagem(p.mes, p.ano, p.fiscal_email)),
    ])];
    const inspecao = {
      numero,
      codigo: String(insp.codigo || ''),
      razao: insp.razao || '',
      municipal: insp.municipal || '',
      data: insp.data, mes, ano,
      documento: String(insp.documento || '').trim(),
      numero_documento: insp.numeroDoc ? String(insp.numeroDoc).trim() : null,
      entregue: insp.entregue !== false,
      modalidade: MODALIDADE_360,
      cnae: String(insp.cnae || '').trim(),
      cnaes_extras: (insp.cnaesExtras || []).filter(Boolean),
      fiscais: calc.porFiscal.map(f => ({ nome: f.nome, email: f.email || null, eh360: !!f.eh360 })),
      editores, chaves, lancamentos: [...new Set(lancamentos)],
      alterado_por: usuario.email,
    };
    if (!existente) inspecao.criado_por = usuario.email;

    await window.db_gravarInsp360({ inspecao, novaInspecao: !existente, criar, atualizar, remover });
    return { numero, criados: criar.length, atualizados: atualizar.length, removidos: remover.length, preservados };
  }

  // Exclusão: só quando nenhum lançamento da inspeção está travado.
  async function excluirInspecao360(existente) {
    const ids = [];
    for (const id of (existente.lancamentos || [])) {
      const atual = await window.db_getManualPorId(id);
      if (!atual) continue;
      if (ehTravado(atual)) {
        throw new Error(`O lançamento de ${atual.fiscal_nome || atual.fiscal_email} já foi ${atual.status} — a inspeção não pode mais ser excluída.`);
      }
      ids.push(id);
    }
    await window.db_excluirInsp360(existente.numero, ids);
    return ids.length;
  }

  window.MODALIDADE_360        = MODALIDADE_360;
  window.DOCUMENTOS_360        = DOCUMENTOS_360;
  window.MOTIVO_PENDENCIA_360  = MOTIVO_PENDENCIA_360;
  window.insp360EhTravado      = ehTravado;
  window.ehParticipante360     = ehParticipante360;
  window.insp360CarregarCnaeMap          = carregarCnaeMap;
  window.insp360CarregarIndiceRegulados  = carregarIndiceRegulados;
  window.insp360CarregarAtividadesRegulado = carregarAtividadesRegulado;
  window.insp360ResolverAreaRegulado     = resolverAreaRegulado;
  window.insp360MunicipalDoRegulado      = municipalDoRegulado;
  window.calcularInspecao360   = calcularInspecao360;
  window.montarDocLancamento360 = montarDocLancamento360;
  window.salvarInspecao360     = salvarInspecao360;
  window.excluirInspecao360    = excluirInspecao360;
})();
