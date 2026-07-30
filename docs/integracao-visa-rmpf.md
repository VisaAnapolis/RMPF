# Integração VISA → RMPF — Plano Completo

> **Documento de referência** para implementação da importação automática de inspeções do sistema VISA (Vigilância Sanitária Municipal de Anápolis) como lançamentos de atividade no RMPF (Relatório Mensal de Produtividade Fiscal).

---

## 1. Visão Geral

O sistema deve buscar automaticamente as inspeções registradas no VISA (`garrado/VISA`) e criar os lançamentos correspondentes no RMPF (`garrado/RMPF`), do tipo **"Vistoria ou atendimento a denúncia"** (código `VIS`), sem que o fiscal precise digitá-los manualmente.

---

## 2. Fonte de Dados

| Item | Valor |
|---|---|
| Arquivo | `https://raw.githubusercontent.com/garrado/VISA/main/data/inspecoes.csv` |
| Separador | `;` |
| Encoding | UTF-8 (com possível BOM — PapaParse trata automaticamente) |
| Complexidade | Tabela `data/cnae.csv` do VISA (fonte única) — buscada e carregada em memória (`cnaeMap`) a cada importação |

### Campos utilizados do `inspecoes.csv`

| Campo CSV | Uso no RMPF |
|---|---|
| `CONTROLE` | Chave da inspeção no VISA |
| `DT_VISITA` | Data da vistoria (formato `dd.mm.yyyy` → convertido para `yyyy-mm-dd`) |
| `Atividade` | Código CNAE → usado para buscar complexidade e descrição |
| `Fiscal1` | Nome do 1º fiscal |
| `Fiscal2` | Nome do 2º fiscal (pode estar vazio) |
| `Fiscal3` | Nome do 3º fiscal (pode estar vazio) |
| `OS` / `NUMERO` | Número do documento — compõe a descrição |

---

## 3. Múltiplos Fiscais por Inspeção

Cada linha do CSV pode ter **até 3 fiscais** (`Fiscal1`, `Fiscal2`, `Fiscal3`).

**Regra:** cada fiscal que participou da inspeção tem **direito ao seu próprio lançamento independente** no RMPF. O mesmo `CONTROLE` gera até 3 documentos no Firestore — um por fiscal.

- Os lançamentos de cada fiscal são **totalmente independentes** entre si.
- Homologar o lançamento de um fiscal **não afeta** os lançamentos dos outros.
- O "bloqueio" se aplica apenas individualmente: uma vez que o lançamento de determinado fiscal foi homologado (`aceito` ou `fechado`), aquele documento específico não pode mais ser re-importado/sobrescrito.

### Chave única no Firestore

```
ID do documento = "visa_{CONTROLE}_{email_normalizado}"
```

Exemplo: `CONTROLE 58400` + `pedro@visa.go.gov.br` → `visa_58400_pedro_visa_go_gov_br`

---

## 4. Match Nome CSV → Email RMPF

O CSV armazena o **nome completo** do fiscal, não o e-mail. O RMPF usa e-mail como identificador.

**Algoritmo de normalização:**
1. Remover acentos (NFD + strip diacríticos)
2. Converter para UPPERCASE
3. Colapsar espaços múltiplos
4. Comparar com os nomes cadastrados na coleção `usuarios` do Firestore

---

## 5. Escopo Temporal

| Período | Comportamento |
|---|---|
| Antes de Abril/2026 | ❌ Bloqueado — botão desabilitado com mensagem `"Mês anterior a Abril/2026 — impossível importar"` |
| **Abril/2026** | ✅ Mês de teste — importa normalmente |
| Maio/2026 em diante | ✅ Produção |

O filtro é aplicado no campo `DT_VISITA`: apenas registros cujo mês/ano coincidam com a competência selecionada são processados.

---

## 6. Lógica de Importação (Idempotência com Sobrescrita)

