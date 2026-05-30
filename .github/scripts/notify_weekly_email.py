"""
Resumo Semanal de Pontos — e-mail para cada fiscal ativo.

Busca os manuais com criadoEm >= segunda-feira desta semana (00:00 BRT),
filtra pelos status válidos, agrupa pontos por fiscal e envia um e-mail
com cards de desempenho individual e total da equipe.
"""

import json, os, sys, smtplib
from datetime import datetime, timezone, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import requests
from google.oauth2 import service_account
from google.auth.transport.requests import Request as AuthRequest

SENDER_EMAIL    = "visa@anapolis.go.gov.br"
PROJECT_ID      = "visam-3a30b"
VALID_STATUSES  = {"aceito", "fechado", "homologado"}
BASE_URL        = (
    f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}"
    f"/databases/(default)/documents"
)
DASHBOARD_URL   = "https://visaanapolis.github.io/RMPF/dashboard.html"

# ── Autenticação ──────────────────────────────────────────────────────────────
sa_info = json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT_JSON"])

fs_creds = service_account.Credentials.from_service_account_info(
    sa_info,
    scopes=["https://www.googleapis.com/auth/datastore"],
)


# ── Helpers Firestore ─────────────────────────────────────────────────────────
def _auth_headers():
    fs_creds.refresh(AuthRequest())
    return {"Authorization": "Bearer " + fs_creds.token, "Content-Type": "application/json"}


def run_query(collection, filters):
    url = f"{BASE_URL}:runQuery"
    body = {
        "structuredQuery": {
            "from": [{"collectionId": collection}],
            "where": {
                "compositeFilter": {
                    "op": "AND",
                    "filters": filters,
                }
            },
        }
    }
    r = requests.post(url, json=body, headers=_auth_headers())
    r.raise_for_status()
    return r.json()


def list_collection(collection):
    url = f"{BASE_URL}:runQuery"
    body = {"structuredQuery": {"from": [{"collectionId": collection}]}}
    r = requests.post(url, json=body, headers=_auth_headers())
    r.raise_for_status()
    return r.json()


def field_value(item, field):
    fields = item.get("document", {}).get("fields", {})
    fv = fields.get(field, {})
    if "integerValue"   in fv: return int(fv["integerValue"])
    if "doubleValue"    in fv: return float(fv["doubleValue"])
    if "stringValue"    in fv: return fv["stringValue"]
    if "booleanValue"   in fv: return bool(fv["booleanValue"])
    if "timestampValue" in fv: return fv["timestampValue"]
    return None


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


def card(label: str, valor: str, cor: str = "#1a237e") -> str:
    return (
        f'<div style="background:#f8f9ff;border-left:4px solid {cor};'
        f'border-radius:0 6px 6px 0;padding:12px 16px;margin:10px 0">'
        f'<div style="font-size:12px;color:#666;margin-bottom:2px">{label}</div>'
        f'<div style="font-size:18px;font-weight:700;color:{cor}">{valor}</div></div>'
    )


