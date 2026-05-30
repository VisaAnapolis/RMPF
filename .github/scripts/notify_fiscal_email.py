"""
Notificação por e-mail a um fiscal específico.

Acionado via repository_dispatch (event_type: notify-fiscal-email).
Lê as variáveis de ambiente FISCAL_EMAIL, FISCAL_NOME, TITULO e CORPO
e envia um e-mail HTML formatado.
"""

import os, sys, smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

SENDER_EMAIL = "visa@anapolis.go.gov.br"

# ── Variáveis do payload ───────────────────────────────────────────────────────
fiscal_email = os.environ.get("FISCAL_EMAIL", "").strip()
fiscal_nome  = os.environ.get("FISCAL_NOME",  "").strip()
titulo       = os.environ.get("TITULO",       "Notificação RMPF").strip()
corpo        = os.environ.get("CORPO",        "").strip()

if not fiscal_email:
    print("::error::FISCAL_EMAIL está vazio — e-mail não enviado.", file=sys.stderr)
    sys.exit(1)

# ── Helpers de e-mail ─────────────────────────────────────────────────────────
def html_email(titulo_h: str, subtitulo: str, corpo_html: str) -> str:
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
    <div style="font-size:13px;color:rgba(255,255,255,.75)">{titulo_h}</div>
  </td></tr>
  <tr><td style="background:#fff;padding:28px 32px">
    <p style="margin:0 0 16px;font-size:15px;color:#1a237e;font-weight:700">{subtitulo}</p>
    <div style="background:#f8f9ff;border-left:4px solid #1a237e;border-radius:0 6px 6px 0;
      padding:14px 16px;margin:10px 0;font-size:14px;color:#333;line-height:1.6">
      {corpo_html}
    </div>
    <div style="text-align:center;margin:28px 0">
      <a href="https://visaanapolis.github.io/RMPF/dashboard.html"
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


# ── Envio ─────────────────────────────────────────────────────────────────────
saudacao = f"Olá, {fiscal_nome}!" if fiscal_nome else "Olá!"
subject  = f"\U0001f514 {titulo} — RMPF"
html     = html_email(
    titulo_h=titulo,
    subtitulo=saudacao,
    corpo_html=corpo,
)

try:
    send_email(fiscal_email, subject, html)
    print(f"✅ E-mail enviado para {fiscal_email}")
except Exception as exc:
    print(f"::error::Falha ao enviar e-mail para {fiscal_email}: {exc}", file=sys.stderr)
    sys.exit(1)