```
Para cada linha do CSV filtrada pelo mês/ano:
  Para cada Fiscal1, Fiscal2, Fiscal3 (não vazio):

    Resolve email do fiscal via normalização de nome

    Busca no Firestore: documento "visa_{CONTROLE}_{email}"

    ├── NÃO existe
    │     → CRIA documento (status: 'enviado')
    │
    ├── Existe + status NÃO homologado
    │   ('enviado', 'rascunho', 'recusado', 'pendente')
    │     → SOBRESCREVE campos (data, CNAE, complexidade, pontos, descrição)
    │       Mantém: status atual, controle RMPF, created_at
    │
    └── Existe + status homologado ('aceito' ou 'fechado')
          → IGNORA + exibe aviso individual:
            "⚠️ CONTROLE X — [fiscal]: já homologado, ignorado"
```

**Por que sobrescrever?** Os dados do CSV podem ser corrigidos retroativamente (data errada, fiscal trocado, CNAE atualizado). A re-importação garante que o RMPF sempre reflita o estado atual do VISA.

---

## 7. Complexidade → Item de Pontuação

| Complexidade (CNAE) | Item RMPF | Pontos |
|---|---|---|
| Alta | 1 | 48 |
| Média | 2 | 12 |
| Baixa | 3 | 6 |
| Não encontrado (default) | 2 | 12 |

### Teto de 48 pontos por inspeção (Vistoria)

Em uma Vistoria (VIS), os CNAEs-alvo são o **CNAE informado** na inspeção
(`inspecoes.csv`) somado aos **CNAEs extras informados pelo fiscal** no VISA
(`inspecoes_cnae.csv`, vinculado à visita pela coluna `VISITA_CTRL` →
`CONTROLE` do `inspecoes.csv`). A complexidade/pontuação de cada CNAE extra
vem do `cnae.csv` (fonte única); extra sem competência no `cnae.csv` é
ignorado com aviso. A **soma dos pontos** desses CNAEs **não pode
exceder 48 pontos**. A ordem de seleção é:

1. **CNAEs de alta complexidade primeiro** — inclusive a alta de alimentação já
   ajustada por área (8/16), que vale menos que uma média;
2. depois, **maior pontuação primeiro**;
3. em empate, o **CNAE informado** primeiro.

A seleção acumula enquanto a soma ≤ 48; os CNAEs que não couberem **não são
lançados** (o laço não para no primeiro que não cabe — segue tentando os
seguintes, para aproveitar o teto ao máximo).

Exemplos:

| Informado | inspecoes_cnae.csv | Lançado | Soma |
|---|---|---|---|
| 48 (alta) | qualquer | só o informado (48) | 48 |
| 12 (média) | 4× de 12 | informado + 3 primeiros extras | 48 |
| 12 (média) | 1× de 48 | só o extra (48) | 48 |
| 8 (alta de alimentação, ≤ 100 m²) | 4× de 12 | informado (8) + 3 primeiros extras | 44 |
| 16 (alta de alimentação, 100–400 m²) | 1× de 16 + 1× de 12 + 1× de 6 | informado (16) + 16 + 12 | 44 |

**Por que a alta vem antes da pontuação.** A alta de alimentação ajustada por
área vale 8 ou 16 pontos e, numa ordenação puramente por pontuação, ficava
**abaixo** de CNAEs de média (12, ou 9 em dupla fiscal). Havendo CNAEs de menor
complexidade suficientes para fechar os 48 sozinhos (ex.: 4× média de 12), o
CNAE de **alta** era empurrado para fora do teto e simplesmente não era lançado
— a inspeção perdia justamente o CNAE que a caracteriza. Agora a alta entra
primeiro e o restante do teto é preenchido pelos demais CNAEs. Como a alta
ocupa parte do teto, a soma final pode ficar **abaixo** de 48 (44 no exemplo
acima); isso é esperado — o teto é limite, não meta. Quando a alta vale os 48
cheios (alta comum, ou alimentação com ≥ 400 m²/sem área), nada muda: ela já
era a primeira e consome o teto sozinha.

O teto usa os pontos nominais de complexidade; os zeramentos por plantão
fiscal e o limite de 24 pts/dia em dia com ocorrência são aplicados depois,
por fiscal.

### Pontuação por área (m²) — alta complexidade de alimentação

