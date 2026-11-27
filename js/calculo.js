// js/calculo.js

const PARAMS = {
  teto_pv:      1000,
  base_formula: 250,
  fator_formula: 0.2666,
  teto_final:   200,
};

/**
 * Calcula a apuração de produtividade.
 * @param {Array} ativCVS    - Atividades importadas do CVS (cada item com .pontos)
 * @param {Array} ativManuais - Atividades manuais (cada item com .status, .pontos, .pontos_homologado)
 * @param {number} pnsExtras  - Pontos negativos / glosas
 */
function calcular(ativCVS = [], ativManuais = [], pnsExtras = 0) {
  // round2 evita que o ruído de ponto flutuante da soma de muitas parcelas
  // decimais (ex.: rateio de ocorrências a 45.45 pts/dia) vaze para a tela
  // (ex.: "636.3000000000001") ou desvie o Math.ceil() da apuração final.
  const pp = round2([
    ...ativCVS.map(a => Number(a.pontos) || 0),
    ...ativManuais
      .filter(a => a.status === 'aceito' || a.status === 'fechado' || a.status === 'homologado')
      .map(a => Number(a.pontos_homologado != null ? a.pontos_homologado : a.pontos) || 0),
  ].reduce((s, v) => s + v, 0));

  const pn     = round2(Number(pnsExtras) || 0);
  const pv     = round2(Math.max(0, pp - pn));
  const pvLim  = round2(Math.min(pv, PARAMS.teto_pv));
  const bruto  = round2((pvLim - PARAMS.base_formula) * PARAMS.fator_formula);
  const apuracao = Math.max(0, Math.ceil(Math.min(bruto, PARAMS.teto_final)));

  return {
    pp,
    pn,
    pv,
    pvLim,
    bruto,
    apuracao,
    atingiuTetoPV:    pv > PARAMS.teto_pv,
    atingiuTetoFinal: bruto > PARAMS.teto_final,
  };
}

/**
 * Pontos ainda NÃO homologados, separados pelo motivo da espera. Fonte única
 * dos cartões "Pts Enviados" e "Aguardando Autorização" — Dashboard (fiscal e
 * administrador), Meus Lançamentos e Conferência usam esta mesma conta, para
 * que as telas nunca mostrem totais diferentes para a mesma competência.
 *  - enviados:    status 'enviado'  → aguardam a homologação do gestor;
 *  - autorizacao: status 'pendente' → 3º fiscal em diante aguardando a
 *                 autorização do gestor (não entram em "enviados").
 * Nenhum dos dois entra no PP: só pontua o que foi homologado.
 */
function resumoPontosAguardando(ativManuais = []) {
  let enviados = 0, autorizacao = 0, qtdEnviados = 0, qtdAutorizacao = 0;
  for (const a of ativManuais) {
    if (!a) continue;
    if (a.status === 'enviado') {
      enviados += Number(a.pontos) || 0; qtdEnviados++;
    } else if (a.status === 'pendente') {
      autorizacao += Number(a.pontos) || 0; qtdAutorizacao++;
    }
  }
  return {
    enviados: round2(enviados), qtdEnviados,
    autorizacao: round2(autorizacao), qtdAutorizacao,
  };
}

window.calcular = calcular;
window.resumoPontosAguardando = resumoPontosAguardando;
window.CALC_PARAMS = PARAMS;
