# Documentação do RMPF — índice e arquitetura

> Atualizado em 05/11/2026 (app RMPF v1.42.0). Ponto de partida da
> documentação técnica. Regras de negócio numeradas:
> **[RN-RMPF-REGRAS-NEGOCIO-v1.0.md](RN-RMPF-REGRAS-NEGOCIO-v1.0.md)**.

---

## 1. O que é o sistema

**RMPF — Relatório Mensal de Produtividade Fiscal** da Vigilância Sanitária de
Anápolis. Calcula, por fiscal e por mês, a pontuação de produtividade prevista
no **Decreto Municipal 49.723/2023 (Anexo VII)** e na **LC 548/2023**, desde a
digitação/importação da atividade até a homologação pela gerência e o
fechamento da competência.

- Site estático (HTML + JS, sem build) com PWA, servido no GitHub Pages.
- Dados no **Firestore** do projeto Firebase `visam-3a30b`, o mesmo do app
  **VISA** (coleção `usuarios` compartilhada).
- As **regras de segurança do Firestore** dos dois apps ficam em
  `VISA/firestore.rules` e são publicadas **à mão** no Console.

## 2. Publicação

```
garrado/RMPF (main) ──mirror.yml (git push --mirror, chave SSH)──► VisaAnapolis/RMPF
                                                                   └─ pages-corporativo.yml publica
                                                                      https://visaanapolis.github.io/RMPF/
```

O `pages-corporativo.yml` roda **no repositório corporativo** com o
`GITHUB_TOKEN` do próprio GitHub — não depende mais de PAT (o antigo
`MIRROR_PAT` expirou em ago/2026 e congelou o site; corrigido na v1.36.0).
Anexos (PDF/imagem) vão para o Firebase Storage; o CORS do bucket está em
`cors.json` (instrução no `README.md` da raiz).

## 3. De onde vêm os pontos

| Porta de entrada | Origem (`manuais.origem`) | Quem dispara |
|---|---|---|
| Importação das inspeções do WCVS (CSVs de `garrado/VISA`, privado, via API do GitHub) | `visa_csv` | automática em sessão de Administrador (~10 min, só se os CSVs mudaram) — `js/visa-auto-import.js` |
| Importação das auditorias do SIM (`ordens_servico`) | `sim_csv` | automática em sessão de Administrador — `js/sim-auto-import.js` |
| Lançamento 360 (inspeção digitada na transição) | `insp360` | fiscal participante da Transição 360 — `lancamento-360.html` |
| Lançamento manual (PLT, CUR, SRV, OPF) | (sem origem) | fiscal — `lancamento.html` |
| Ocorrências aceitas (afastamentos) e férias sincronizadas | `ocorrencia` | Administrador / `js/ferias-auto-sync.js` |

O motor de pontuação de inspeção (`montarCnaeMapVisa`,
`montarAlvosInspecaoVisa`, `regraDiaVistoriaVisa`, em `js/visa-import.js`) é
**o mesmo** para a importação e para o 360.

## 4. Mapa das páginas

| Página | Função | Perfil |
|---|---|---|
| `index.html` | Login | todos |
| `dashboard.html` | Painel: PP, PN, PV, apuração, pendências e avisos | todos (Administrativo: só apresentação) |
| `lancamento.html` | Lançar atividade manual | Fiscal |
| `lancamento-360.html` | Lançamento 360 + "Minhas inspeções 360" | Fiscal (salvar: `transicao360`) |
| `meus-lancamentos.html` | Lançamentos do fiscal, alertas, corrigir e reenviar | Fiscal |
| `ocorrencias.html` | Registrar / aceitar afastamentos | Fiscal registra; Administrador decide |
| `conferencia.html` | Homologação por documento | Administrador |
| `fechamento.html` | Fechamento e reabertura, relatório em PDF | Administrador |
| `admin.html` | Usuários, versão, modo de acesso | Administrador |
| `parametrizacao.html` | Competência aberta, flags, token do GitHub, importações em lote e simulação, índices, push, custos de leitura | Administrador |
| `changelog.html` | Histórico de versões | Fiscal e Administrador |
| `corrige-plantao.html`, `corrige-certidoes.html` | Correções pontuais de jun/2026 (histórico, acesso só pela URL) | Administrador |
| `simula-ferias.html`, `migra-email.html`, `seed-produtividade.html` | Utilitários de manutenção/teste | Administrador |

## 5. Coleções do Firestore usadas