Para CNAEs de **alta complexidade** da **área de alimentação** (equipe `IA` ou
`AG` na coluna `equipe` do `cnae.csv`), a pontuação **não** é 48 fixo: depende da
**área física do estabelecimento** (m²). Vale tanto para o CNAE informado (INS)
quanto para os extras informados pelo fiscal (CAE).

| Área (m²) | Pontos |
|---|---|
| ≤ 100 | 8 |
| > 100 e < 400 | 16 |
| ≥ 400 (inclusive) | 48 |
| Sem área cadastrada | 48 (máxima) |

O valor ajustado **entra na seleção gulosa do teto de 48** (é o ponto real do
CNAE em todo o fluxo). CNAEs que não sejam alta de alimentação mantêm a
pontuação por complexidade (alta=48, média=12, baixa=6).

Quando a alta de alimentação pontua **8 ou 16** (isto é, não consome os 48
sozinha), ela **soma com os demais CNAEs** da mesma inspeção respeitando o
mesmo teto de 48 — e entra na seleção **antes** deles, para não ser deslocada
por CNAEs de complexidade menor (ver "Teto de 48 pontos por inspeção" acima).

A aplicação da regra é controlada por um **flag em Parametrização**
(`parametrizacao.html`, card "Produtividade — Pontuação por Área (Alimentos
Alta Complexidade)"), persistido em `app_config/visa_area_alimentacao` no
Firestore e lido no início de cada importação. **Ligado por padrão**; quando
desligado, os CNAEs de alta de alimentação pontuam 48 fixo como qualquer alta
(Item 1), o `taxa.csv` não é consultado e `visa_area` fica nulo.

#### Cadeia de junção da área

A área não está no `inspecoes.csv`; é obtida encadeando 3 arquivos do VISA:

1. `inspecoes.csv` → campo **`CODIGO`** (código do regulado).
2. **`regulados.csv`** → casa por `CODIGO` e fornece **`MUNICIPAL`** (inscrição
   municipal) e **`RAZAO`** (razão social). ⚠️ A coluna `AREA` do `regulados.csv`
   **não** é a metragem (são códigos cadastrais) e é ignorada.
3. **`taxa.csv`** (ISO-8859-1; cada registro ocupa 2 linhas físicas) → casa pela
   inscrição municipal e traz a metragem no campo "Observação" (`* Área: 150m²`).

A inscrição municipal é normalizada (só dígitos, sem zeros à esquerda) antes do
casamento — ex.: `regulados.MUNICIPAL="29.601"` ↔ `taxa="29601"`. O `taxa.csv` é
carregado de forma preguiçosa (apenas quando há candidato de alta de
alimentação). A importação grava em cada lançamento: `codigo`, `razao`,
`municipal` e `visa_area` (m², só para alta de alimentação; demais ficam nulos).

### Redução por dupla/trio fiscal (decreto E.2)

Em **Vistorias** realizadas por **2 ou mais fiscais** (`fiscaisCsv.length ≥ 2`,
contando os participantes presentes em `Fiscal1`/`Fiscal2`/`Fiscal3`), a
pontuação dos CNAEs de **baixa e média complexidade** é reduzida **para cada
fiscal individualmente**:

| Complexidade (CNAE) | Pontos (1 fiscal) | Pontos (2+ fiscais) | Redução |
|---|---|---|---|
| Média | 12 | **9** | −25% |
| Baixa | 6 | **3** | −50% |
| Alta | 48 (ou 8/16/48 por área) | inalterada | — |

- **Dupla e trio** recebem a **mesma** redução (regra binária: 1 fiscal = cheio;
  2+ = reduzido). A quantidade exata (2 ou 3) só muda o número exibido.
- **Alta complexidade não é reduzida** — inclusive a alta de alimentação já
  ajustada por área (8/16/48), pois continua sendo de complexidade alta.
- **Abrangência: só Vistorias (VIS).** Os demais tipos de inspeção não sofrem
  esta redução.
- A redução é aplicada **antes** da seleção gulosa, então o valor reduzido (9/3)
  é o que **entra no teto de 48**, permitindo que mais CNAEs caibam.
- A importação grava `qtd_fiscais` em cada lançamento **apenas quando a regra
  reduz** aquele CNAE (baixa/média em inspeção com 2+ fiscais); nos demais o
  campo fica nulo. Esse valor é exibido na coluna **"Fiscais"** das tabelas.

