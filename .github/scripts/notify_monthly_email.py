"""
Resumo Mensal de Pontos — e-mail para fiscais e administradores.

- Cada fiscal recebe seu total de pontos na competência aberta + barra de progresso.
- Cada administrador recebe relatório consolidado dos fiscais abaixo de 1000 pts.
"""

import json, os, sys, smtplib
from datetime import datetime, timezone, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import requests
from google.oauth2 import service_account
from google.auth.transport.requests import Request as AuthRequest

SENDER_EMAIL   = "visa@anapolis.go.gov.br"
PROJECT_ID     = "visam-3a30b"
VALID_STATUSES = {"aceito", "fechado", "homologado"}
META_PONTOS    = 1000
BASE_URL       = (
    f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}"
    f"/databases/(default)/documents"
)
DASHBOARD_URL  = "https://visaanapolis.github.io/RMPF/dashboard.html"

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


def get_doc(path):
    """GET de um documento do Firestore. Retorna o JSON ou None se 404."""
    url = f"{BASE_URL}/{path}"
    r = requests.get(url, headers=_auth_headers())
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def resolver_competencia():
    """Resolve a competência aberta (mes/ano) — a MESMA base do dashboard.

    O dashboard apura a produtividade por competência aberta, não pelo mês
    anterior. Lê app_config/competencia_aberta; se ausente, usa o mês corrente
    em horário de Brasília.
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


def smtp_preflight():
    """Valida as credenciais SMTP antes de iterar pelos destinatários.

    Falha cedo e em VERMELHO (exit 1) se o secret GMAIL_APP_PASSWORD estiver
    inválido/expirado (erro 535 BadCredentials), em vez de tentar — e falhar —
    para cada destinatário e ainda assim terminar verde.
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


def card(label: str, valor: str, cor: str = "#1a237e") -> str:
    return (
        f'<div style="background:#f8f9ff;border-left:4px solid {cor};'
        f'border-radius:0 6px 6px 0;padding:12px 16px;margin:10px 0">'
        f'<div style="font-size:12px;color:#666;margin-bottom:2px">{label}</div>'
        f'<div style="font-size:18px;font-weight:700;color:{cor}">{valor}</div></div>'
    )


