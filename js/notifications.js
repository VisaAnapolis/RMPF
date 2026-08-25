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

/**
 * Avisa que um lançamento recusado foi alterado no WCVS depois da recusa.
 *
 * A importação grava a marca (recusa_alterado_diff) e as telas mostram o ícone
 * vermelho — mas a importação roda em background na sessão do administrador, e
 * sem push/e-mail a alteração ficaria esperando alguém abrir o app. O fiscal
 * precisa saber que a correção dele não teve efeito; o gestor, que mexeram no
 * que já julgou.
 *
 * Falha silenciosamente — a importação nunca pode quebrar por causa disto.
 *
 * @param {object} manual  Lançamento recusado (fiscal_email, fiscal_nome, controle, id)
 */
async function notificarRecusaAlterada(manual) {
  try {
    if (!manual || !manual.fiscal_email) return;
    const controle = manual.controle || manual.id || '';
    const nome = manual.fiscal_nome || manual.fiscal_email;

    const tituloFiscal = '⛔ Alteração no WCVS não teve efeito';
    const corpoFiscal =
      `O lançamento ${controle}, recusado, foi alterado no WCVS mas a recusa continua ` +
      `valendo. Se a correção resolve o motivo, procure o gestor.`;

    const tituloAdmin = '⛔ Lançamento recusado foi alterado no WCVS';
    const corpoAdmin =
      `O lançamento ${controle} do fiscal ${nome} foi alterado no WCVS depois da recusa. ` +
      `A importação não aplicou a mudança — use Rever na Conferência se corrigir o motivo.`;

    const envios = [
      dispararNotificacaoFiscal(manual.fiscal_email, tituloFiscal, corpoFiscal),
      dispatchEmailFiscal(manual.fiscal_email, manual.fiscal_nome, tituloFiscal, corpoFiscal),
    ];

    const admins = typeof window.db_getTodosAdministradores === 'function'
      ? await window.db_getTodosAdministradores()
      : [];
    for (const adm of admins) {
      const email = adm.id || adm.email;
      if (!email) continue;
      envios.push(dispararNotificacaoFiscal(email, tituloAdmin, corpoAdmin));
      envios.push(dispatchEmailFiscal(email, adm.nome, tituloAdmin, corpoAdmin));
    }

    await Promise.all(envios);
  } catch (e) {
    console.warn('[notif] Erro ao notificar alteração pós-recusa:', e);
  }
}

window.notificarRecusaAlterada = notificarRecusaAlterada;
