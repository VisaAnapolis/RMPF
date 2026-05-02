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
  const pp = [
    ...ativCVS.map(a => Number(a.pontos) || 0),
    ...ativManuais
      .filter(a => a.status === 'aceito' || a.status === 'fechado')
      .map(a => Number(a.pontos_homologado != null ? a.pontos_homologado : a.pontos) || 0),
  ].reduce((s, v) => s + v, 0);

  const pn     = Number(pnsExtras) || 0;
  const pv     = Math.max(0, pp - pn);
  const pvLim  = Math.min(pv, PARAMS.teto_pv);
  const bruto  = (pvLim - PARAMS.base_formula) * PARAMS.fator_formula;
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

window.calcular = calcular;
window.CALC_PARAMS = PARAMS;
