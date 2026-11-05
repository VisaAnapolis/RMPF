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
| Datas | Data da visita a partir de **03/11/2026** (início da Transição 360; outubro/2026 já fechado — `DATA_INICIO_360`, `js/insp360.js`) e não futura. |
| Validação ao salvar | Tudo o que a chefia confere é obrigatório (`validarInspecao360`, `js/insp360.js`): regulado, data, documento lavrado, **nº do documento em todo documento** (qualquer formato — a numeração do 360 não é a do talão do CVS; basta haver um nº), documento entregue (sem valor padrão), CNAE da tabela de competência (extras também), fiscais (com o logado, sem repetição). O Salvar fica ativo e lista as pendências, destacando os campos. |
| Salvar grava o que está na tela | `salvar()` recalcula a partir do formulário atual antes de gravar (antes, o último campo alterado antes do clique podia se perder). |

## 3. Cálculo — o mesmo motor da importação

`js/visa-import.js` expõe o motor que a importação do `inspecoes.csv` usa, e o
360 chama exatamente as mesmas funções:

- `montarCnaeMapVisa(texto)` — `cnae.csv` → mapa de competência/complexidade (com override do Decreto 49.723/2023).
- `montarAlvosInspecaoVisa({...})` — CNAEs-alvo: informado + extras de competência, área (alta de alimentação IA/AG: 8/16/48, flag da Parametrização), redução dupla/trio (12→9, 6→3), teto guloso de 48. Documento **não entregue** em vistoria: só o CNAE informado (extras desconsiderados).
- `regraDiaVistoriaVisa({...})` — zeragem por plantão manual/escala (item 9), OPF (item 18), relatório técnico de alta (item 13) e item 4 da alimentação.

### 3.1 Não cumulatividade — igual ao CSV

As inspeções acumulam entre si. Plantão (item 9, inclusive pela escala da
gerência), operação fiscal (item 18) e relatório técnico de alta (item 13) não
acumulam com vistoria no mesmo dia. Vale nos dois sentidos, exatamente como para
o que vem do `inspecoes.csv`, porque as regras reconhecem a origem `insp360`
(`ehOrigemImportada`):

- `ehVistoriaQualquer` e `ehRelAltaImportada` incluem `insp360`;
- `ehPlantaoManual`, `ehOpfManual` e `ehAtividadeDiaInteiroManual` excluem `insp360`
  (uma "PRORROGAÇÃO" vira PLT com 0 pt e não é plantão manual).

| Sentido | Comportamento |
|---|---|
| Lançar plantão/OPF depois (`lancamento.html`, edição em `meus-lancamentos.html`) | Plantão bloqueado em dia com vistoria 360 que pontua; OPF bloqueada em dia com qualquer vistoria 360; serviço técnico (SRV) permitido — mesmas mensagens do CSV, citando "CVS, SIM ou Lançamento 360". |
| Lançar a inspeção no 360 depois — **fiscal logado** | A página lê os próprios lançamentos, ocorrências aceitas e escala: vistoria zerada (com `zerado_motivo` e ⚠️) ou não lançada em dia de ocorrência. |
| Lançar a inspeção no 360 depois — **colegas 360** | O fiscal não lê lançamentos, ocorrências (licenças médicas) nem escala dos colegas: o lançamento nasce com a pontuação nominal e a **revalidação do mês** (sessão de administrador) aplica as regras do dia. |

**Revalidação disparada pelo 360.** Todo salvamento/exclusão no 360 grava
`insp360_sequencia/rev` (`{ em, por }`). A importação automática
(`js/visa-auto-import.js`, Conferência/Parametrização abertas por administrador,
~10 min) compara com `app_config/import_state.insp360_rev`: CSVs sem mudança e 360
mudou → roda só `revalidarMesVISA` (mesmo lock, sem reimportar). A importação
completa também carimba a marca. No painel de execuções aparece como `revalida_360`.

**Casos próprios do 360 em `revalidarCruzadoMes`** (o caminho do CSV não muda):
- dia coberto por ocorrência aceita → lançamento 360 **não homologado é excluído**
  (o CSV nem o criaria); homologado é reaberto, como no CSV;
- conflito que deixou de existir → vistoria 360 não homologada **volta a pontuar**
  (`pontos_nominal`, `dispositivo_legal_nominal`, gravados no salvamento) — o CSV
  faz isso sozinho ao ser reimportado.

**Pontuação discricionária do gerente.** Na Conferência, o lançamento 360 tem
*Pts Homologados* livre, como os importados: o conflito só avisa. A revalidação age
sobre `pontos` (o calculado), nunca sobre `pontos_homologado`; homologado em
conflito é reaberto uma vez (com `pontos` zerado) e, se o gerente homologar de novo
com pontos, a decisão permanece.

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
