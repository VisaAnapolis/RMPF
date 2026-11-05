# Lançamento 360 — inspeção digitada na fase de transição

> Página `lancamento-360.html` · módulo `js/insp360.js` · motor de cálculo em
> `js/visa-import.js` · regras em `VISA/firestore.rules` (deploy manual).

## 1. Para que serve

O "360" é o sistema transacional que vai substituir o CVS (WCVS/Paradox). Até
ele existir por inteiro, a inspeção que hoje chega ao RMPF pelo `inspecoes.csv`
pode ser **digitada** no Lançamento 360, com o cálculo da produção na hora.

- A página fica disponível a **todo fiscal** (menu "🔄 Lançamento 360"), para ir
  se familiarizando: preenche e vê o cálculo.
- **Só salva** quem está marcado como **Participante da Transição 360** no Admin
  de usuários do VISA (`admin.html` › Editar usuário; campo
  `usuarios.transicao360 = true`; só para o Grupo Fiscal).

## 2. Decisões de negócio

| Tema | Regra |
|---|---|
| Efeito do salvamento | Gera lançamentos de produção em `manuais` (origem `insp360`), que seguem para a Conferência como qualquer outro. |
| CVS × 360 | **Convivem.** Enquanto o CVS estiver em uso, a mesma inspeção pode chegar pelos dois caminhos; o gestor homologa um e recusa o outro. A Conferência marca o par com o selo amarelo **CVS×360** (mesmo fiscal + data + regulado + CNAE; recusado não conta). |
| Modalidade / OS | Um único tipo de OS, sem número: **"TRANSIÇÃO 360"**. Sem nº de OS/Ofício/Protocolo/Denúncia, sem prazo, sem "fora do prazo". Por isso a modalidade "PLANTÃO FISCAL" (que zera a vistoria) não existe no 360. |
| Campos | Só os que entram no cálculo: regulado, data da visita, documento lavrado (TIPO), nº impresso, documento entregue, CNAE informado, CNAEs extras, fiscais. |
| Coautores | Gera um lançamento por CNAE para **cada fiscal da lista que também é 360**. Os demais continuam recebendo pela importação do CVS. A redução de dupla/trio conta **todos** os nomes. |
| 3º fiscal em diante | Entra `pendente` (sem OS, não há autorização prévia a conferir); o administrador autoriza na Conferência, como no CVS. |
| Correção | O fiscal-360 edita/exclui a inspeção até a homologação. Lançamentos `aceito`/`homologado`/`fechado`/`recusado` nunca são alterados nem apagados pelo 360 (a recusa é definitiva, como no CVS); a exclusão da inspeção fica bloqueada se houver algum homologado/fechado/recusado. |
| Prazo de lançamento | O prazo do lançamento manual (`db_validateDeadlineReleaseDate`) não se aplica — como no CVS. Competência fechada bloqueia. |
| Datas | A partir de abril/2026 (mesma regra da importação) e não futura. |
| Validação ao salvar | Tudo o que a chefia confere é obrigatório (`validarInspecao360`, `js/insp360.js`): regulado, data, documento lavrado, documento entregue (sem valor padrão), CNAE da tabela de competência (extras também), fiscais (com o logado, sem repetição). **Nº impresso** obrigatório nos documentos de talão — Termo de Intimação, Termo de Notificação, Auto de Infração, Auto de Imposição de Penalidade e Termo de Coleta de Amostra (0–2% sem nº no CVS em 2026) —, salvo "Documento sem número" marcado (`documento_sem_numero` na inspeção); opcional nos demais. Nº só com dígitos e não zerado. O Salvar fica ativo e lista as pendências, destacando os campos. |
| Salvar grava o que está na tela | `salvar()` recalcula a partir do formulário atual antes de gravar (antes, o último campo alterado antes do clique podia se perder). |

## 3. Cálculo — o mesmo motor da importação

`js/visa-import.js` expõe o motor que a importação do `inspecoes.csv` usa, e o
360 chama exatamente as mesmas funções:

- `montarCnaeMapVisa(texto)` — `cnae.csv` → mapa de competência/complexidade (com override do Decreto 49.723/2023).
- `montarAlvosInspecaoVisa({...})` — CNAEs-alvo: informado + extras de competência, área (alta de alimentação IA/AG: 8/16/48, flag da Parametrização), redução dupla/trio (12→9, 6→3), teto guloso de 48. Documento **não entregue** em vistoria: só o CNAE informado (extras desconsiderados).
- `regraDiaVistoriaVisa({...})` — zeragem por plantão manual/escala (item 9), OPF (item 18), relatório técnico de alta (item 13) e item 4 da alimentação.

