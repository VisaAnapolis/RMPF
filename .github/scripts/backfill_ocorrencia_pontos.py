"""
Regrava os lançamentos de ocorrência (origem=ocorrencia) de uma competência
pelo rateio canônico: 1000 pontos divididos pelos dias úteis do mês. Espelha
`taxaDiariaOcorrencia()` de js/utils.js — a mesma regra usada pelo aceite
(db_aceitarOcorrencia) e pela ferramenta "Converter Ocorrências Aceitas em
Pontos" de parametrizacao.html.

O fator 30h (40/30) NÃO se aplica ao rateio: os 1000 pontos já são o teto
mensal (teto_pv, js/calculo.js), não uma pontuação por atividade.

Serviu originalmente para migrar os lançamentos gerados com a lógica antiga
(50 pontos fixos por dia, inclusive fins de semana e feriados); continua
sendo a rota para uniformizar uma competência inteira fora do navegador.

Para cada ocorrência aceita que cobre algum dia da competência MES/ANO:
  - apaga TODOS os lançamentos existentes do fiscal nesses dias
    (mesmo comportamento de db_deleteLancamentosDia);
  - recria um lançamento apenas nos dias úteis, com pontos = 1000 / dias
    úteis do mês (arredondado em 2 casas). Dias não úteis ficam sem
    lançamento.

Variáveis de ambiente:
  FIREBASE_SA_JSON  — conteúdo JSON da service account (obrigatório)
  MES               — mês da competência, 1-12 (obrigatório)
  ANO               — ano da competência, ex. 2026 (obrigatório)
  FISCAL_EMAILS     — opcional, lista separada por vírgula para restringir
                       o processamento a fiscais específicos (default: todos
                       os fiscais com ocorrência aceita cobrindo a competência)
  DRY_RUN           — "true" para simular sem gravar (default: "true")
"""

import datetime as dt
import json, os, sys, urllib.request, urllib.error

import google.oauth2.service_account
import google.auth.transport.requests

PROJECT_ID    = 'visam-3a30b'
FIRESTORE_URL = f'https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents'

DRY_RUN = os.environ.get('DRY_RUN', 'true').strip().lower() not in ('false', '0', 'no')
MES = int(os.environ['MES'])
ANO = int(os.environ['ANO'])
FISCAL_EMAILS = {
    e.strip().lower() for e in os.environ.get('FISCAL_EMAILS', '').split(',') if e.strip()
}

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

# ── Helpers Firestore (REST API) ──────────────────────────