---

## 8. Descrição Gerada Automaticamente

```
Vistoria VISA — OS {OS ou NUMERO} — CNAE {Atividade} — {descrição do CNAE}
```

Exemplo:
```
Vistoria VISA — OS 65922 — CNAE 4731-8/00 — Comércio varejista de combustíveis para veículos automotores
```

---

## 9. Estrutura do Documento no Firestore (coleção `manuais`)

```json
{
  "id": "visa_58400_pedro_visa_go_gov_br",
  "origem": "visa_csv",
  "visa_controle": "58400",
  "controle": "VISA-58400",
  "fiscal_email": "pedro@visa.go.gov.br",
  "fiscal_nome": "PEDRO HENRIQUE AIRES RIBEIRO",
  "mes": 4,
  "ano": 2026,
  "tipo_id": 1,
  "tipo_codigo": "VIS",
  "tipo_nome": "Vistoria ou atendimento a denúncia",
  "item_pontuacao": 1,
  "complexidade": "Alta",
  "pontos": 48,
  "data": "2026-04-07",
  "descricao": "Vistoria VISA — OS 65922 — CNAE 4731-8/00 — Comércio varejista de combustíveis...",
  "status": "enviado",
  "created_at": "<timestamp>",
  "updated_at": "<timestamp>"
}
```

---

## 10. Bloqueio de Edição pelo Fiscal

Registros com `origem: 'visa_csv'` são **somente leitura** para o fiscal:

- ❌ Não pode editar
- ❌ Não pode excluir
- ❌ Não pode alterar status manualmente
- ✅ Visualiza normalmente com badge **CVS** no lugar dos botões de ação

O Administrador pode homologar (`aceito`) ou recusar (`recusado`) normalmente em `conferencia.html`.

---

## 11. Botão "📥 Importar Inspeções do CSV"

### Onde aparece

| Página | Quem vê | Fiscal alvo |
|---|---|---|
| `lancamento.html` | Fiscal | Fiscal logado |
| `meus-lancamentos.html` | Fiscal | Fiscal logado |
| `conferencia.html` | Admin / Administrativo | Fiscal selecionado no `sel-fiscal` |

### Posição
- `lancamento.html`: **acima** do card do formulário manual
- `meus-lancamentos.html`: na barra `comp-selector`, ao lado do botão "Carregar"
- `conferencia.html`: na barra `comp-selector`, ao lado do botão "Carregar"

### Estados do botão

| Condição | Estado |
|---|---|
| Período < Abril/2026 | Desabilitado — `"Mês anterior a Abril/2026 — impossível importar"` |
| Mês aberto (≥ Abril/2026) | Habilitado |
| Durante a importação | Desabilitado temporariamente com spinner |

> **Nota:** registros individuais já homologados são ignorados **silenciosamente com aviso no log** — o botão não é bloqueado por causa deles. O bloqueio total só ocorre para período anterior a Abril/2026.

---

## 12. Tabela CNAE — `data/cnae.csv` (fonte única)

A complexidade/competência CNAE vem **exclusivamente** do `data/cnae.csv` do VISA. A cada
importação, `visa-import.js` busca o CSV via `fetchGitHubCSV('data/cnae.csv')` e monta o
`cnaeMap` em memória:

| Chave | Valor (`cnaeMap.get(subclasse)`) |
|---|---|
| `subclasse` (código CNAE) | `{ complexidade, complexidade_origem, descricao, equipe }` |

- `complexidade` — normalizada (`alta`/`media`/`baixa`), **já com o override do Decreto 49.723/2023 aplicado**
- `complexidade_origem` — complexidade original antes do override (ou `null`)
- `equipe` — equipe do CNAE (ex.: `IA`/`AG` marcam alimentação, usado na pontuação por área)
- A **presença** no `cnaeMap` define que o CNAE é de competência da vigilância

### Por que CSV e não Firestore?

- O `cnae.csv` raramente muda, mas o import **já o baixa de qualquer forma** (para montar o
  `cnaeMap` com `equipe`/competência) — manter uma cópia no Firestore era redundante.