Regras do dia: aplicadas na hora **só para o fiscal logado** (ele lê os próprios
lançamentos, ocorrências aceitas e a escala). Os lançamentos dos colegas não
podem ser lidos pelo fiscal; para eles a página mostra o nominal e a
`revalidarCruzadoMes` da importação automática (sessão do admin, a cada ~10 min)
zera/reabre o que conflitar — porque as regras de não cumulatividade passaram a
reconhecer a origem `insp360` (`ehOrigemImportada`):

- `ehVistoriaQualquer` e `ehRelAltaImportada` incluem `insp360`;
- `ehPlantaoManual`, `ehOpfManual` e `ehAtividadeDiaInteiroManual` excluem `insp360`
  (uma "PRORROGAÇÃO" vira PLT com 0 pt e não é plantão manual).

O purge de órfãos da importação só toca em `visa_csv`, e
`db_deleteImportadosMes` só em ids `visa_`/`sim_` — o 360 não é reimportável.

## 4. Modelo de dados

**`insp360/{numero}`** — a inspeção. `numero` = `360-AAAA-NNNNN` (transação em
`insp360_sequencia/{ano}`, campo `ultimo`).

| Campo | Conteúdo |
|---|---|
| `codigo`, `razao`, `municipal` | regulado (municipal só quando a área precisou ser resolvida) |
| `data`, `mes`, `ano` | data da visita (ISO) |
| `documento`, `numero_documento`, `entregue` | documento lavrado |
| `modalidade` | `"TRANSIÇÃO 360"` |
| `cnae`, `cnaes_extras` | CNAEs informados |
| `fiscais` | `[{ nome, email, eh360 }]` na ordem informada |
| `editores` | e-mails dos fiscais-360 (quem pode alterar) |
| `chaves` | `["AAAA-MM|email", …]` — listagem por `array-contains`, sem índice composto |
| `lancamentos` | ids em `manuais` |
| `criado_por/em`, `alterado_por/em` | auditoria |

**`manuais/i360_{numero}_{cnae}_{email}`** — mesmos campos que a importação do
CVS grava (tipo, item, complexidade, pontos, `zerado_motivo`, `dispositivo_legal`,
`visa_cnae`, `cnae_origem`, `codigo`, `razao`, `visa_area`, `qtd_fiscais`,
`fiscais_participantes`…), com `origem: 'insp360'`, `controle` = nº 360,
`insp360_numero`, `insp360_editores`, `motivo_os: 'TRANSIÇÃO 360'`, `os_numero: ''`,
`prazo_os: null`, `fora_do_prazo: false`. **Não** tem `visa_controle`: na
Conferência cada lançamento 360 é decidido sozinho (grupo de um).

## 5. Regras do Firestore (VISA/firestore.rules — DEPLOY MANUAL)

- `is360()` = usuário ativo com `transicao360 == true`.
- `manuais`: o fiscal-360 lê, cria, atualiza e apaga lançamentos `insp360` em que
  consta em `insp360_editores`, só com status `enviado`/`pendente` e sem
  `pontos_homologado`. Homologar continua exclusivo da chefia.
- `insp360`: leitura por qualquer ativo (a listagem filtra por `chaves`); gravação
  pelo fiscal-360 que consta em `editores` (não pode se retirar da lista); admin
  altera/exclui.
- `insp360_sequencia`: escrita só por `is360()`.

Sem a publicação manual no Console ▸ Firestore ▸ Rules, o salvamento falha com
"permission denied".

## 6. Telas afetadas

- `lancamento-360.html` (nova) — formulário, cálculo ao vivo, "Minhas inspeções 360" com editar/excluir.
- `meus-lancamentos.html`, `dashboard.html` — selo **360** (somente leitura, link "Editar no 360").
- `conferencia.html` — selo **360** e alerta **CVS×360**.
- Menus do perfil Fiscal em todas as páginas.
- `VISA/admin.html` — checkbox "🔄 Participante da Transição 360" e selo na lista de usuários.

## 7. Testes

`tests/insp360-calculo.test.js` — a mesma inspeção calculada pela importação do
CVS e pelo 360 sai igual campo a campo (média, baixa, dupla, trio, extras sob o
teto, alta ocupando o teto, área 80/150 m², não-VIS, não entregue, CNAE sem
competência); regras do dia do fiscal logado; gravação/edição/travas/exclusão;
origens nas regras de não cumulatividade; duplicidade CVS×360.
`tests/visa-import-snapshot.test.js` continua garantindo que a importação não
mudou com a extração do motor.
