"""
Backfill dos campos motivo_os, os_numero e documento nos registros VISA
da coleção manuais do Firestore.

Variáveis de ambiente:
  FIREBASE_SA_JSON  — conteúdo JSON da service account (obrigatório)
  MES               — mês de referência (default: 6)
  ANO               — ano de referência (default: 2026)
  DRY_RUN           — "true" para simular sem gravar (default: "true")
"""

import csv, io, json, os, sys, urllib.request, urllib.error

import google.oauth2.service_account
import google.auth.transport.requests

PROJECT_ID    = 'visam-3a30b'
FIRESTORE_URL = f'https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents'

MES     = int(os.environ.get('MES', '6'))
ANO     = int(os.environ.get('ANO', '2026'))
DRY_RUN = os.environ.get('DRY_RUN', 'true').strip().lower() != 'false'

# ── Autenticação ──────────────────────────────────────────
sa_info = json.loads(os.environ['FIREBASE_SA_JSON'])
creds = google.oauth2.service_account.Credentials.from_service_account_info(
    sa_info,
    scopes=['https://www.googleapis.com/auth/datastore'],
)
creds.refresh(google.auth.transport.requests.Request())

def _headers():
    if not creds.valid:
        creds.refresh(google.auth.transport.requests.Request())
    return {
        'Authorization': 'Bearer ' + creds.token,
        'Content-Type': 'application/json',
    }

# ── Helpers Firestore ─────────────────────────────────────