- Ler a tabela inteira no Firestore custaria ~268 leituras por carga; o CSV é 1 fetch estático
  (0 leituras Firestore).
- Fonte única elimina o risco de inconsistência (CSV atualizado sem re-seed da coleção).

> **Histórico:** até esta versão existia uma coleção espelho `cnae_complexidade` (populada por um
> botão "🔄 Sincronizar CNAE com Firestore") consultada via `db_getCNAEComplexidade`. Esse caminho
> foi **aposentado** — `cnae.csv` é agora a fonte única. Documentos remanescentes da coleção ficam
> inertes (não são lidos nem deletados pelo app).

---

## 13. Arquivos Criados/Modificados

| Arquivo | Tipo | O que muda |
|---|---|---|
| `js/visa-import.js` | 🆕 Novo | Módulo central: busca CSV, resolve CNAE, cria/atualiza documentos |
| `js/firestore.js` | ✏️ Modificado | + `db_getVISAManual`, `db_upsertVISAManual` (CNAE lido do `cnae.csv`, não do Firestore) |
| `lancamento.html` | ✏️ Modificado | + Card de importação acima do formulário + PapaParse + visa-import.js |
| `meus-lancamentos.html` | ✏️ Modificado | + Botão de importação + badge CVS para registros bloqueados |
| `conferencia.html` | ✏️ Modificado | + Botão de importação (admin only) + badge CVS |

---

## 14. Dependências Externas

- **PapaParse 5.4.1** — parse do CSV
  ```html
  <script src="https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js"></script>
  ```
  Adicionado no `<head>` de: `lancamento.html`, `meus-lancamentos.html`, `conferencia.html`, `admin.html`

- **`js/visa-import.js`** — carregado após `js/guard.js` em todas as páginas que usam o botão de importação

---

## 15. Fluxo Completo de Uso

```
1. FISCAL (todo mês a partir de Abril/2026):
   └── lancamento.html OU meus-lancamentos.html
       └── Seleciona mês/ano
       └── Clica "📥 Importar Inspeções do CSV"
       └── Sistema busca inspecoes.csv + cnae.csv do VISA (monta cnaeMap em memória)
       └── Filtra por mês/ano e pelo email do fiscal logado
       └── Para cada inspeção encontrada:
           └── Resolve complexidade pelo cnaeMap (data/cnae.csv) — fonte única
           └── Cria ou atualiza lançamento na coleção manuais
       └── Exibe log de progresso (criados / atualizados / ignorados / erros)

2. ADMINISTRADOR (homologação):
   └── conferencia.html
       └── Seleciona fiscal + competência
       └── Pode importar pelo botão (para qualquer fiscal)
       └── Homologa ou recusa cada lançamento individualmente
       └── Registro homologado → bloqueado para re-importação

3. ADMINISTRADOR (fechamento):
   └── fechamento.html
       └── Fecha competência → todos os aceitos viram "fechado"
       └── Bloqueio definitivo para re-importação
```

---

## 15.1. Plantão Fiscal × Vistorias (não cumulatividade)

Regra: **Plantão fiscal não é cumulativo com a pontuação das vistorias realizadas no mesmo dia** (Anexo VII, item 9). A regra é **por fiscal** — o plantão de um fiscal só afeta as vistorias dele. Cobre vistorias importadas de **ambas** as origens, VISA e SIM.

