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

  // Linha do tempo, a partir do momento em que o toast aparece:
  // 0 → 0,4s entra esmaecendo | até 4s parado a 100% | 4s → 7s dissolve | 7s sai.
  var ENTRADA_MS = 400;
  var SOLIDO_MS = 4000;
  var DISSOLVER_MS = 3000;
  var SAIDA_RAPIDA_MS = 250;  // quando o usuário dispensa antes da hora

  var cfg = null;
  var toast = null;
  var timerSaida = null;
  var rafId = null;

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

  /* ── Interruptor (editado no admin.html do VISA) ─────────── */

  // app_config/versiculo_do_dia é ÚNICO para os dois sistemas: VISA e RMPF
  // vivem no mesmo projeto Firebase, e o controle fica só na tela de admin do
  // VISA. Mesmo padrão de leitura de _resolvePromoConfig (firebase-config.js),
  // que já consulta app_config para qualquer usuário autenticado.
  // Falha de leitura cai no último valor conhecido e, sem ele, em "ligado" —
  // rede instável não pode apagar a feature.
  var LS_CONFIG = 'rmpf_versiculo_config';

  function ultimoConhecido() {
    try { return localStorage.getItem(LS_CONFIG) !== '0'; } catch (e) { return true; }
  }

  function resolverAtivo() {
    // Sem Firestore à mão (ordem de scripts, página fora do guard) não dá para
    // consultar: honra o último valor conhecido em vez de sumir sem explicação.
    if (!window.db || typeof window.db.collection !== 'function') {
      return Promise.resolve(ultimoConhecido());
    }
    return window.db.collection('app_config').doc('versiculo_do_dia').get()
      .then(function (snap) {
        var ativo = !snap.exists || (snap.data() || {}).ativo !== false;
        try { localStorage.setItem(LS_CONFIG, ativo ? '1' : '0'); } catch (e) {}
        return ativo;
      })
      .catch(ultimoConhecido);
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

  /* ── Animação ───────────────────────────────────────────── */

  // A opacidade é escrita quadro a quadro em style.opacity, e não por
  // `transition` no CSS, de propósito: o bloco prefers-reduced-motion já matou
  // esta animação antes, e o mesmo vale para qualquer reset global futuro.
  // Estilo inline não é alcançado por folha de estilo nenhuma, então o
  // dissolver acontece em qualquer configuração do aparelho.
  function anima(el, de, para, duracaoMs, aoFim) {
    var inicio = null;
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(function passo(agora) {
      if (inicio === null) inicio = agora;
      var t = Math.min(1, (agora - inicio) / duracaoMs);
      el.style.opacity = String(de + (para - de) * t);
      if (t < 1) rafId = requestAnimationFrame(passo);
      else if (aoFim) aoFim();
    });
  }

  /* ── UI ─────────────────────────────────────────────────── */

  function remover(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function opacidadeAtual(el) {
    var v = parseFloat(el.style.opacity);
    return isNaN(v) ? 1 : v;
  }

  // Dispensa antes da hora (clique/Esc): dissolve rápido em vez de sumir seco.
  function fechar() {
    if (!toast) return;
    clearTimeout(timerSaida);
    cancelAnimationFrame(rafId);
    document.removeEventListener('click', fechar, true);
    var alvo = toast;
    toast = null;
    alvo.classList.remove('is-on');
    anima(alvo, opacidadeAtual(alvo), 0, SAIDA_RAPIDA_MS, function () {
      remover(alvo);
    });
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

    toast.style.opacity = '0';
    void toast.offsetWidth;      // reflow: o cartão desliza para o lugar
    toast.classList.add('is-on');

    // Qualquer clique/toque na tela dispensa (a captura roda antes do
    // handler do elemento clicado, mas não o impede de receber o clique).
    document.addEventListener('click', fechar, true);

    var alvo = toast;
    anima(alvo, 0, 1, ENTRADA_MS);
    // Fica 100% visível até os 4s e então dissolve por 3s, saindo aos 7s.
    // `toast` só é zerado no fim: assim clique e Esc continuam dispensando
    // durante a dissolução.
    timerSaida = setTimeout(function () {
      if (toast !== alvo) return;   // já foi dispensado nesse meio-tempo
      anima(alvo, 1, 0, DISSOLVER_MS, function () {
        if (toast === alvo) {
          document.removeEventListener('click', fechar, true);
          toast = null;
        }
        remover(alvo);
      });
    }, SOLIDO_MS);
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
        // Desligado no admin do VISA: não exibe e NÃO consome o slot da sessão,
        // para que religar traga o versículo de volta sem reabrir o app.
        return resolverAtivo().then(function (ativo) {
          if (!ativo) return;
          setTimeout(function () {
            // revalida: outra aba pode ter exibido o versículo durante a espera
            if (!deveMostrar()) return;
            // cede a vez ao convite de push sem consumir o slot da sessão
            if (outroPopupVisivel()) return;
            var v = versiculoDoDia();
            if (!v) return;
            marcarMostrado();
            abrir(v);
          }, ABRIR_DELAY_MS);
        });
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
