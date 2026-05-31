// js/notifications.js
// Disparador de notificações push via GitHub Actions + FCM HTTP v1.
//
// Fluxo:
//   1. Busca o campo rmpf_fcmTokens (array, exclusivo do RMPF) em usuarios/{email}.
//      Tokens legados fcmTokens e fcm_token NÃO são usados: ambos estão vinculados
//      ao service worker do VISA e fariam a notificação abrir o app VISA.
//      Usuários sem rmpf_fcmTokens precisam fazer login novamente no RMPF.
//   2. Obtém o PAT do GitHub de app_config/github_token via db_getGitHubToken()
//      (função definida em js/firestore.js, exportada como window.db_getGitHubToken)
//   3. Despacha um repository_dispatch "notify-fiscal" por token
//   4. O workflow notify-fiscal.yml chama FCM HTTP v1 e entrega o push
//
// Falhas são silenciosas (console.warn) para não bloquear o fluxo principal.

const _NOTIF_REPO = 'garrado/RMPF';

/**
 * Envia uma notificação push a um fiscal específico.
 * Falha silenciosamente — nunca lança exceção.
 *
 * @param {string} fiscalEmail  E-mail do fiscal destinatário
 * @param {string} titulo       Título da notificação
 * @param {string} corpo        Corpo/texto da notificação
 */
async function dispararNotificacaoFiscal(fiscalEmail, titulo, corpo) {
  try {
    const snap = await window.db.collection('usuarios').doc(fiscalEmail).get();
    if (!snap.exists) return;

    const data = snap.data() || {};
    const tokens = Array.isArray(data.rmpf_fcmTokens)
      ? data.rmpf_fcmTokens.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim())
      : [];

    if (!tokens.length) return; // Fiscal sem rmpf_fcmTokens — precisa fazer login no RMPF para registrar

    const ghToken = await window.db_getGitHubToken();
    if (!ghToken) {
      console.warn('[notif] Token do GitHub não configurado — notificação não enviada.');
      return;
    }

    // Dispara um repository_dispatch por token (um por dispositivo registrado)
    await Promise.all([...new Set(tokens)].map(async (fcm_token) => {
      const resp = await fetch(`https://api.github.com/repos/${_NOTIF_REPO}/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + ghToken,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event_type: 'notify-fiscal',
          client_payload: { fcm_token, titulo, corpo },
        }),
      });

      if (!resp.ok && resp.status !== 204) {
        console.warn('[notif] Falha ao despachar notificação: HTTP', resp.status);
      }
    }));
  } catch (e) {
    console.warn('[notif] Erro ao enviar notificação push:', e);
  }
}

window.dispararNotificacaoFiscal = dispararNotificacaoFiscal;

/**
 * Dispara um e-mail HTML a um fiscal via GitHub Actions (notify-fiscal-email).
 * Falha silenciosamente — nunca lança exceção.
 *
 * @param {string} fiscalEmail  E-mail do fiscal destinatário
 * @param {string} fiscalNome   Nome do fiscal
 * @param {string} titulo       Assunto / título do e-mail
 * @param {string} corpo        Corpo da mensagem (pode conter HTML simples)
 */
async function dispatchEmailFiscal(fiscalEmail, fiscalNome, titulo, corpo) {
  try {
    const ghToken = await window.db_getGitHubToken();
    if (!ghToken) {
      console.warn('[notif] Token do GitHub não configurado — e-mail não enviado.');
      return;
    }

    const resp = await fetch(`https://api.github.com/repos/${_NOTIF_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + ghToken,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_type: 'notify-fiscal-email',
        client_payload: {
          fiscal_email: fiscalEmail,
          fiscal_nome:  fiscalNome,
          titulo:       titulo,
          corpo:        corpo,
        },
      }),
    });

    if (!resp.ok && resp.status !== 204) {
      console.warn('[notif] Falha ao despachar e-mail: HTTP', resp.status);
    }
  } catch (e) {
    console.warn('[notif] Erro ao enviar e-mail ao fiscal:', e);
  }
}

window.dispatchEmailFiscal = dispatchEmailFiscal;