def fs_run_query(body):
    req = urllib.request.Request(
        f'{FIRESTORE_URL}:runQuery', data=json.dumps(body).encode(),
        method='POST', headers=_headers(),
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def fs_delete(doc_id, collection='manuais'):
    req = urllib.request.Request(
        f'{FIRESTORE_URL}/{collection}/{doc_id}', method='DELETE', headers=_headers(),
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        r.read()

def fs_create(collection, fields):
    req = urllib.request.Request(
        f'{FIRESTORE_URL}/{collection}', data=json.dumps({'fields': fields}).encode(),
        method='POST', headers=_headers(),
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def fval(doc, field):
    """Extrai o valor "cru" (string/int/float/bool) de um campo do documento REST."""
    fv = doc.get('fields', {}).get(field, {})
    for key in ('stringValue', 'integerValue', 'doubleValue', 'booleanValue'):
        if key in fv:
            v = fv[key]
            return int(v) if key == 'integerValue' else v
    return None

def query_ocorrencias_aceitas():
    body = {
        'structuredQuery': {
            'from': [{'collectionId': 'ocorrencias'}],
            'where': {
                'fieldFilter': {
                    'field': {'fieldPath': 'status'},
                    'op': 'EQUAL',
                    'value': {'stringValue': 'aceito'},
                }
            },
        }
    }
    results = fs_run_query(body)
    return [item['document'] for item in results if item.get('document')]

def query_manuais_do_dia(fiscal_email, mes, ano):
    body = {
        'structuredQuery': {
            'from': [{'collectionId': 'manuais'}],
            'where': {
                'compositeFilter': {
                    'op': 'AND',
                    'filters': [
                        {'fieldFilter': {'field': {'fieldPath': 'fiscal_email'}, 'op': 'EQUAL',
                                          'value': {'stringValue': fiscal_email}}},
                        {'fieldFilter': {'field': {'fieldPath': 'mes'}, 'op': 'EQUAL',
                                          'value': {'integerValue': mes}}},
                        {'fieldFilter': {'field': {'fieldPath': 'ano'}, 'op': 'EQUAL',
                                          'value': {'integerValue': ano}}},
                    ],
                }
            },
        }
    }
    results = fs_run_query(body)
    return [item['document'] for item in results if item.get('document')]

# ── Feriados / dias úteis (mesma lógica de js/utils.js) ───

FERIADOS_NACIONAIS_FIXOS_MMDD = {'01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25'}

def carregar_feriados_municipais():
    caminho = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'feriados.csv')
    with open(caminho, encoding='utf-8') as f:
        linhas = [l.strip() for l in f.read().strip().split('\n')][1:]
    return {l.split(',')[0].strip() for l in linhas if l.strip()}

def _domingo_de_pascoa(ano):
    """Algoritmo de Meeus/Butcher (calendário gregoriano)."""
    a = ano % 19
    b, c = divmod(ano, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    mes, dia = divmod(h + l - 7 * m + 114, 31)
    return dt.date(ano, mes, dia + 1)

def feriados_moveis_nacionais(ano):
    """Carnaval (seg/ter), Sexta-feira Santa e Corpus Christi.

    `data/feriados.csv` só lista o ano corrente; derivá-los da Páscoa mantém a
    contagem de dias úteis correta em qualquer ano.
    """
    pascoa = _domingo_de_pascoa(ano)
    return {
        (pascoa - dt.timedelta(days=48)).isoformat(),  # Carnaval — segunda
        (pascoa - dt.timedelta(days=47)).isoformat(),  # Carnaval — terça
        (pascoa - dt.timedelta(days=2)).isoformat(),   # Sexta-feira Santa
        (pascoa + dt.timedelta(days=60)).isoformat(),  # Corpus Christi
    }

def eh_dia_util(data_iso, feriados_set):
    d = dt.date.fromisoformat(data_iso)
    if d.weekday() >= 5:  # 5=sábado, 6=domingo
        return False
    if data_iso[5:] in FERIADOS_NACIONAIS_FIXOS_MMDD:
        return False
    if data_iso in feriados_moveis_nacionais(d.year):
        return False
    return data_iso not in feriados_set

def dias_uteis_no_mes(mes, ano, feriados_set):
    primeiro = dt.date(ano, mes, 1)
    ultimo_dia = (dt.date(ano + (mes == 12), (mes % 12) + 1, 1) - dt.timedelta(days=1)).day
    count = 0
    for dia in range(1, ultimo_dia + 1):
        iso = f'{ano:04d}-{mes:02d}-{dia:02d}'
        if eh_dia_util(iso, feriados_set):
            count += 1
    return count

def dias_da_ocorrencia_no_mes(data_inicio, data_fim, mes, ano):
    fim = data_fim or data_inicio
    cur = dt.date.fromisoformat(data_inicio)
    end = dt.date.fromisoformat(fim)
    dias = []
    while cur <= end:
        if cur.month == mes and cur.year == ano:
            dias.append(cur.isoformat())
        cur += dt.timedelta(days=1)
    return dias

MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
         'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']

MEDIA_PRODUTIVIDADE_OCORRENCIA = 1000


def memoria_calculo(mes, ano, total_uteis, taxa):
    """Explicação do número, gravada na descrição do lançamento.

    Espelha a `memoria` de taxaDiariaOcorrencia() em js/utils.js — inclusive o
    ponto decimal e as 2 casas de formatPontos(), para que um lançamento
    regravado aqui fique idêntico ao gerado pelo aceite no navegador.
    """
    return (f'{MEDIA_PRODUTIVIDADE_OCORRENCIA} pts ÷ {total_uteis} dias úteis de '
            f'{MESES[mes - 1]} / {ano} = {taxa:.2f} pt/dia útil')


TIPO_LABELS = {
    'ferias': 'Férias', 'licenca_medica': 'Licença Médica',
    'licenca_gestante': 'Licença Gestante', 'cargo_comissao': 'Cargo em Comissão',
    'afastamento_legal': 'Outros afastamentos funcionais imperativos',
    'outros': 'Outros afastamentos funcionais imperativos',
}

def rfc3339_agora():
    return dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

# ── Execução ────────────────────────────────────────────────
print(f'Backfill pontos de ocorrência — competência {MES:02d}/{ANO} — dry_run={DRY_RUN}')
if FISCAL_EMAILS:
    print(f'Restrito aos fiscais: {sorted(FISCAL_EMAILS)}')

feriados = carregar_feriados_municipais()
total_uteis = dias_uteis_no_mes(MES, ANO, feriados)
taxa = round(MEDIA_PRODUTIVIDADE_OCORRENCIA / total_uteis, 2) if total_uteis > 0 else 0
MEMORIA = memoria_calculo(MES, ANO, total_uteis, taxa)
print(f'Rateio: {MEMORIA}\n')

print('Consultando ocorrências aceitas...')
ocorrencias = query_ocorrencias_aceitas()
print(f'✅ {len(ocorrencias)} ocorrência(s) aceita(s) no total (todas as competências).\n')

if DRY_RUN:
    print('⚠️  MODO SIMULAÇÃO (DRY_RUN=true) — nenhum dado será gravado.\n')

total_dias_gerados = 0
total_dias_pulados = 0
total_apagados = 0
erros = 0

for doc in ocorrencias:
    doc_id = doc.get('name', '').split('/')[-1]
    try:
        fiscal_email = (fval(doc, 'fiscal_email') or '').strip()
        if FISCAL_EMAILS and fiscal_email.lower() not in FISCAL_EMAILS:
            continue

        data_inicio = fval(doc, 'data_inicio')
        data_fim    = fval(doc, 'data_fim') or data_inicio
        if not data_inicio:
            continue

        dias = dias_da_ocorrencia_no_mes(data_inicio, data_fim, MES, ANO)
        if not dias:
            continue

        fiscal_nome = fval(doc, 'fiscal_nome') or fiscal_email
        tipo        = fval(doc, 'tipo') or ''
        obs_admin   = fval(doc, 'obs_admin')
        tipo_label  = TIPO_LABELS.get(tipo, tipo)

        print(f'👤 {fiscal_nome} ({fiscal_email}) — {tipo_label} — {len(dias)} dia(s) em {MES:02d}/{ANO}')

        for dia in dias:
            existentes = query_manuais_do_dia(fiscal_email, MES, ANO)
            existentes_do_dia = [d for d in existentes if fval(d, 'data') == dia]

            if existentes_do_dia:
                if DRY_RUN:
                    print(f'   [DRY] {dia}: apagaria {len(existentes_do_dia)} lançamento(s) existente(s)')
                else:
                    for d in existentes_do_dia:
                        fs_delete(d.get('name', '').split('/')[-1])
                total_apagados += len(existentes_do_dia)

            if not eh_dia_util(dia, feriados):
                total_dias_pulados += 1
                print(f'   {dia}: dia não útil — sem lançamento')
                continue

            controle = f'OCR-{ANO}-{MES:02d}-{dia.replace("-", "")}'
            if DRY_RUN:
                print(f'   [DRY] {dia}: criaria lançamento {controle} com {taxa} pontos')
            else:
                fs_create('manuais', {
                    'controle':          {'stringValue': controle},
                    'fiscal_email':      {'stringValue': fiscal_email},
                    'fiscal_nome':       {'stringValue': fiscal_nome},
                    'mes':               {'integerValue': MES},
                    'ano':               {'integerValue': ANO},
                    'data':              {'stringValue': dia},
                    'tipo_id':           {'integerValue': 99},
                    'tipo_codigo':       {'stringValue': 'OCR'},
                    'tipo_nome':         {'stringValue': 'Ocorrência'},
                    'item_pontuacao':    {'nullValue': None},
                    'complexidade':      {'stringValue': '—'},
                    'pontos':            {'doubleValue': taxa},
                    'pontos_homologado': {'doubleValue': taxa},
                    'descricao':         {'stringValue': f'Ocorrência: {tipo_label} — aceita pelo administrador ({MEMORIA})'},
                    'obs':               ({'stringValue': obs_admin} if obs_admin else {'nullValue': None}),
                    'status':            {'stringValue': 'homologado'},
                    'origem':            {'stringValue': 'ocorrencia'},
                    'ocorrencia_id':     {'stringValue': doc_id},
                    'created_at':        {'timestampValue': rfc3339_agora()},
                    'updated_at':        {'timestampValue': rfc3339_agora()},
                })
            total_dias_gerados += 1

    except urllib.error.HTTPError as e:
        try:
            detalhe = e.read().decode()
        except Exception:
            detalhe = ''
        print(f'  ❌ {doc_id}: HTTP {e.code} — {detalhe} — pulando.', file=sys.stderr)
        erros += 1
    except Exception as e:
        print(f'  ❌ {doc_id}: erro inesperado — {e} — pulando.', file=sys.stderr)
        erros += 1

# ── Resumo ────────────────────────────────────────────────
prefixo = '[DRY] ' if DRY_RUN else ''
print(f'\n{prefixo}Resumo ({MES:02d}/{ANO}):')
print(f'  Dias com lançamento gerado (taxa {taxa:.2f}):  {total_dias_gerados}')
print(f'  Dias não úteis pulados:                    {total_dias_pulados}')
print(f'  Lançamentos antigos apagados:               {total_apagados}')
print(f'  Erros:                                      {erros}')
if DRY_RUN:
    print('\nPara aplicar, re-execute com DRY_RUN=false.')
if erros:
    sys.exit(1)