def fs_get(path):
    req = urllib.request.Request(f'{FIRESTORE_URL}/{path}', headers=_headers())
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def fs_query(filters):
    body = json.dumps({
        'structuredQuery': {
            'from': [{'collectionId': 'manuais'}],
            'where': {'compositeFilter': {'op': 'AND', 'filters': filters}},
        }
    }).encode()
    req = urllib.request.Request(
        f'{FIRESTORE_URL}:runQuery', data=body, method='POST', headers=_headers()
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def fs_patch(doc_id, fields_dict):
    """Atualiza apenas os campos indicados em fields_dict (todos string)."""
    mask = '&'.join(f'updateMask.fieldPaths={k}' for k in fields_dict)
    body = json.dumps({
        'fields': {k: {'stringValue': v} for k, v in fields_dict.items()}
    }).encode()
    req = urllib.request.Request(
        f'{FIRESTORE_URL}/manuais/{doc_id}?{mask}',
        data=body, method='PATCH', headers=_headers(),
    )
    with urllib.request.urlopen(req) as r:
        r.read()

def fstr(doc, field):
    """Extrai stringValue de um campo do documento Firestore REST."""
    fv = doc.get('fields', {}).get(field, {})
    return fv.get('stringValue') or ''

# ── Ler token do GitHub do Firestore ─────────────────────
print(f'Backfill VISA — mes={MES}, ano={ANO}, dry_run={DRY_RUN}')
print('Lendo token do GitHub em app_config/github_token...')
token_doc = fs_get('app_config/github_token')
github_token = fstr(token_doc, 'token')
if not github_token:
    print('❌ Token do GitHub não encontrado em app_config/github_token.', file=sys.stderr)
    sys.exit(1)
print('✅ Token obtido.')

# ── Buscar inspecoes.csv ──────────────────────────────────
print('Buscando data/inspecoes.csv do repositório garrado/VISA...')
csv_req = urllib.request.Request(
    'https://api.github.com/repos/garrado/VISA/contents/data/inspecoes.csv',
    headers={
        'Authorization': 'Bearer ' + github_token,
        'Accept': 'application/vnd.github.v3.raw',
    },
)
try:
    with urllib.request.urlopen(csv_req) as r:
        csv_raw = r.read().decode('utf-8-sig')  # utf-8-sig remove BOM automaticamente
except urllib.error.HTTPError as e:
    print(f'❌ Falha ao buscar CSV: HTTP {e.code} — {e.read().decode()}', file=sys.stderr)
    sys.exit(1)

# ── Parsear CSV ───────────────────────────────────────────
reader = csv.DictReader(io.StringIO(csv_raw), delimiter=';')
# Limpar BOM residual e aspas dos cabeçalhos (mesma lógica do visa-import.js)
reader.fieldnames = [
    h.replace('﻿', '').strip('"').strip()
    for h in (reader.fieldnames or [])
]

def _clean(v):
    return str(v or '').strip().strip('"').strip()

csv_por_controle = {}
for row in reader:
    controle = _clean(row.get('CONTROLE', ''))
    if controle:
        csv_por_controle[controle] = row

print(f'✅ {len(csv_por_controle)} linha(s) no CSV.')

# ── Consultar manuais no Firestore ────────────────────────
print(f'Consultando manuais mes={MES}, ano={ANO}...')
results = fs_query([
    {'fieldFilter': {
        'field': {'fieldPath': 'mes'},
        'op': 'EQUAL',
        'value': {'integerValue': str(MES)},
    }},
    {'fieldFilter': {
        'field': {'fieldPath': 'ano'},
        'op': 'EQUAL',
        'value': {'integerValue': str(ANO)},
    }},
])

visa_docs = [
    item['document']
    for item in results
    if item.get('document') and fstr(item['document'], 'origem') == 'visa_csv'
]
print(f'✅ {len(visa_docs)} documento(s) VISA encontrado(s).')

# ── Backfill ──────────────────────────────────────────────
if DRY_RUN:
    print('\n⚠️  MODO SIMULAÇÃO (DRY_RUN=true) — nenhum dado será gravado.\n')

atualizados = 0
ja_preenchidos = 0
sem_linha_csv = 0
erros = 0

for doc in visa_docs:
    doc_name = doc.get('name', '')
    doc_id   = doc_name.split('/')[-1]
    controle = fstr(doc, 'visa_controle')

    row = csv_por_controle.get(controle)
    if not row:
        print(f'  ⚠️  {doc_id}: controle "{controle}" não encontrado no CSV.', file=sys.stderr)
        sem_linha_csv += 1
        continue

    # Extrair valores do CSV (mesma lógica do visa-import.js)
    motivo_os = _clean(
        row.get('Modalidade') or row.get('modalidade') or row.get('MODALIDADE') or ''
    )
    os_numero = next(
        (_clean(row.get(k, '')) for k in ('OS', 'NUMERO', 'Oficio', 'OFICIO', 'Protocolo', 'PROTOCOLO', 'Denuncia', 'DENUNCIA')
         if _clean(row.get(k, ''))),
        ''
    )
    documento = _clean(
        row.get('tipo') or row.get('Tipo') or row.get('TIPO') or ''
    )

    # Apenas preenche campos que estão vazios no Firestore
    candidatos = {
        'motivo_os': motivo_os,
        'os_numero': os_numero,
        'documento': documento,
    }
    campos_faltando = {k: v for k, v in candidatos.items() if not fstr(doc, k)}

    if not campos_faltando:
        ja_preenchidos += 1
        continue

    if DRY_RUN:
        print(f'  [DRY] {doc_id} (controle={controle}): preencheria {campos_faltando}')
        atualizados += 1
        continue

    try:
        fs_patch(doc_id, campos_faltando)
        print(f'  ✅ {doc_id}: {list(campos_faltando.keys())} preenchido(s).')
        atualizados += 1
    except urllib.error.HTTPError as e:
        print(f'  ❌ {doc_id}: erro ao atualizar — {e.read().decode()}', file=sys.stderr)
        erros += 1

# ── Resumo ────────────────────────────────────────────────
prefixo = '[DRY] ' if DRY_RUN else ''
print(f'\n{prefixo}Resumo:')
print(f'  Atualizados:       {atualizados}')
print(f'  Já preenchidos:    {ja_preenchidos}')
print(f'  Sem linha no CSV:  {sem_linha_csv}')
print(f'  Erros:             {erros}')
if DRY_RUN:
    print('\nPara aplicar, re-execute com DRY_RUN=false.')
if erros:
    sys.exit(1)