def html_email(titulo: str, subtitulo: str, corpo_html: str,
               url_cta: str = "", label_cta: str = "") -> str:
    cta = ""
    if url_cta:
        cta = (
            f'<div style="text-align:center;margin:28px 0">'
            f'<a href="{url_cta}" style="display:inline-block;background:#1a237e;'
            f'color:#fff;text-decoration:none;padding:13px 32px;border-radius:8px;'
            f'font-size:15px;font-weight:700">{label_cta}</a></div>'
        )
    return f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:30px 10px">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%">
  <tr><td style="background:#1a237e;padding:26px 32px;border-radius:12px 12px 0 0">
    <div style="font-size:21px;font-weight:700;color:#fff;margin-bottom:4px">
      \U0001f3db\ufe0f VISA Anápolis — RMPF</div>
    <div style="font-size:13px;color:rgba(255,255,255,.75)">{titulo}</div>
  </td></tr>
  <tr><td style="background:#fff;padding:28px 32px">
    <p style="margin:0 0 16px;font-size:15px;color:#1a237e;font-weight:700">{subtitulo}</p>
    {corpo_html}
    {cta}
  </td></tr>
  <tr><td style="background:#546e7a;padding:16px 32px;border-radius:0 0 12px 12px;text-align:center">
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,.7)">
      Mensagem automática — RMPF · VISA Anápolis · Não responda este e-mail</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>"""


# ── Cálculo da semana atual ───────────────────────────────────────────────────
tz_brasilia     = timezone(timedelta(hours=-3))
hoje            = datetime.now(tz_brasilia)
monday_brt      = (hoje - timedelta(days=hoje.weekday())).replace(
                      hour=0, minute=0, second=0, microsecond=0)
monday_utc      = monday_brt.astimezone(timezone.utc)
monday_iso      = monday_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
semana_label    = monday_brt.strftime("%d/%m")

print(f"Semana de referência: {semana_label} (monday UTC={monday_iso})")

# ── 1. Buscar manuais criados a partir desta segunda-feira ────────────────────
print("Consultando manuais da semana...")
try:
    results = run_query("manuais", [
        {
            "fieldFilter": {
                "field": {"fieldPath": "criadoEm"},
                "op": "GREATER_THAN_OR_EQUAL",
                "value": {"timestampValue": monday_iso},
            }
        }
    ])
except Exception as exc:
    print(f"::error::Falha ao consultar manuais: {exc}", file=sys.stderr)
    sys.exit(1)

# ── 2. Agrupar pontos por fiscal ──────────────────────────────────────────────
pontos_por_fiscal: dict[str, float] = {}
for item in results:
    if not item.get("document"):
        continue
    status = field_value(item, "status") or ""
    if status not in VALID_STATUSES:
        continue
    email = field_value(item, "fiscal_email")
    if not email:
        continue
    pts_hom = field_value(item, "pontos_homologado")
    pts_raw = field_value(item, "pontos")
    pts = pts_hom if pts_hom is not None else pts_raw
    try:
        pts = float(pts or 0)
    except (TypeError, ValueError):
        pts = 0.0
    pontos_por_fiscal[email] = pontos_por_fiscal.get(email, 0.0) + pts

total_equipe = sum(pontos_por_fiscal.values())
print(f"Total da equipe na semana: {total_equipe:.0f} pts | "
      f"Fiscais com pontos: {len(pontos_por_fiscal)}")

# ── 3. Buscar usuários fiscais ativos ─────────────────────────────────────────
print("Buscando usuários fiscais...")
try:
    usuarios_raw = list_collection("usuarios")
except Exception as exc:
    print(f"::error::Falha ao buscar usuários: {exc}", file=sys.stderr)
    sys.exit(1)

fiscais = []
for item in usuarios_raw:
    doc = item.get("document")
    if not doc:
        continue
    email = field_value(item, "email") or doc.get("name", "").split("/")[-1]
    grupo = field_value(item, "grupo") or ""
    ativo = field_value(item, "ativo")
    nome  = field_value(item, "nome") or email
    if grupo != "Fiscal":
        continue
    if ativo is False:
        continue
    if not email or "@" not in email:
        print(f"  ⚠️  Fiscal '{nome}' sem e-mail cadastrado.")
        continue
    fiscais.append({"email": email, "nome": nome})

print(f"Fiscais ativos encontrados: {len(fiscais)}")

# ── 4. Enviar e-mail a cada fiscal ────────────────────────────────────────────
erros = 0
for f in fiscais:
    pts_fiscal = pontos_por_fiscal.get(f["email"], 0.0)
    pct = round(pts_fiscal / total_equipe * 100, 1) if total_equipe > 0 else 0.0

    corpo = (
        card("Seus pontos esta semana", f"{pts_fiscal:.0f} pts", "#1a237e") +
        card("Total da equipe",         f"{total_equipe:.0f} pts", "#546e7a") +
        card("Sua participação",         f"{pct:.1f}%", "#00897b")
    )

    subject = f"\U0001f4ca Resumo Semanal RMPF — semana de {semana_label}"
    html = html_email(
        titulo=f"Semana de {semana_label}",
        subtitulo=f"Olá, {f['nome']}! Veja seu desempenho desta semana:",
        corpo_html=corpo,
        url_cta=DASHBOARD_URL,
        label_cta="Ver Dashboard",
    )

    try:
        send_email(f["email"], subject, html)
        print(f"  ✅ E-mail enviado para {f['email']}")
    except Exception as exc:
        print(f"  ❌ Falha ao enviar para {f['email']}: {exc}", file=sys.stderr)
        erros += 1

if erros:
    print(f"::warning::{erros} e-mail(s) não entregue(s).")
else:
    print(f"✅ Resumo semanal enviado para {len(fiscais)} fiscal(is).")