def barra_progresso(pontos: int, meta: int = META_PONTOS) -> str:
    pct = min(100, round(pontos / meta * 100))
    cor = "#4caf50" if pct >= 100 else "#ff9800" if pct >= 60 else "#f44336"
    return (
        f'<div style="background:#e0e0e0;border-radius:8px;height:18px;margin:8px 0">'
        f'<div style="background:{cor};width:{pct}%;height:18px;border-radius:8px;'
        f'transition:width .3s"></div></div>'
        f'<div style="font-size:12px;color:#666;text-align:right">{pct}% da meta '
        f'({meta} pts)</div>'
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


# ── Competência aberta (mesma base do dashboard) ──────────────────────────────
# Antes este resumo usava o MÊS ANTERIOR, divergindo do dashboard e do push
# mensal (que usam a competência corrente). Passa a usar a competência aberta,
# para que a pontuação enviada coincida com a exibida no sistema.
MES, ANO  = resolver_competencia()
mes_label = f"{MES:02d}/{ANO}"
print(f"Competência de referência: {mes_label}")

# ── 1. Buscar manuais da competência aberta ───────────────────────────────────
print("Consultando manuais da competência...")
try:
    results = run_query("manuais", [
        {
            "fieldFilter": {
                "field": {"fieldPath": "mes"},
                "op": "EQUAL",
                "value": {"integerValue": str(MES)},
            }
        },
        {
            "fieldFilter": {
                "field": {"fieldPath": "ano"},
                "op": "EQUAL",
                "value": {"integerValue": str(ANO)},
            }
        },
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

print(f"Fiscais com pontos em {mes_label}: {len(pontos_por_fiscal)}")

# ── 3. Buscar todos os usuários ───────────────────────────────────────────────
print("Buscando usuários...")
try:
    usuarios_raw = list_collection("usuarios")
except Exception as exc:
    print(f"::error::Falha ao buscar usuários: {exc}", file=sys.stderr)
    sys.exit(1)

fiscais = []
admins  = []
for item in usuarios_raw:
    doc = item.get("document")
    if not doc:
        continue
    email = field_value(item, "email") or doc.get("name", "").split("/")[-1]
    grupo = field_value(item, "grupo") or ""
    ativo = field_value(item, "ativo")
    nome  = field_value(item, "nome") or email
    if ativo is False:
        continue
    if not email or "@" not in email:
        continue
    if grupo == "Fiscal":
        fiscais.append({"email": email, "nome": nome})
    elif grupo == "Administrador":
        admins.append({"email": email, "nome": nome})

print(f"Fiscais ativos: {len(fiscais)} | Administradores ativos: {len(admins)}")

# ── 4. Enviar e-mail para cada Fiscal ─────────────────────────────────────────
# Valida as credenciais antes de iterar — evita run "verde" mascarando 535.
smtp_preflight()

erros = 0

for f in fiscais:
    pts = pontos_por_fiscal.get(f["email"], 0.0)
    atingiu_meta = pts >= META_PONTOS

    if atingiu_meta:
        mensagem = (
            '<p style="color:#4caf50;font-weight:700;font-size:14px;margin:16px 0 8px">'
            '🎉 Parabéns! Você atingiu a meta de 1.000 pontos neste mês!</p>'
        )
    else:
        faltam = META_PONTOS - pts
        mensagem = (
            f'<p style="color:#ff9800;font-size:14px;margin:16px 0 8px">'
            f'Faltam <strong>{faltam:.0f} pts</strong> para atingir a meta. '
            f'Continue assim! 💪</p>'
        )

    corpo = (
        card("Seus pontos em " + mes_label, f"{pts:.0f} pts", "#1a237e") +
        barra_progresso(int(pts)) +
        mensagem
    )

    subject = f"\U0001f4c5 Resumo Mensal RMPF — {mes_label}"
    html = html_email(
        titulo=f"Referência: {mes_label}",
        subtitulo=f"Olá, {f['nome']}! Veja sua pontuação do mês:",
        corpo_html=corpo,
        url_cta=DASHBOARD_URL,
        label_cta="Ver Dashboard",
    )

    try:
        send_email(f["email"], subject, html)
        print(f"  ✅ [fiscal] E-mail enviado para {f['email']}")
    except Exception as exc:
        print(f"  ❌ [fiscal] Falha para {f['email']}: {exc}", file=sys.stderr)
        erros += 1

# ── 5. Enviar relatório consolidado para cada Administrador ───────────────────
# Constrói lista completa de fiscais com pontos do mês (incluindo zeros)
todos_fiscais_pts = {f["email"]: {"nome": f["nome"], "pts": pontos_por_fiscal.get(f["email"], 0.0)}
                     for f in fiscais}
abaixo_da_meta = sorted(
    [(d["nome"], d["pts"]) for d in todos_fiscais_pts.values() if d["pts"] < META_PONTOS],
    key=lambda x: x[1],
)

if admins:
    # Gera tabela HTML
    linhas_tabela = ""
    for nome_f, pts_f in abaixo_da_meta:
        cor_pts = "#f44336" if pts_f < 600 else "#ff9800"
        linhas_tabela += (
            f'<tr>'
            f'<td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;'
            f'font-size:14px;color:#333">{nome_f}</td>'
            f'<td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;'
            f'font-size:14px;font-weight:700;color:{cor_pts};text-align:right">'
            f'{pts_f:.0f} pts</td>'
            f'</tr>'
        )

    if linhas_tabela:
        tabela = (
            f'<p style="font-size:13px;color:#666;margin:0 0 12px">'
            f'{len(abaixo_da_meta)} fiscal(is) abaixo de {META_PONTOS} pts em {mes_label}:</p>'
            f'<table width="100%" cellpadding="0" cellspacing="0" '
            f'style="border-collapse:collapse;border:1px solid #e0e0e0;border-radius:8px;'
            f'overflow:hidden">'
            f'<thead><tr>'
            f'<th style="background:#1a237e;color:#fff;padding:10px 12px;'
            f'font-size:13px;text-align:left">Fiscal</th>'
            f'<th style="background:#1a237e;color:#fff;padding:10px 12px;'
            f'font-size:13px;text-align:right">Pontuação</th>'
            f'</tr></thead>'
            f'<tbody>{linhas_tabela}</tbody>'
            f'</table>'
        )
    else:
        tabela = (
            '<p style="color:#4caf50;font-weight:700;font-size:14px;margin:16px 0">'
            '🎉 Todos os fiscais atingiram a meta de 1.000 pontos neste mês!</p>'
        )

    corpo_admin = tabela

    subject_admin = f"\U0001f4cb Relatório Mensal RMPF — Fiscais abaixo da meta — {mes_label}"
    html_admin = html_email(
        titulo=f"Relatório Mensal — {mes_label}",
        subtitulo="Fiscais abaixo da meta de 1.000 pontos:",
        corpo_html=corpo_admin,
        url_cta=DASHBOARD_URL,
        label_cta="Ver Dashboard",
    )

    for a in admins:
        try:
            send_email(a["email"], subject_admin, html_admin)
            print(f"  ✅ [admin] E-mail enviado para {a['email']}")
        except Exception as exc:
            print(f"  ❌ [admin] Falha para {a['email']}: {exc}", file=sys.stderr)
            erros += 1

total_destinatarios = len(fiscais) + len(admins)
if total_destinatarios and erros == total_destinatarios:
    print(f"::error::Nenhum e-mail entregue ({erros}/{total_destinatarios}). "
          f"Verifique o secret GMAIL_APP_PASSWORD e a conta remetente "
          f"{SENDER_EMAIL}.", file=sys.stderr)
    sys.exit(1)
elif erros:
    print(f"::warning::{erros} e-mail(s) não entregue(s).")
else:
    print(f"✅ Resumo mensal: {len(fiscais)} fiscal(is), {len(admins)} administrador(es).")
