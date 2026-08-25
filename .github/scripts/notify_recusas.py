"""
Notificação de lançamentos recusados — push (FCM) + e-mail, server-side.

Rede de segurança do aviso que o navegador do gestor dispara na hora da recusa
(conferencia.html -> js/notifications.js). Aquele caminho depende do PAT em
app_config/github_token, da aba aberta e da rede; quando ele falha, a recusa
fica sem aviso e ninguém fica sabendo. Este job varre o Firestore e avisa o que
escapou.

Para não repetir o que o navegador já entregou, cada lançamento notificado
recebe a marca `recusa_notificada_em`. O app grava a mesma marca quando o
disparo dele confirma; aqui só entram os que estão sem marca.

Escopo: apenas a COMPETÊNCIA ABERTA (app_config/competencia_aberta), igual à
conferência e ao exportador de recusas do WCVS.

Disparo manual apenas (workflows/notify-recusas.yml). Variáveis de ambiente:
  DRY_RUN        '1'/'true' — lista o que faria, sem enviar e sem marcar
  CANAL          'push' | 'email' | 'ambos' (padrão)
  FISCAL_EMAIL   restringe a um fiscal (teste dirigido)
  IGNORAR_MARCA  '1'/'true' — reenvia mesmo já marcado (repetir teste)
"""

import json, os, sys, smtplib
from datetime import datetime, timezone, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import requests
from google.oauth2 import service_account
from google.auth.transport.requests import Request as AuthRequest

SENDER_EMAIL  = "visa@anapolis.go.gov.br"
PROJECT_ID    = "visam-3a30b"
BASE_URL      = (
    f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}"
    f"/databases/(default)/documents"
)
FCM_URL       = f"https://fcm.googleapis.com/v1/projects/{PROJECT_ID}/messages:send"
DASHBOARD_URL = "https://visaanapolis.github.io/RMPF/dashboard.html"


def _flag(nome: str) -> bool:
    return os.environ.get(nome, "").strip().lower() in ("1", "true", "yes", "sim")


DRY_RUN       = _flag("DRY_RUN")
IGNORAR_MARCA = _flag("IGNORAR_MARCA")
CANAL         = (os.environ.get("CANAL") or "ambos").strip().lower()
FISCAL_FILTRO = (os.environ.get("FISCAL_EMAIL") or "").strip().lower()

if CANAL not in ("push", "email", "ambos"):
    print(f"::error::CANAL inválido: {CANAL!r} (use push, email ou ambos)", file=sys.stderr)
    sys.exit(1)

ENVIA_PUSH  = CANAL in ("push", "ambos")
ENVIA_EMAIL = CANAL in ("email", "ambos")

# ── Autenticação (Firestore + FCM no mesmo token) ─────────────────────────────
sa_info = json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT_JSON"])

creds = service_account.Credentials.from_service_account_info(
    sa_info,
    scopes=[
        "https://www.googleapis.com/auth/datastore",
        "https://www.googleapis.com/auth/firebase.messaging",
    ],
)


# ── Helpers Firestore ─────────────────────────────────────────────────────────
def _auth_headers():
    creds.refresh(AuthRequest())
    return {"Authorization": "Bearer " + creds.token, "Content-Type": "application/json"}


def run_query(collection, filters):
    url = f"{BASE_URL}:runQuery"
    body = {
        "structuredQuery": {
            "from": [{"collectionId": collection}],
            "where": {"compositeFilter": {"op": "AND", "filters": filters}},
        }
    }
    r = requests.post(url, json=body, headers=_auth_headers())
    r.raise_for_status()
    return r.json()


def get_doc(path):
    """GET de um documento do Firestore. Retorna o JSON ou None se 404."""
    url = f"{BASE_URL}/{path}"
    r = requests.get(url, headers=_auth_headers())
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def _valor(fv):
    if "integerValue"   in fv: return int(fv["integerValue"])
    if "doubleValue"    in fv: return float(fv["doubleValue"])
    if "stringValue"    in fv: return fv["stringValue"]
    if "booleanValue"   in fv: return bool(fv["booleanValue"])
    if "timestampValue" in fv: return fv["timestampValue"]
    if "nullValue"      in fv: return None
    return None


def field_value(item, field):
    fields = item.get("document", {}).get("fields", {})
    return _valor(fields.get(field, {}))


def doc_id(item):
    """Último segmento do `name` — o ID do documento."""
    return item.get("document", {}).get("name", "").rsplit("/", 1)[-1]


def marcar_notificado(manual_id, quando):
    """Grava `recusa_notificada_em` sem tocar em mais nada do documento.

    O updateMask é o que garante isso: um PATCH sem ele substituiria o
    documento inteiro pelos campos enviados, zerando o lançamento.
    """
    url = f"{BASE_URL}/manuais/{manual_id}?updateMask.fieldPaths=recusa_notificada_em"
    body = {"fields": {"recusa_notificada_em": {"stringValue": quando}}}
    r = requests.patch(url, json=body, headers=_auth_headers())
    r.raise_for_status()


