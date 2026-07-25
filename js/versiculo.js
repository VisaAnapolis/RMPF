/**
 * js/versiculo.js — VERSÍCULO DO DIA
 *
 * Toast central com um versículo bíblico, exibido nas páginas
 * autenticadas. Conteúdo em data/versiculos.json (Almeida Revista e
 * Corrigida — domínio público).
 *
 * Comportamento:
 *  - aparece centralizado e some sozinho; escurece o fundo para dar
 *    contraste, mas não bloqueia o clique no que está atrás;
 *  - 1x por abertura do app (não repete navegando entre telas);
 *  - o versículo é o mesmo para todos os usuários no mesmo dia,
 *    calculado a partir da data civil de Brasília;
 *  - cede a vez ao convite de push (#fcm-invite-modal) sem consumir o
 *    slot do dia.
 *
 * Disparado por js/guard.js depois que a autenticação resolve.
 */
(function () {
  'use strict';

  if (window.__rmpfVersiculoInit) return;
  window.__rmpfVersiculoInit = true;

  var SS_SESSAO = 'rmpf_versiculo_sessao';
  var ABRIR_DELAY_MS = 1500;
  var VISIVEL_MS = 7000;
  var FADE_OUT_MS = 500;

  var cfg = null;
  var toast = null;
  var timerSaida = null;

  /* ── Data ───────────────────────────────────────────────── */

  // Data civil de Brasília ('YYYY-MM-DD'): o versículo vira à meia-noite
  // BRT para todo mundo, não à meia-noite do fuso do navegador.
  function hojeISO() {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
    } catch (e) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  /* ── Seleção determinística ─────────────────────────────── */

  // Date.parse('YYYY-MM-DD') é lido como UTC dos dois lados, então a
  // diferença não sofre com fuso nem com horário de verão.
  function diasDesdeInicio(dataISO) {
    var d = Math.floor((Date.parse(dataISO) - Date.parse(cfg.inicio)) / 86400000);
    return (isFinite(d) && d > 0) ? d : 0;
  }

  // Abertura: sequência tocada uma única vez, cada item com sua duração
  // em dias. Depois dela, os rotativos entram em loop (1 dia cada) — a
  // abertura nunca se repete.
  function versiculoDoDia(dataISO) {
    if (!cfg) return null;
    var dias = diasDesdeInicio(dataISO || hojeISO());
    var acc = 0;
    var abertura = cfg.abertura || [];
    for (var i = 0; i < abertura.length; i++) {
      acc += (abertura[i].dias || 1);
      if (dias < acc) return abertura[i];
    }
    var rot = cfg.rotativos || [];
    if (!rot.length) return abertura.length ? abertura[abertura.length - 1] : null;
    return rot[(dias - acc) % rot.length];
  }

  /* ── Guarda por sessão ──────────────────────────────────── */

  // 1x por abertura do app: sessionStorage sobrevive à navegação entre
  // telas e morre quando o app/aba fecha — então reabrir mostra de novo.
  // O versículo em si continua sendo o do dia (ver versiculoDoDia).
  function deveMostrar() {
    try {
      return !sessionStorage.getItem(SS_SESSAO);
    } catch (e) {
      return true;
    }
  }

  function marcarMostrado() {
    try {
      sessionStorage.setItem(SS_SESSAO, '1');
    } catch (e) { /* modo privado: reaparece na próxima navegação */ }
  }

  /* ── Precedência: convite de push ───────────────────────── */

  function outroPopupVisivel() {
    if (document.getElementById('fcm-invite-modal')) return true;
    var backdrops = document.querySelectorAll('.modal-backdrop');
    for (var i = 0; i < backdrops.length; i++) {
      if (getComputedStyle(backdrops[i]).display !== 'none') return true;
    }
    return false;
  }

  /* ── UI ─────────────────────────────────────────────────── */

  function fechar() {
    if (!toast) return;
    clearTimeout(timerSaida);
    document.removeEventListener('click', fechar, true);
    var alvo = toast;
    toast = null;
    alvo.classList.remove('is-on');
    setTimeout(function () {
      if (alvo.parentNode) alvo.parentNode.removeChild(alvo);
    }, FADE_OUT_MS);
  }

  function abrir(versiculo) {
    if (!versiculo) return;
    fechar();

    // O wrapper escurece a tela para dar contraste, mas pointer-events:none
    // deixa o clique passar para o que está atrás. Como o véu não recebe o
    // clique, é o listener no document (abaixo) que dispensa o versículo.
    toast = document.createElement('div');
    toast.id = 'rmpfVersiculoToast';
    toast.className = 'versiculo-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    var card = document.createElement('div');
    card.className = 'versiculo-card';

    var texto = document.createElement('p');
    texto.className = 'versiculo-card__texto';
    texto.textContent = '“' + versiculo.texto + '”';

    var ref = document.createElement('p');
    ref.className = 'versiculo-card__ref';
    ref.textContent = versiculo.ref;

    card.appendChild(texto);
    card.appendChild(ref);
    card.addEventListener('click', fechar);
    toast.appendChild(card);
    document.body.appendChild(toast);

    void toast.offsetWidth; // força o reflow para a transição de entrada
    toast.classList.add('is-on');

    // Qualquer clique/toque na tela dispensa (a captura roda antes do
    // handler do elemento clicado, mas não o impede de receber o clique).
    document.addEventListener('click', fechar, true);

    timerSaida = setTimeout(fechar, VISIVEL_MS);
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && toast) fechar();
  });

  /* ── Entrada pública (chamada por js/guard.js) ──────────── */

  function mostrarVersiculoDoDia() {
    var versao = window.APP_VERSION || '0';
    fetch('data/versiculos.json?v=' + versao)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) {
        if (!json || (!json.abertura && !json.rotativos)) return;
        cfg = json;
        if (!deveMostrar()) return;
        setTimeout(function () {
          // revalida: outra aba pode ter exibido o versículo durante a espera
          if (!deveMostrar()) return;
          // cede a vez ao convite de push sem consumir o slot diário
          if (outroPopupVisivel()) return;
          var v = versiculoDoDia();
          if (!v) return;
          marcarMostrado();
          abrir(v);
        }, ABRIR_DELAY_MS);
      })
      .catch(function () { /* sem rede/JSON → sem toast, silencioso */ });
  }

  window.rmpfMostrarVersiculoDoDia = mostrarVersiculoDoDia;

  /* ── API de debug ───────────────────────────────────────── */

  window.RmpfVersiculo = {
    abrir: function () { abrir(versiculoDoDia()); },
    fechar: fechar,
    doDia: function (dataISO) { return versiculoDoDia(dataISO); },
    reset: function () {
      try { sessionStorage.removeItem(SS_SESSAO); } catch (e) {}
    }
  };
})();