| Coleção | Conteúdo |
|---|---|
| `usuarios` | cadastro compartilhado com o VISA (perfil, ativo, `rmpf_fcmTokens`, `transicao360`…) |
| `manuais` | **todos** os lançamentos (manuais, importados, 360, ocorrências) |
| `ocorrencias` | afastamentos do fiscal |
| `fechamentos` | um registro por fiscal × competência fechada (PN, observação) |
| `insp360`, `insp360_sequencia` | Lançamento 360 e sua numeração/marca de revisão |
| `app_config` | parâmetros (ver RN, seção 13) |
| `visa_import_locks`, `sim_import_locks`, `ferias_sync_locks` | travas das rotinas automáticas |
| `plantao`, `ferias` (leitura) | escalas mantidas no VISA |
| `ordens_servico` (leitura) | auditorias do SIM |
| `cnae_complexidade` | **inerte** (substituída pelo `cnae.csv`); não é lida nem apagada |

**Índices compostos** (`firestore.indexes.json`, criados pelo workflow
`deploy-firestore-indexes.yml`, botão em Parametrização):
`manuais` (fiscal_email, mes, ano, status) · (fiscal_email, mes, ano) · (mes, ano) · (fiscal_email, status);
`ocorrencias` (fiscal_email, mes, ano) · (mes, ano);
`fechamentos` (fiscal_email, ano ↓, mes ↓) · (mes, ano);
`ordens_servico` (fiscalEmail, dataCumprimento).

## 6. Automação (GitHub Actions)

| Workflow | Disparo |
|---|---|
| `mirror.yml` / `pages-corporativo.yml` | todo push em `main` |
| `notify-fiscal.yml`, `notify-fiscal-email.yml` | `repository_dispatch` enviado pelo app a cada evento (recusa, devolução, reabertura, alteração após recusa) |
| `notify-recusas.yml` | manual: repescagem de recusas que ficaram sem aviso (`dry_run` por padrão) |
| `notify-weekly*.yml`, `notify-monthly*.yml` | **manuais** (o agendamento foi retirado na v1.31.0) |
| `notify-teste-push.yml` | teste de push por e-mail (manual ou botão da Parametrização) |
| `deploy-firestore-indexes.yml` | manual / botão |
| `backfill-ocorrencia-pontos.yml`, `backfill-visa-fields.yml` | manuais, com `dry_run` |

## 7. Testes

`npm test` (`node --test tests/*.test.js`):
- `visa-import-snapshot.test.js` — a importação com snapshot produz o mesmo banco e relatório que a versão anterior (homologado alterado, recusado, órfão, fiscal removido, CNAE reclassificado, plantão, mês fechado);
- `insp360-calculo.test.js` — motor de cálculo do 360;
- `ferias-auto-sync.test.js` — sincronização de férias.

## 8. Índice dos documentos de `docs/`

- [RN-RMPF-REGRAS-NEGOCIO-v1.0.md](RN-RMPF-REGRAS-NEGOCIO-v1.0.md) — regras de negócio numeradas (documento central).
- [lancamento-360.md](lancamento-360.md) — Lançamento 360: decisões, cálculo, modelo de dados e regras do Firestore.
- `Manual_do_App_de_Produtividade.pdf` — manual do usuário em PDF (imagens; não foi revisado nesta atualização).
- `brasao2.jpg` — brasão usado no PDF do fechamento (**não remover**: `fechamento.html` o referencia).
- `padrão.pdf` — modelo de documento do WCVS (Termo de Notificação) usado como referência visual.

## 9. Documentos removidos nesta revisão (nov/2026)

Continuam no histórico do git.

| Documento | Motivo |
|---|---|
| `integracao-visa-rmpf.md` | Plano de abr/2026 com partes superadas (id sem CNAE, botões de importação removidos na v1.13.0, teto de 24 pts/dia abolido na v1.14.x); as regras vigentes estão na RN |
| `validacao-escala-plantao.md` | Plano implementado na v1.16.1; regras na RN (seção 4) |
| `firestore-indices.md` | Listava 7 índices e passos manuais; hoje são 9, criados pelo workflow (seção 5 acima) |
| `plano-melhoria-1-importacao-visa.md` | Implementado na v1.41.0 |
| `mirror-sem-pat.md` | Implementado na v1.36.0 (`pages-corporativo.yml`) |
| `relatorio-custos-google-cloud-2026-07.md` | Retrato de jul/2026, anterior às otimizações da importação |