| Situação | Comportamento |
|---|---|
| Plantão manual (PLT) lançado **antes** da importação | Ao importar, as vistorias (`VIS`) do VISA e/ou do SIM naquela data entram com **pontos = 0** automaticamente, e o motivo é gravado em `zerado_motivo`. Log: *"vistoria zerada — plantão fiscal manual em DD/MM"*. |
| Fiscal **escalado** para plantão pela gerência na data (escala do VISA, coleção `plantao/AAAA-MM`) — mesmo **sem** PLT manual lançado | Ao importar, as vistorias (VISA/SIM) naquela data entram com **pontos = 0**, com `zerado_motivo` próprio citando a escala e o mesmo `dispositivo_legal` do item 9. Log: *"vistoria zerada — fiscal escalado pela gerência para plantão fiscal em DD/MM (escala VISA)"*. Fail-open: mês sem escala publicada não zera nada. Além disso, o **lançamento manual de PLT é bloqueado** quando o fiscal não consta na escala do dia (`lancamento.html` e edição em `meus-lancamentos.html`); na homologação (`conferencia.html`) o conflito **avisa o admin**, que decide caso a caso. Detalhes: `docs/validacao-escala-plantao.md`. |
| Vistorias importadas **antes** + tentativa de lançar plantão manual | **Bloqueado** em `lancamento.html` (e ao editar/corrigir em `meus-lancamentos.html`) com a mensagem *"Impossível lançar plantão em data com vistoria(s) importada(s) com pontuação"* — **apenas** quando há vistorias importadas (VISA ou SIM) que **geram pontos** (`pontos > 0`) na data. Vistorias zeradas (ex.: origem da demanda "PLANTÃO FISCAL", que já entra com `pontos = 0`) **não bloqueiam**, pois não há pontuação a não cumular. |
| Vistoria já homologada (`aceito`/`fechado`) | **Não é zerada** automaticamente — só reportada. O admin decide via conferência; `conferencia.html` revalida a regra ao homologar pontos > 0 e, havendo conflito, **avisa o admin**, que decide caso a caso (pode ajustar a pontuação homologada). |

**Identificação:**
- Plantão manual → `tipo_codigo === 'PLT'` e `origem !== 'visa_csv'` (controle `PLT-AAAA-MM-NNN`).
- Vistoria importada → `tipo_codigo === 'VIS'` e `origem === 'visa_csv'` **ou** `origem === 'sim_csv'` (`ehVistoriaQualquer`).

**Helpers** (`js/visa-import.js`): `ehPlantaoManual`, `ehVistoriaQualquer`, `datasComPlantaoManual`, `vistoriasImportadasNoDia`, `motivoNaoCumulatividadeVistoria` (revalidação avulsa, usada em `conferencia.html`). `js/sim-import.js` reaproveita `datasComPlantaoManual` para aplicar a mesma zeragem às vistorias do SIM.

### Correção retroativa — `corrige-plantao.html`

Página de utilidade (admin) que varre os lançamentos de **Junho/2026**, identifica vistorias **importadas do VISA** em datas com plantão manual do mesmo fiscal e **zera os pontos** (com simulação prévia + log). Vistorias homologadas são ignoradas. Acesso direto pela URL `corrige-plantao.html`. Ferramenta pontual e histórica — não cobre vistorias do SIM nem as regras de OPF/REL abaixo; a partir da v1.15.0 essas não-cumulatividades já são aplicadas prospectivamente na importação e reforçadas na homologação.

## 15.2. Relatório Técnico de Inspeção (alta) × Vistoria (não cumulatividade)

Regra: **relatório técnico de inspeção de alta complexidade não é cumulativo com a pontuação de vistoria no mesmo dia** (Anexo VII, item 13). Como `REL` só existe via importação do VISA (tipo `somenteCsv`, nunca lançamento manual), a regra é aplicada inteiramente dentro de `importarInspecoesVISA` (`js/visa-import.js`): a vistoria do dia é quem zera, o relatório técnico mantém seus pontos — mesmo padrão de prioridade já usado em Plantão e OPF.

Como REL e VIS podem vir de linhas diferentes do mesmo CSV, `rowsFiltradas` é ordenado (ordenação estável) para processar as linhas de relatório técnico de alta complexidade **antes** das demais, garantindo que `relAltaDatas` já esteja populado quando a vistoria do mesmo dia é processada na mesma rodada de importação.

**Identificação:** `ehRelAltaImportada` → `origem === 'visa_csv'`, `tipo_codigo === 'REL'`, `item_pontuacao === 10` (alta).

## 15.3. Rastreabilidade da zeragem por não cumulatividade

Toda vistoria (VISA ou SIM) zerada pelas regras acima (Plantão item 9, OPF item 18, REL-alta item 13) grava a explicação no campo `zerado_motivo`. `meus-lancamentos.html` e `conferencia.html` exibem um ícone ⚠️ com tooltip ao lado dos Pontos Requeridos quando esse campo está presente — antes, a única indicação da zeragem era um log de importação visível apenas a quem executava o import (nunca ao fiscal dono do lançamento).

