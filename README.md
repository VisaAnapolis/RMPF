# RMPF — Relatório Mensal de Produtividade Fiscal

> Sistema web para apuração da produtividade fiscal da Vigilância Sanitária de Anápolis-GO.

## Visão Geral

O RMPF permite que fiscais registrem suas atividades mensais, e que supervisores homologuem e gerem o relatório de produtividade conforme a tabela de pontuação oficial.

| Grupo | Permissões |
|-------|-----------|
| **Fiscal** | Lançar atividades, enviar para supervisão, ver próprios dados |
| **Administrativo** | Visualizar todos os fiscais (somente leitura) |
| **Administrador** | Homologar lançamentos, editar pontos, fechar competência, gerar relatório |

## Estrutura de Arquivos

```
RMPF/
├── index.html                  # Login (Google)
├── dashboard.html              # Dashboard principal
├── lancamento.html             # Lançar nova atividade (Fiscal)
├── meus-lancamentos.html       # Lista de lançamentos (Fiscal)
├── conferencia.html            # Conferência / homologação
├── ocorrencias.html            # Ocorrências (férias, licenças…)
├── fechamento.html             # Fechamento mensal + relatório PDF
├── seed-produtividade.html     # Seed de dados para testes
├── firestore.rules             # Regras de segurança Firestore
├── css/
│   └── rmpf.css                # Estilos (IBM Plex Sans, sistema de cores)
├── js/
│   ├── firebase-config.js      # Inicialização Firebase (compat SDK)
│   ├── guard.js                # Proteção de rotas + idle timeout
│   ├── utils.js                # Constantes, TABELA_PONTUACAO, helpers
│   ├── calculo.js              # Fórmula de apuração
│   └── firestore.js            # CRUD Firestore
└── .github/workflows/
    └── mirror.yml              # Mirror para visaanapolis/RMPF
```

## Fórmula de Apuração

```
PP  = soma de todos os pontos aceitos (manuais homologados)
PN  = glosas (pontos negativos)
PV  = max(0, PP − PN)
PV_Limitado = min(PV, 1.000)
Bruto = (PV_Limitado − 250) × 0,2666
Apuração Final = max(0, teto(min(Bruto, 200)))   [em R$]
```

## Configuração Firebase

1. Crie um projeto no [Firebase Console](https://console.firebase.google.com)
2. Ative **Authentication → Google**
3. Ative **Firestore Database**
4. Copie o conteúdo de `firestore.rules` em **Firestore → Rules**
5. Cadastre os usuários em `/usuarios/{email}` com campos:
   - `nome` (string)
   - `grupo` (`"Fiscal"` | `"Administrativo"` | `"Administrador"`)
   - `status` (`"Ativo"` | `"Inativo"`)

## Uso Rápido

1. Abra `seed-produtividade.html` no browser, autentique e clique **Seed Tudo** para popular dados de teste
2. Acesse `index.html` e faça login com uma conta cadastrada
3. Fiscais acessam `lancamento.html` para registrar atividades
4. Administrador acessa `conferencia.html` para homologar e `fechamento.html` para fechar e gerar relatório PDF

## Deploy

O sistema é **puro HTML + JS** — basta servir os arquivos estáticos via qualquer CDN ou servidor web (Firebase Hosting, GitHub Pages, Netlify, etc.).

```bash
# Exemplo com Firebase Hosting
firebase init hosting
firebase deploy
```

## Mirror Automático

O workflow `.github/workflows/mirror.yml` espelha automaticamente o repositório para `visaanapolis/RMPF` a cada push na branch `main`. Configure o secret `MIRROR_SSH_KEY` com a chave SSH de deploy.

## Tabela de Pontuação

| Item | Complexidade | Pontos | Descrição |
|------|-------------|--------|-----------|
| 1 | Alta | 48 | Vistoria ou atendimento a denúncia |
| 2 | Média | 12 | Vistoria ou atendimento a denúncia |
| 3 | Baixa | 6 | Vistoria ou atendimento a denúncia |
| 4 | Alta | 24 | Análise de projeto arquitetônico |
| 5 | Média | 12 | Análise de projeto arquitetônico |
| 6 | — | 48 | Plantão fiscal |
| 7 | — | 12 | Coleta de amostra para laboratório |
| 8 | — | 12 | Manifestação do servidor atuante |
| 9 | — | 24 | Curso, palestra ou evento VISA |
| 10 | Alta | 48 | Relatório técnico de inspeção |
| 11 | Média | 12 | Relatório técnico de inspeção |
| 12 | Baixa | 6 | Relatório técnico de inspeção |
| 13 | Alta | 48 | Relatório técnico harmonizado (SNVS) |
| 14 | — | 48 | Serviços técnicos requisitados pela chefia |
| 15 | — | 48 | Operações fiscais não previstas / extraordinárias |

---

Prefeitura Municipal de Anápolis — VISA / Divisão de Fiscalização
Relatório Mensal de Produtividade Fiscal
