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
| Complexidade | Tabela `data/cnae.csv` do VISA → copiada permanentemente no Firestore (coleção `cnae_complexidade`) |

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

## 12. Tabela CNAE no Firestore (Seed Permanente)

### Coleção: `cnae_complexidade`

| Campo | Tipo | Descrição |
|---|---|---|
| `subclasse` | string | Código CNAE (ex: `4731-8/00`) — ID do documento |
| `complexidade` | string | `Alta`, `Média` ou `Baixa` |
| `descricao` | string | Descrição da atividade econômica |
| `updated_at` | timestamp | Data da última sincronização |

### Por que Firestore e não buscar o CSV na hora?

- O `cnae.csv` raramente muda (tabela oficial do IBGE/ANVISA)
- Buscar o CSV a cada importação de inspeções adicionaria latência e leitura desnecessária
- **Opção mais leve para o dia a dia:** seed no Firestore, lido localmente a cada importação

### Seed via `admin.html`

O Administrador tem um botão **"🔄 Sincronizar CNAE com Firestore"** em `admin.html` que:
1. Busca `data/cnae.csv` do VISA (GitHub raw)
2. Faz o parse com PapaParse
3. Grava em lote (batch) na coleção `cnae_complexidade`
4. Operação é **idempotente** — pode ser repetida quando o CSV do VISA for atualizado

---

## 13. Arquivos Criados/Modificados

| Arquivo | Tipo | O que muda |
|---|---|---|
| `js/visa-import.js` | 🆕 Novo | Módulo central: busca CSV, resolve CNAE, cria/atualiza documentos |
| `js/firestore.js` | ✏️ Modificado | + `db_getCNAEComplexidade`, `db_seedCNAEComplexidade`, `db_getVISAManual`, `db_upsertVISAManual` |
| `lancamento.html` | ✏️ Modificado | + Card de importação acima do formulário + PapaParse + visa-import.js |
| `meus-lancamentos.html` | ✏️ Modificado | + Botão de importação + badge CVS para registros bloqueados |
| `conferencia.html` | ✏️ Modificado | + Botão de importação (admin only) + badge CVS |
| `admin.html` | ✏️ Modificado | + Card "Seed CNAE" com botão de sincronização + PapaParse |
| `firestore.rules` | ✏️ Modificado | + Regra de leitura para `cnae_complexidade` por autenticados |

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
1. ADMINISTRADOR (primeiro uso):
   └── admin.html → "🔄 Sincronizar CNAE com Firestore"
       └── Popula coleção cnae_complexidade

2. FISCAL (todo mês a partir de Abril/2026):
   └── lancamento.html OU meus-lancamentos.html
       └── Seleciona mês/ano
       └── Clica "📥 Importar Inspeções do CSV"
       └── Sistema busca inspecoes.csv do VISA
       └── Filtra por mês/ano e pelo email do fiscal logado
       └── Para cada inspeção encontrada:
           └── Busca complexidade no Firestore (cnae_complexidade)
           └── Cria ou atualiza lançamento na coleção manuais
       └── Exibe log de progresso (criados / atualizados / ignorados / erros)

3. ADMINISTRADOR (homologação):
   └── conferencia.html
       └── Seleciona fiscal + competência
       └── Pode importar pelo botão (para qualquer fiscal)
       └── Homologa ou recusa cada lançamento individualmente
       └── Registro homologado → bloqueado para re-importação

4. ADMINISTRADOR (fechamento):
   └── fechamento.html
       └── Fecha competência → todos os aceitos viram "fechado"
       └── Bloqueio definitivo para re-importação
```

---

## 16. Regras de Negócio — Resumo Rápido

| Regra | Detalhe |
|---|---|
| Período mínimo | Abril/2026 |
| Fiscais por inspeção | Até 3 — cada um recebe lançamento independente |
| Chave do documento | `visa_{CONTROLE}_{email_normalizado}` |
| Re-importação | Sobrescreve se não homologado; ignora se homologado |
| Edição pelo fiscal | Proibida para `origem: 'visa_csv'` |
| Homologação | Admin homologa individualmente por fiscal |
| Seed CNAE | Uma vez (ou quando `cnae.csv` do VISA mudar) |
| Descrição | `Vistoria VISA — OS X — CNAE Y — [descrição]` |
| Controle RMPF | `VISA-{CONTROLE do CSV}` |

---

*Documento gerado em 28/04/2026 — RMPF / VISA Anápolis*