## 15.4. Atividades de dia inteiro (48 pts) × entre si — lançamento manual

Regra: **Plantão fiscal (PLT), Operação fiscal (OPF) e Serviços técnicos requisitados pela chefia (SRV) valem 48 pontos e representam um dia inteiro de serviço; por isso não são cumulativas entre si no mesmo dia** (Decreto 49.723/2023, Anexo VII). Um fiscal só pode lançar **uma** dessas três atividades por data.

**Abrangência — só lançamentos manuais.** A verificação vale apenas entre atividades **digitadas manualmente**. Atividades importadas (VISA/SIM) não entram na regra e não são afetadas — inclusive o relatório técnico de inspeção de alta complexidade (REL, também 48 pts), que só existe via CSV (`somenteCsv`) e continua com seu tratamento próprio de não cumulatividade contra vistoria (15.2). Certidão (2 pts) e curso/palestra/encontro (24 pts) não são de dia inteiro e continuam pontuando normalmente.

**Tratamento — bloqueio na entrada.** Ao contrário das regras contra vistoria (que *zeram*), esta *bloqueia* o segundo lançamento, com mensagem citando o decreto:

- `lancamento.html` — no `salvar()`, quando `tipo.codigo ∈ {PLT, OPF, SRV}`, checa `atividadesDiaInteiroNoDia(user.email, data)` e bloqueia se já houver outra.
- `meus-lancamentos.html` — `bloqueioAtividadeDiaInteiro(idManual, dataISO)` aplicado ao editar e ao corrigir/mover a data (o `excluirId` ignora o próprio registro).

**Helpers** (`js/visa-import.js`): `ehAtividadeDiaInteiroManual(m)` (tipo ∈ `TIPOS_DIA_INTEIRO_MANUAL = ['PLT','OPF','SRV']`, origem não importada, status ≠ recusado) e `atividadesDiaInteiroNoDia(fiscalEmail, dataISO, excluirId)`.

---

## 16. Regras de Negócio — Resumo Rápido

| Regra | Detalhe |
|---|---|
| Período mínimo | Abril/2026 |
| Fiscais por inspeção | Até 3 — cada um recebe lançamento independente |
| Chave do documento | `visa_{CONTROLE}_{email_normalizado}` |
| Re-importação | Sobrescreve se não homologado; ignora se homologado |
| Edição pelo fiscal | Proibida para `origem: 'visa_csv'` |
| Homologação | Admin homologa individualmente por fiscal; revalida não cumulatividade antes de aceitar pontos > 0 (aviso com decisão caso a caso do admin) |
| Fonte CNAE | `data/cnae.csv` do VISA, carregado em memória a cada importação |
| Descrição | `Vistoria VISA — OS X — CNAE Y — [descrição]` |
| Controle RMPF | `VISA-{CONTROLE do CSV}` |
| Plantão × Vistoria (item 9) | Por fiscal, VISA + SIM: plantão manual zera vistorias importadas na data; bloqueia plantão posterior **só** se já houver vistorias importadas que geram pontos (`pontos > 0`) |
| Operação Fiscal × Vistoria (item 18) | Por fiscal, VISA + SIM: OPF manual zera vistorias importadas na data; bloqueia OPF posterior se já houver vistoria na data |
| Relatório Técnico (alta) × Vistoria (item 13) | Por fiscal, só VISA (REL é `somenteCsv`): relatório técnico de alta complexidade zera vistoria do mesmo dia |
| Atividades de 48 pts entre si (Anexo VII) | Por fiscal, **só lançamento manual**: Plantão, Operação fiscal e Serviços técnicos (48 pts) não acumulam no mesmo dia — a segunda é **bloqueada** na entrada/edição. Importadas (VISA/SIM), inclusive REL de alta, não entram na regra |

---

*Documento gerado em 28/04/2026 — RMPF / VISA Anápolis. Seções 15.2, 15.3 e revalidação de homologação adicionadas na v1.15.0.*
