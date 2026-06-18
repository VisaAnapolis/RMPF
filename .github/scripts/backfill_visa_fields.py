"""
Backfill/correção dos campos motivo_os, os_numero, documento e descricao
em TODOS os registros visa_csv da coleção manuais.

Processa todos os registros com origem=visa_csv (desde abril/2026 em diante).

Variáveis de ambiente:
  FIREBASE_SA_JSON  — conteúdo JSON da service account (obrigatório)
  DRY_RUN           — "true" para simular sem gravar (default: "true")
"""

import csv, io, json, os, sys, unicodedata, urllib.request, urllib.error

import google.oauth2.service_account
import google.auth.transport.requests

PROJECT_ID    = 'visam-3a30b'
FIRESTORE_URL = f'https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents'

DRY_RUN = os.environ.get('DRY_RUN', 'true').strip().lower() not in ('false', '0', 'no')

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
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def fs_query_all_visa():
    """Busca todos os documentos manuais com origem=visa_csv."""
    body = json.dumps({
        'structuredQuery': {
            'from': [{'collectionId': 'manuais'}],
            'where': {
                'fieldFilter': {
                    'field': {'fieldPath': 'origem'},
                    'op': 'EQUAL',
                    'value': {'stringValue': 'visa_csv'},
                }
            },
        }
    }).encode()
    req = urllib.request.Request(
        f'{FIRESTORE_URL}:runQuery', data=body, method='POST', headers=_headers()
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def fs_patch(doc_id, fields_dict):
    """Atualiza apenas os campos indicados (todos string)."""
    mask = '&'.join(f'updateMask.fieldPaths={k}' for k in fields_dict)
    body = json.dumps({
        'fields': {k: {'stringValue': v} for k, v in fields_dict.items()}
    }).encode()
    req = urllib.request.Request(
        f'{FIRESTORE_URL}/manuais/{doc_id}?{mask}',
        data=body, method='PATCH', headers=_headers(),
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        r.read()

def fstr(doc, field):
    """Extrai stringValue de um campo do documento Firestore REST."""
    fv = doc.get('fields', {}).get(field, {})
    return fv.get('stringValue') or ''

# ── Normalização (mesma lógica do normNomeVisa do JS) ─────
def norm_visa(v):
    s = str(v or '')
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return s.upper().replace('  ', ' ').strip()

# ── Ler token do GitHub do Firestore ─────────────────────
print(f'Backfill VISA campos — dry_run={DRY_RUN}')
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
    with urllib.request.urlopen(csv_req, timeout=60) as r:
        csv_raw = r.read().decode('utf-8-sig')
except urllib.error.HTTPError as e:
    print(f'❌ Falha ao buscar CSV: HTTP {e.code} — {e.read().decode()}', file=sys.stderr)
    sys.exit(1)

# ── Parsear CSV ───────────────────────────────────────────
reader = csv.DictReader(io.StringIO(csv_raw), delimiter=';')
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

# ── Lógica de os_numero (baseada na Modalidade) ───────────
def calcular_os_numero(row, motivo_norm):
    if motivo_norm == 'DE OFICIO':
        return _clean(row.get('Oficio') or row.get('OFICIO') or '')
    if motivo_norm == 'PROTOCOLO':
        return _clean(row.get('Protocolo') or row.get('PROTOCOLO') or '')
    if motivo_norm == 'DENUNCIA':
        return _clean(row.get('Denuncia') or row.get('DENUNCIA') or '')
    return ''  # VIGILANCIA ATIVA, PLANTAO FISCAL e demais: sem OS

# ── Lógica de descricao (apenas CNAE) ────────────────────
def calcular_descricao(row, tipo_label, descricao_atual=''):
    # Se a descrição atual já contém "CNAE ", extrai tudo a partir dali —
    # isso preserva o nome completo do CNAE que o import JS já havia gravado.
    idx = descricao_atual.find('CNAE ')
    if idx >= 0:
        return descricao_atual[idx:]
    # Fallback: nome CNAE não disponível, usa só o código da coluna Atividade
    subclasse = _clean(row.get('Atividade', ''))
    return ('CNAE ' + subclasse) if subclasse else (tipo_label or '')

# ── Consultar todos os registros visa_csv ─────────────────
print('Consultando todos os documentos visa_csv...')
results = fs_query_all_visa()
visa_docs = [item['document'] for item in results if item.get('document')]
print(f'✅ {len(visa_docs)} documento(s) VISA encontrado(s).')

# ── Backfill ──────────────────────────────────────────────
if DRY_RUN:
    print('\n⚠️  MODO SIMULAÇÃO (DRY_RUN=true) — nenhum dado será gravado.\n')

atualizados = 0
sem_alteracao = 0
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

    # Calcular motivo_os (Modalidade bruta)
    motivo_os_csv = _clean(
        row.get('Modalidade') or row.get('modalidade') or row.get('MODALIDADE') or ''
    )
    motivo_os_norm = norm_visa(motivo_os_csv)

    # Calcular os_numero pela lógica correta (Modalidade-based)
    os_numero_novo = calcular_os_numero(row, motivo_os_norm)

    # Calcular descricao (apenas CNAE — extrai da descricao atual para preservar o nome)
    descricao_atual  = fstr(doc, 'descricao')
    tipo_label = fstr(doc, 'tipo_nome') or fstr(doc, 'tipo_codigo') or ''
    descricao_nova = calcular_descricao(row, tipo_label, descricao_atual)

    # Calcular documento
    documento_novo = _clean(
        row.get('tipo') or row.get('Tipo') or row.get('TIPO') or ''
    )

    # Campos que SEMPRE são atualizados (corrigir valores errados)
    campos_sempre = {
        'os_numero': os_numero_novo,
        'descricao': descricao_nova,
    }

    # Campos que só são preenchidos se estiverem vazios
    campos_se_vazio = {}
    if not fstr(doc, 'motivo_os'):
        campos_se_vazio['motivo_os'] = motivo_os_csv
    if not fstr(doc, 'documento'):
        campos_se_vazio['documento'] = documento_novo

    todos_campos = {**campos_sempre, **campos_se_vazio}

    # Verificar se há algo a fazer: os campos_sempre precisam mudar?
    os_numero_atual  = fstr(doc, 'os_numero')
    sem_mudanca = (
        os_numero_atual == os_numero_novo
        and descricao_atual == descricao_nova
        and not campos_se_vazio
    )
    if sem_mudanca:
        sem_alteracao += 1
        continue

    if DRY_RUN:
        print(f'  [DRY] {doc_id} (controle={controle}):')
        if os_numero_atual != os_numero_novo:
            print(f'         os_numero: "{os_numero_atual}" → "{os_numero_novo}"')
        if descricao_atual != descricao_nova:
            print(f'         descricao: "{descricao_atual}" → "{descricao_nova}"')
        for k, v in campos_se_vazio.items():
            print(f'         {k}: (vazio) → "{v}"')
        atualizados += 1
        continue

    try:
        fs_patch(doc_id, todos_campos)
        atualizados += 1
    except urllib.error.HTTPError as e:
        print(f'  ❌ {doc_id}: HTTP {e.code} — {e.read().decode()}', file=sys.stderr)
        erros += 1
    except Exception as e:
        print(f'  ❌ {doc_id}: erro inesperado — {e}', file=sys.stderr)
        erros += 1

# ── Resumo ────────────────────────────────────────────────
prefixo = '[DRY] ' if DRY_RUN else ''
print(f'\n{prefixo}Resumo:')
print(f'  Atualizados:        {atualizados}')
print(f'  Sem alteração:      {sem_alteracao}')
print(f'  Sem linha no CSV:   {sem_linha_csv}')
print(f'  Erros:              {erros}')
if DRY_RUN:
    print('\nPara aplicar, re-execute com DRY_RUN=false.')
if erros:
    sys.exit(1)
