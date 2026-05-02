/**
 * ─────────────────────────────────────────────────────────────
 * RMPF — GERENCIAMENTO CENTRALIZADO DE VERSÃO
 * ─────────────────────────────────────────────────────────────
 *
 * Arquivo único de verdade para versionamento da aplicação.
 * Altere APENAS aqui e a versão será refletida em TODAS as páginas.
 *
 * ⚠️  IMPORTANTE: Ao atualizar a versão aqui, atualize também:
 *    - service-worker.js → CACHE_NAME = 'rmpf-v{versão}'
 *    - changelog.html    → adicione entrada da nova versão
 */

const APP_VERSION = '1.3.0';

// Expõe no objeto window para compatibilidade com guard.js e outros scripts
window.APP_VERSION = APP_VERSION;

// Preenche elementos com id="appVersion" ou id="footer-version" em qualquer página
document.addEventListener('DOMContentLoaded', function () {
  ['appVersion', 'footer-version'].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.textContent = APP_VERSION;
  });
});