def resolver_competencia():
    """Competência aberta (mes/ano) — a MESMA base da conferência.

    Lê app_config/competencia_aberta; se ausente, usa o mês corrente em
    horário de Brasília.
    """
    tz = timezone(timedelta(hours=-3))
    hoje = datetime.now(tz)
    mes, ano = hoje.month, hoje.year
    try:
        doc = get_doc("app_config/competencia_aberta")
        if doc and "fields" in doc:
            f = doc["fields"]
            if "mes" in f and "integerValue" in f["mes"]:
                mes = int(f["mes"]["integerValue"])
            if "ano" in f and "integerValue" in f["ano"]:
                ano = int(f["ano"]["integerValue"])
    except Exception as exc:
        print(f"  ⚠️  Falha ao ler competência aberta, usando mês corrente: {exc}")
    return mes, ano


def tokens_fcm(fiscal_email):
    """rmpf_fcmTokens de usuarios/{email}.

    Só o array do RMPF: fcmTokens e fcm_token são legados presos ao service
    worker do VISA e abririam o app errado.
    """
    doc = get_doc(f"usuarios/{fiscal_email}")
    if not doc:
        return []
    fv = doc.get("fields", {}).get("rmpf_fcmTokens", {})
    arr = fv.get("arrayValue", {}).get("values", [])
    vistos, out = set(), []
    for v in arr:
        t = (v.get("stringValue") or "").strip()
        if t and t not in vistos:
            vistos.add(t)
            out.append(t)
    return out


def send_fcm(token, titulo, corpo):
    """Push data-only — a notificação visível é montada pelo service worker
    do RMPF; um bloco `notification` aqui geraria aviso duplicado."""
    payload = {
        "message": {
            "token": token,
            "data": {"title": titulo, "body": corpo, "link": DASHBOARD_URL},
        }
    }
    r = requests.post(FCM_URL, json=payload, headers=_auth_headers())
    r.raise_for_status()


# ── Helpers de e-mail ─────────────────────────────────────────────────────────
def send_email(to: str, subject: str, html_body: str):
    msg = MIMEMultipart("alternative")
    msg["From"]    = f"VISA Anápolis - RMPF <{SENDER_EMAIL}>"
    msg["To"]      = to
    msg["Subject"] = subject
    msg.attach(MIMEText(html_body, "html", "utf-8"))
    with smtplib.SMTP("smtp.gmail.com", 587) as smtp:
        smtp.starttls()
        smtp.login(SENDER_EMAIL, os.environ["GMAIL_APP_PASSWORD"])
        smtp.sendmail(SENDER_EMAIL, to, msg.as_string())


def smtp_preflight():
    """Valida as credenciais SMTP antes de iterar pelos destinatários.

    Falha cedo e em VERMELHO se o secret GMAIL_APP_PASSWORD estiver
    inválido/expirado, em vez de falhar para cada fiscal e terminar verde.
    """
    try:
        with smtplib.SMTP("smtp.gmail.com", 587) as smtp:
            smtp.starttls()
            smtp.login(SENDER_EMAIL, os.environ["GMAIL_APP_PASSWORD"])
    except smtplib.SMTPAuthenticationError as exc:
        print(f"::error::Credenciais SMTP rejeitadas pelo Gmail ({exc.smtp_code}). "
              f"Atualize o secret GMAIL_APP_PASSWORD com uma App Password válida "
              f"da conta {SENDER_EMAIL}.", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"::error::Falha ao conectar/autenticar no SMTP: {exc}", file=sys.stderr)
        sys.exit(1)


