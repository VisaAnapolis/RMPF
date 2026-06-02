# Índices Compostos do Firestore — RMPF

Sem índices compostos o Firestore usa filtragem client-side nas queries com múltiplos campos (`fiscal_email + mes + ano`, etc.), baixando documentos desnecessários e tornando o carregamento lento. Este guia explica como criá-los.

---

## Opção 1 — Links diretos gerados pelo browser (mais rápido ⚡)

Quando o Firestore detecta uma query sem índice, o **console do navegador** exibe um erro com um link direto para criar o índice já pré-preenchido.

1. Abra a página **Conferência** ou **Meus Lançamentos** no navegador
2. Pressione **F12** para abrir as ferramentas de desenvolvedor → aba **Console**
3. Selecione um fiscal e clique em **Carregar**
4. Se aparecer um erro vermelho como:
   ```
   The query requires an index. You can create it here: https://console.firebase.google.com/...
   ```
5. **Clique no link** — o Firebase Console abre com o índice pré-preenchido
6. Clique em **Create** — pronto!
7. Repita para cada query que exibir o erro

---

## Opção 2 — Firebase Console (manual)

Acesse: **https://console.firebase.google.com/project/visam-3a30b/firestore/indexes**

Para cada índice abaixo:
1. Clique em **Add index**
2. Preencha **Collection ID**, adicione os campos com as ordens indicadas e selecione **Query scope: Collection**
3. Clique em **Create**

> ⏳ Após criar, o índice fica com status **Building** por alguns minutos. Quando mudar para **Enabled** está pronto.

---

### Coleção `manuais`

#### Índice 1 — Lançamentos por fiscal + mês + ano
Usado em: conferência, meus-lançamentos, importação VISA/SIM

| Campo | Ordem |
|---|---|
| `fiscal_email` | Ascending |
| `mes` | Ascending |
| `ano` | Ascending |

#### Índice 2 — Lançamentos por mês + ano (visão do administrador)
Usado em: conferência (todos os fiscais), exclusão em lote

| Campo | Ordem |
|---|---|
| `mes` | Ascending |
| `ano` | Ascending |

#### Índice 3 — Lançamentos recusados por fiscal
Usado em: listagem de lançamentos recusados no meus-lançamentos

| Campo | Ordem |
|---|---|
| `fiscal_email` | Ascending |
| `status` | Ascending |

---

### Coleção `ocorrencias`

#### Índice 4 — Ocorrências por fiscal + mês + ano

| Campo | Ordem |
|---|---|
| `fiscal_email` | Ascending |
| `mes` | Ascending |
| `ano` | Ascending |

#### Índice 5 — Ocorrências por mês + ano

| Campo | Ordem |
|---|---|
| `mes` | Ascending |
| `ano` | Ascending |

---

### Coleção `fechamentos`

#### Índice 6 — Último fechamento do fiscal (mais recente primeiro)
Usado em: cálculo da próxima competência aberta

| Campo | Ordem |
|---|---|
| `fiscal_email` | Ascending |
| `ano` | Descending |
| `mes` | Descending |

#### Índice 7 — Fechamentos por mês + ano

| Campo | Ordem |
|---|---|
| `mes` | Ascending |
| `ano` | Ascending |

---

## Opção 3 — Firebase CLI (deploy automático)

O arquivo `firestore.indexes.json` na raiz do repositório já contém todos os índices acima. Se você tiver o Firebase CLI instalado e configurado, basta rodar:

```bash
firebase deploy --only firestore:indexes
```

Isso cria todos os índices de uma vez sem precisar acessar o console manualmente.

Para instalar o Firebase CLI (se ainda não tiver):
```bash
npm install -g firebase-tools
firebase login
firebase use visam-3a30b
```