def html_email(titulo: str, subtitulo: str, corpo_html: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:30px 10px">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%">
  <tr><td style="background:#1a237e;padding:26px 32px;border-radius:12px 12px 0 0">
    <div style="font-size:21px;font-weight:700;color:#fff;margin-bottom:4px">
      \U0001f3db️ VISA Anápolis — RMPF</div>
    <div style="font-size:13px;color:rgba(255,255,255,.75)">{titulo}</div>
  </td></tr>
  <tr><td style="background:#fff;padding:28px 32px">
    <p style="margin:0 0 16px;font-size:15px;color:#1a237e;font-weight:700">{subtitulo}</p>
    {corpo_html}
    <div style="text-align:center;margin:28px 0">
      <a href="{DASHBOARD_URL}"
         style="display:inline-block;background:#1a237e;color:#fff;text-decoration:none;
         padding:13px 32px;border-radius:8px;font-size:15px;font-weight:700">
        Ver Dashboard</a>
    </div>
  </td></tr>
  <tr><td style="background:#546e7a;padding:16px 32px;border-radius:0 0 12px 12px;text-align:center">
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,.7)">
      Mensagem automática — RMPF · VISA Anápolis · Não responda este e-mail</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>"""


def esc(s) -> str:
    return (str(s if s is not None else "")
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


# ── Execução ──────────────────────────────────────────────────────────────────
MES, ANO = resolver_competencia()
print(f"Competência de referência: {MES:02d}/{ANO}")
print(f"Modo: {'DRY-RUN (nada é enviado nem marcado)' if DRY_RUN else 'ENVIO REAL'} | "
      f"canal={CANAL} | fiscal={FISCAL_FILTRO or 'todos'} | ignorar_marca={IGNORAR_MARCA}")

if ENVIA_EMAIL and not DRY_RUN:
    smtp_preflight()

resp = run_query("manuais", [
    {"fieldFilter": {"field": {"fieldPath": "status"},
                     "op": "EQUAL", "value": {"stringValue": "recusado"}}},
    {"fieldFilter": {"field": {"fieldPath": "mes"},
                     "op": "EQUAL", "value": {"integerValue": MES}}},
    {"fieldFilter": {"field": {"fieldPath": "ano"},
                     "op": "EQUAL", "value": {"integerValue": ANO}}},
])

recusados = [it for it in resp if it.get("document")]
print(f"Lançamentos recusados na competência: {len(recusados)}")

pendentes = []
for item in recusados:
    fiscal_email = (field_value(item, "fiscal_email") or "").strip()
    if not fiscal_email:
        print(f"::warning::Lançamento {doc_id(item)} sem fiscal_email — ignorado.")
        continue
    if FISCAL_FILTRO and fiscal_email.lower() != FISCAL_FILTRO:
        continue
    if not IGNORAR_MARCA and field_value(item, "recusa_notificada_em"):
        continue
    pendentes.append(item)

print(f"A notificar: {len(pendentes)}")
if not pendentes:
    print("Nada a fazer — todas as recusas da competência já foram avisadas.")
    sys.exit(0)

agora = datetime.now(timezone.utc).isoformat()
enviados = falhas = 0

for item in pendentes:
    manual_id    = doc_id(item)
    fiscal_email = (field_value(item, "fiscal_email") or "").strip()
    fiscal_nome  = field_value(item, "fiscal_nome") or fiscal_email
    controle     = field_value(item, "controle") or manual_id
    motivo       = field_value(item, "motivo_recusa") or "(motivo não informado)"

    titulo = "⚠️ Lançamento Recusado"
    corpo  = (f"O lançamento {controle} foi recusado. Motivo: {motivo}. "
              f"Corrigir a inspeção no WCVS não reabre automaticamente — "
              f"para reavaliação, procure o gestor.")

    if DRY_RUN:
        n_tokens = len(tokens_fcm(fiscal_email)) if ENVIA_PUSH else 0
        print(f"  [dry-run] {controle} -> {fiscal_email} "
              f"(push: {n_tokens} token(s), e-mail: {'sim' if ENVIA_EMAIL else 'não'}) | {motivo}")
        continue

    # A marca só é gravada se ALGUM canal saiu: sem isso, uma falha total
    # marcaria o lançamento como avisado e a próxima execução o puliria.
    ok = False

    if ENVIA_PUSH:
        for token in tokens_fcm(fiscal_email):
            try:
                send_fcm(token, titulo, corpo)
                ok = True
            except Exception as exc:
                print(f"::warning::Push falhou para {fiscal_email} ({controle}): {exc}")

    if ENVIA_EMAIL:
        try:
            send_email(
                fiscal_email,
                f"\U0001f514 {titulo} — RMPF",
                html_email(
                    titulo,
                    f"Olá, {esc(fiscal_nome)}!",
                    f'<div style="background:#fff5f5;border-left:4px solid #c62828;'
                    f'border-radius:0 6px 6px 0;padding:14px 16px;margin:10px 0;'
                    f'font-size:14px;color:#333;line-height:1.6">{esc(corpo)}</div>',
                ),
            )
            ok = True
        except Exception as exc:
            print(f"::warning::E-mail falhou para {fiscal_email} ({controle}): {exc}")

    if ok:
        enviados += 1
        try:
            marcar_notificado(manual_id, agora)
            print(f"  ✅ {controle} -> {fiscal_email}")
        except Exception as exc:
            # Enviado mas não marcado: a próxima execução reenvia. Melhor um
            # aviso repetido do que uma recusa que nunca chega.
            print(f"::warning::Enviado, mas falhou ao marcar {controle}: {exc}")
    else:
        falhas += 1
        print(f"::warning::Nenhum canal entregou para {fiscal_email} ({controle}) — sem marca.")

if DRY_RUN:
    print(f"\nDry-run concluído: {len(pendentes)} lançamento(s) seriam notificados.")
else:
    print(f"\nConcluído: {enviados} notificado(s), {falhas} sem entrega.")
