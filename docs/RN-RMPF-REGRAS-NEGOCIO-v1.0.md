# DOC — Regras de Negócio do RMPF
## Relatório Mensal de Produtividade Fiscal — app RMPF v1.42
### Regras de negócio recriadas a partir do código em produção · Versão 1.0 · Novembro/2026

---

## CONTROLE DO DOCUMENTO

| Atributo | Valor |
|----------|-------|
| Identificador | RN-RMPF-REGRAS-NEGOCIO-v1.0 |
| Base | Código do app RMPF **v1.42.0** (05/11/2026), `changelog.html`, testes de `tests/` |
| Substitui | `integracao-visa-rmpf.md`, `validacao-escala-plantao.md`, `firestore-indices.md`, `plano-melhoria-1-importacao-visa.md`, `mirror-sem-pat.md` (removidos; continuam no histórico do git) |
| Companheiros | `docs/README.md` (arquitetura e índice) · `docs/lancamento-360.md` (detalhe do Lançamento 360) · VISA: `docs/DOC-WCVS-REGRAS-NEGOCIO-v2.0.md` |
| Base legal | **Decreto Municipal 49.723/2023, Anexo VII** (tabela de pontuação e não cumulatividade) · **LC 548/2023, art. 11** (afastamentos que mantêm a produtividade) · LC 377/2018 (complexidade das atividades, refletida no `cnae.csv` do VISA) |

### Como ler

Cada regra tem identificador `RN-<domínio>-NNN` e classificação:
**[C]** confirmada no código (arquivo/função citados); **[I]** inferida, a validar com a gerência.
Todas as regras deste documento são **[C]**, salvo indicação.

> **Escopo.** O RMPF calcula a produtividade mensal de cada fiscal. Os pontos
> vêm de três portas: **importação** do WCVS (inspeções do `inspecoes.csv`) e do
> SIM (auditorias de contribuintes), **Lançamento 360** (inspeção digitada na fase
> de transição) e **lançamento manual** do fiscal. Tudo passa pela **Conferência**
> (homologação) e termina no **Fechamento** da competência.

---

## 1. PERFIS E ACESSO (RN-ACE)

**RN-ACE-001** Login Google (Firebase Auth) + cadastro ativo em `usuarios` (a mesma coleção do VISA). Sem cadastro ou com `ativo === false`, a sessão é encerrada. *Evidência: `js/guard.js`.*

**RN-ACE-002** Perfis (`perfil`): **Fiscal** (lança e acompanha a própria produção), **Administrador** (conferência, ocorrências, fechamento, parametrização) e **Administrativo** (só o painel, em visão de apresentação; sem Fechamento, Conferência, Ocorrências e Changelog). *Evidência: páginas (`perfil === 'Administrador'`…); changelog v1.3.0.*

**RN-ACE-003** Inatividade: **30 min** em computador marcado como compartilhado (sai também da conta Google); **8 h** nos demais aparelhos. *Evidência: `js/guard.js` (`IDLE_MS`).*

**RN-ACE-004** O salvamento no **Lançamento 360** exige a marcação **"Participante da Transição 360"** (`usuarios.transicao360`, feita no Admin do VISA). Sem ela a página só calcula. *Evidência: `lancamento-360.html`, `js/insp360.js`.*

---

## 2. TABELA DE PONTUAÇÃO (RN-PTS)

**RN-PTS-001** Tipos de atividade e itens (Anexo VII). "Só importação" = não pode ser lançado à mão. *Evidência: `js/utils.js` (`TIPOS_ATIVIDADE`, `TABELA_PONTUACAO`, `_ITEM_PONTUACAO_TO_DECRETO`).*

| Tipo | Item interno → Anexo VII | Pontos | Entrada |
|---|---|---|---|
| VIS — Vistoria ou atendimento a denúncia | 1 / 2 / 3 → itens 1 / 2 / 3 | Alta 48 · Média 12 · Baixa 6 | só importação / 360 |
| ARQ — Análise de projeto arquitetônico | 4 / 5 → itens 7 / 8 | Alta 24 · Média 12 | só importação |
| PLT — Plantão fiscal | 6 → item 9 | 48 | manual |
| COL — Coleta de amostra | 7 → item 10 | 12 | só importação |
| MAN — Manifestação do servidor autuante | 8 → item 11 | 12 | só importação |
| CUR — Curso, palestra, evento | 9 → item 12 | 24 | manual |
| REL — Relatório técnico de inspeção | 10 / 11 / 12 → itens 13 / 14 / 15 | Alta 48 · Média 12 · Baixa 6 | só importação |
| RLH — Relatório técnico harmonizado (SNVS) | 13 → item 16 | 48 | só importação |
| SRV — Serviços técnicos requisitados pela chefia | 14 → item 17 | 48 | manual |
| OPF — Operação fiscal extraordinária | 15 → item 18 | 48 | manual |
| CER — Certidão | 16 → item 19 | 2 | só importação |

**RN-PTS-002** **Complexidade** = a do `cnae.csv` do VISA (fonte única, lido a cada importação), **salvo as exceções do Decreto (item C)**: média para 4639-7/02, 3831-9/01, 3831-9/99, 3832-7/00, 3839-4/99 (C.1); baixa para 8630-5/03 (C.2). O lançamento reclassificado mostra ⚖️ "origem → atual". CNAE **informado** que não consta no `cnae.csv` pontua como **média** (padrão, 12 pts); CNAE **extra** sem competência no `cnae.csv` é ignorado com aviso. *Evidência: `js/utils.js` (`EXCECOES_COMPLEXIDADE_DECRETO`), `js/visa-import.js` (`montarCnaeMapVisa`).*

**RN-PTS-003** **Alta de alimentação por área** (equipes IA/AG): ≤ 100 m² → 8 pts (item 6); > 100 e < 400 → 16 (item 5); ≥ 400 ou sem área → 48 (item 4). A área sai de CODIGO → `regulados.csv` (inscrição) → `taxa.csv` (observação "Área"). Liga/desliga em Parametrização (`app_config/visa_area_alimentacao`, ligado por padrão). *Evidência: `js/visa-import.js` (`pontosPorAreaVisa`, `parseTaxaArea`).*

**RN-PTS-004** **Redução por dupla/trio (item E.2)**: em vistoria com **2 ou mais fiscais**, média cai de 12 para **9** e baixa de 6 para **3**, para cada fiscal. Alta (inclusive 8/16/48 por área) **não** reduz. *Evidência: `js/visa-import.js` (`pontosReduzidosDuplaVisa`).*

**RN-PTS-005** **CNAEs da vistoria e teto de 48**: entram o CNAE informado e os CNAEs extras marcados pelo fiscal no WCVS (`inspecoes_cnae.csv`). Cada CNAE vira um lançamento; seleciona-se por **maior pontuação primeiro** (empate: o informado), somando enquanto **≤ 48**; o que não cabe não é lançado. A redução E.2 e a área são aplicadas antes do teto. Vistoria com documento **não entregue** (coluna `entrega` falsa) e os demais tipos geram **um único lançamento**, pelo CNAE informado e pelos pontos do tipo — sem extras, sem área e sem redução E.2. *Evidência: `js/visa-import.js` (`montarAlvosInspecaoVisa`).*

**RN-PTS-006** Tipo do documento do WCVS → tipo RMPF: Manifestação do Fiscal Autuante/Atuante → MAN; Termo de Coleta → COL; Relatório Técnico → REL (por complexidade); Análise de PAS → ARQ; Relatório Harmonizado → RLH; Certidão → CER; **Prorrogação → PLT com 0 pt**; qualquer outro → VIS. *Evidência: `js/visa-import.js` (`resolverTipoVisa`).*

**RN-PTS-007** Inspeção cuja origem da demanda é **"PLANTÃO FISCAL"** entra com **0 pt** (já contemplada no plantão, item 9). *Evidência: `js/visa-import.js`.*

**RN-PTS-008** **CNAE 9999-9/99** (enquadramento de alta complexidade indicado pelo fiscal) pontua como alta, mas mostra **alerta azul** para a gerência conferir o enquadramento. Exibição controlada em Parametrização (`app_config/cnae_alta_alerta`). *Evidência: `js/utils.js` (`cnaeAltaIndicada`).*

**RN-PTS-009** **Fiscais de 30 h**: fator **40/30** sobre a pontuação por atividade, aplicado na homologação (pré-preenche "Pts Homologados"). Lista fixa no código (`FISCAIS_30H`); liga/desliga em Parametrização (`app_config/fiscais_30h`, **desligado por padrão**). **Não** se aplica ao rateio de ocorrências. *Evidência: `js/utils.js` (`pontosComFator30h`), `js/firestore.js`.*

**RN-PTS-010** Todo lançamento grava o **dispositivo legal** que embasa — ou, quando zerado, o item que **rejeita** — a pontuação. *Evidência: `js/utils.js` (`dispositivoLegal`).*

---

## 3. NÃO CUMULATIVIDADE NO MESMO DIA (RN-NCU)

Regras **por fiscal**. "Inspeção" = origem `visa_csv`, `sim_csv` ou `insp360`.

**RN-NCU-001** **Plantão × vistoria (item 9)**: Plantão Fiscal manual na data **zera** as vistorias do dia; o mesmo vale se o fiscal está **escalado pela gerência** para plantão na data (escala do VISA), mesmo sem plantão lançado. *Evidência: `js/visa-import.js` (`regraDiaVistoriaVisa`), `js/sim-import.js`.*

**RN-NCU-002** **Operação fiscal × vistoria (item 18)**: OPF manual na data zera as vistorias do dia. *Evidência: idem.*

**RN-NCU-003** **Relatório técnico de alta × vistoria (item 13)**: o REL de alta mantém os pontos e a vistoria do dia é zerada. *Evidência: idem (`relAltaDatas`).*

**RN-NCU-004** **Atividades de dia inteiro entre si**: PLT, OPF e SRV (48 pts) não convivem no mesmo dia — a segunda é **bloqueada**. Vale só entre lançamentos **manuais**. *Evidência: `js/visa-import.js` (`TIPOS_DIA_INTEIRO_MANUAL`), `lancamento.html`.*

**RN-NCU-005** Bloqueios na entrada manual: Plantão em data com inspeção **que pontua**; OPF em data com **qualquer** inspeção. Inspeção zerada não bloqueia plantão. *Evidência: `lancamento.html`, `meus-lancamentos.html`.*

**RN-NCU-006** Toda zeragem grava `zerado_motivo`, exibido em ⚠️ clicável ao fiscal e ao administrador. *Evidência: `js/utils.js` (`zeradoWarningHtml`).*

**RN-NCU-007** Lançamento já homologado **não é zerado** em silêncio: a conferência revalida e, havendo conflito, o administrador decide; conflito entre manual e importado depois da homologação **reabre os dois**. *Evidência: `js/visa-import.js` (`revalidarCruzadoMes`), `conferencia.html`.*

---

## 4. ESCALA DE PLANTÃO DO VISA (RN-ESC)

**RN-ESC-001** Plantão Fiscal manual só é aceito se o fiscal está na **escala do dia** (`plantao/AAAA-MM`, casamento por nome normalizado). *Evidência: `js/plantao-escala.js`, `lancamento.html`.*

**RN-ESC-002** **Fail-open**: mês sem escala publicada ou falha de leitura **não bloqueia** nem zera nada. *Evidência: `js/plantao-escala.js`.*

**RN-ESC-003** Na homologação, conflito com a escala **avisa** o administrador, que decide caso a caso (não bloqueia). *Evidência: `conferencia.html`.*

---

## 5. IMPORTAÇÃO DO WCVS (RN-IMP)

**RN-IMP-001** Fonte: CSVs do repositório **privado** `garrado/VISA`, lidos pela API do GitHub com o token salvo em `app_config/github_token`: `inspecoes.csv`, `inspecoes_cnae.csv`, `inspecoes_fiscais.csv`, `cnae.csv`, `regulados.csv`, `taxa.csv`, `requerimento.csv`, `oficio.csv`, `denuncia.csv`, `tramitacao.csv`, `feriados.csv`. *Evidência: `js/firestore.js` (`fetchGitHubCSV`), `js/visa-import.js`.*

**RN-IMP-002** **Automática**, em sessão de Administrador (Conferência/Parametrização abertas), a cada ~10 min, só quando os CSVs mudam (SHA do último commit, `app_config/import_state`); protegida por **lock distribuído** com *heartbeat*. Importação manual e **simulação** (só leitura, relatório de divergências) ficam em Parametrização. *Evidência: `js/visa-auto-import.js`.*

**RN-IMP-003** Período mínimo: **abril/2026**. Só a **competência aberta**; competência fechada é intocável. *Evidência: `js/visa-import.js` (`VISA_IMPORT_INICIO_*`, `visaMesAberto`).*

**RN-IMP-004** **Um lançamento por fiscal e por CNAE**: id `visa_{CONTROLE}_{CNAE}_{email}`. O nome do fiscal do CSV casa com `usuarios` por nome normalizado (sem acento, maiúsculas, espaços colapsados). *Evidência: `js/firestore.js` (`db_visaDocId`), `js/visa-import.js` (`normNomeVisa`).*

**RN-IMP-005** **Lançamentos importados são somente leitura para o fiscal** (selo CVS): não edita, não exclui, não muda status. *Evidência: `meus-lancamentos.html`.*

**RN-IMP-006** **Reimportação** (o WCVS é a fonte da verdade da competência aberta):
- não existe → cria como `enviado`;
- não homologado e não recusado → **sobrescreve** com o dado atual;
- **recusado** → **nunca** é sobrescrito; se a origem mudou depois da recusa, grava só a marca `recusa_alterado_diff` (ícone **vermelho**), avisa fiscal e administradores por push e e-mail, e a marca some se a alteração for desfeita;
- **homologado** → comparado nos **13 campos de identidade/pontuação** (data, tipo, item, complexidade, CNAE, pontos, área, nº de fiscais, documento, regulado, origem da demanda, nº da OS, origem do CNAE); igual → intacto; diferente → **volta à conferência** com selo **Reaberto** (🔄) e push agregado ao fiscal;
- campos **informativos** (nº impresso do documento, lista de participantes) acompanham sempre a origem, sem reabrir nada.
*Evidência: `js/visa-import.js` (`VISA_CAMPOS_ORIGEM`, `visaDiffOrigem`, `VISA_CAMPOS_INFORMATIVOS`).*

**RN-IMP-007** **Sumiu do CSV** (órfão): não homologado → excluído; homologado → **zerado e visível**, aguardando o administrador, com o motivo certo: *inspeção alterada/excluída na origem*, *fiscal removido da inspeção* (reincluir no WCVS devolve a pontuação) ou *CNAE reclassificado* — neste caso a homologação **migra** para o lançamento do CNAE atual (🔁) e a linha antiga sai. *Evidência: `js/visa-import.js` (`_motivoFiscalRemovido`, `_motivoCnaeMigrado`).*

**RN-IMP-008** **Fonte incompleta**: se `cnae.csv`, `inspecoes_cnae.csv` ou `inspecoes_fiscais.csv` falharem, a rodada importa mas **não reabre nem zera** homologados e não troca a lista de participantes. *Evidência: `js/visa-import.js` (`fontesIncompletas`, `fiscaisIncompletos`).*

**RN-IMP-009** **Mais de dois fiscais exige autorização prévia**: o 3º fiscal e seguintes só entram como `enviado` se a OS é requerimento com `prioridade = true` ou ofício com `terceiro = true`; senão entram **pendentes** até o administrador autorizar. *Evidência: `js/visa-import.js` (`isTerceiroFiscalAutorizado`).*

**RN-IMP-010** **Dia coberto por ocorrência aceita** → a inspeção não é importada para aquele fiscal. *Evidência: `js/visa-import.js`, `js/sim-import.js`.*

**RN-IMP-011** **Prazo da OS × data da visita**: grava `prazo_os` e `fora_do_prazo`. Requerimento, ofício e denúncia usam o `Prazo` do CSV; protocolo = encaminhamento ao fiscal + 15 dias úteis. Prazo em fim de semana/feriado **prorroga** para o próximo dia útil (art. 224, §1º, CPC, por analogia). O alerta ⚠️ é **informativo** (não muda pontos) e some após o fechamento. *Evidência: `js/utils.js` (`prazoEfetivo`, `cumpridoForaDoPrazo`).*

**RN-IMP-012** Descrição gerada: `Vistoria VISA — OS {nº} — CNAE {código} — {descrição}`; controle `VISA-{CONTROLE}`. *Evidência: `js/visa-import.js`.*

---

## 6. IMPORTAÇÃO DO SIM — AUDITORIAS (RN-SIM)

**RN-SIM-001** Fonte: coleção `ordens_servico` (Firestore), OS com `statusOs` "Concluída" e `dataCumprimento` no mês; fiscal pelo `fiscalEmail` da OS (só perfil Fiscal). *Evidência: `js/sim-import.js`.*

**RN-SIM-002** Toda auditoria é **vistoria de alta complexidade (48 pts)**. *Evidência: `js/sim-import.js`.*

**RN-SIM-003** Mesmas regras de não cumulatividade, ocorrência, competência fechada, recusa definitiva (comparando `data`, `pontos`, `item_pontuacao`, `prazo_os`) e órfãos da importação do WCVS; fora do prazo = `dataCumprimento` > `prazo` prorrogado. *Evidência: `js/sim-import.js` (`SIM_CAMPOS_ORIGEM`).*

**RN-SIM-004** Automática (sessão de Administrador, ~10 min), com detecção de mudança por *watermark* de 1 leitura (maior `updatedAt`). *Evidência: `js/sim-auto-import.js`.*

---

## 7. LANÇAMENTO 360 (RN-360) — detalhe em `docs/lancamento-360.md`

**RN-360-001** Inspeção digitada no RMPF na fase de transição, com **o mesmo motor de cálculo** da importação. Grava `insp360/360-AAAA-NNNNN` e um lançamento por CNAE para cada fiscal da equipe marcado como 360 (origem `insp360`). *Evidência: `js/insp360.js`, `js/visa-import.js`.*

**RN-360-002** Modalidade fixa **TRANSIÇÃO 360**, sem OS e sem prazo; data da visita **a partir de 03/11/2026** e não futura; tudo o que a chefia confere é obrigatório, inclusive o **nº do documento**. *Evidência: `js/insp360.js` (`DATA_INICIO_360`, `validarInspecao360`).*

**RN-360-003** CVS e 360 **convivem**: a mesma inspeção pelos dois caminhos recebe o alerta **CVS×360** na Conferência e o gestor homologa um e recusa o outro. *Evidência: `js/utils.js` (`idsDuplicidade360`).*

**RN-360-004** O fiscal edita/exclui até a homologação; homologado, fechado e recusado nunca mudam. O prazo do lançamento manual não se aplica; 3º fiscal em diante entra pendente. *Evidência: `js/insp360.js`.*

---

## 8. LANÇAMENTO MANUAL (RN-MAN)

**RN-MAN-001** O fiscal lança só os tipos **PLT, CUR, SRV e OPF**; os demais são exclusivos da importação. *Evidência: `lancamento.html` (`somenteCsv`).*

**RN-MAN-002** **Prazo de lançamento**: a data da atividade não pode ter mais de **N dias** em relação a hoje (padrão **7**; configurável e desligável em Parametrização, `app_config/fiscal_deadline`). *Evidência: `js/firestore.js` (`db_validateDeadlineReleaseDate`).*

**RN-MAN-003** Bloqueado em **competência fechada** — inclusive quando um mês posterior já foi fechado. *Evidência: `lancamento.html`.*

**RN-MAN-004** Bloqueado em **dia coberto por ocorrência aceita**, sem exceção de pontos (o antigo teto de 24 pts/dia foi abolido). *Evidência: `lancamento.html`; changelog v1.14.4.*

**RN-MAN-005** Pode ser salvo como **rascunho** ou **enviado**; anexo opcional (PDF ou imagem). Recusado volta ao fiscal para **corrigir e reenviar**. *Evidência: `lancamento.html`, `meus-lancamentos.html`.*

---

## 9. OCORRÊNCIAS — AFASTAMENTOS (RN-OCR)

**RN-OCR-001** Tipos = hipóteses do **art. 11 da LC 548/2023**: casamento (II), luto (III), júri (IV), licença para tratamento da própria saúde (V), doença em pessoa da família (VI), gestante (VII), paternidade (VIII), adoção (IX), cargo em comissão (X). **Férias (I)** e **licença-prêmio anterior à LC 548** não são digitadas: vêm da escala de férias do VISA. *Evidência: `js/utils.js` (`TIPOS_OCORRENCIA`).*

**RN-OCR-002** O fiscal registra (status `pendente`) e pode excluir a própria ocorrência enquanto não decidida; o **Administrador aceita ou recusa**. Licenças de saúde (V e VI) só são aceitas após **perícia médica comprovada no Resoluto** (aviso na tela). *Evidência: `ocorrencias.html`.*

**RN-OCR-003** Aceite gera um lançamento por **dia útil** com **1000 ÷ dias úteis do mês** (2 casas), com a memória do cálculo na descrição; **sem fator 30 h**. Fins de semana e feriados do período não recebem lançamento. *Evidência: `js/utils.js` (`taxaDiariaOcorrencia`), `js/firestore.js` (`aceitarOcorrencia`).*

**RN-OCR-004** O aceite é bloqueado se houver **qualquer** lançamento em algum dia do período; ocorrências não podem ter datas sobrepostas. *Evidência: `ocorrencias.html`; changelog v1.14.5.*

**RN-OCR-005** **Sincronização de férias** (sessão de Administrador, *watermark* `ferias/escala.updatedAt` + lock): cria, **aceita automaticamente** e remove as ocorrências `ferias_visa` da competência aberta; se o dia já tem lançamento, a ocorrência fica pendente e é reportada. Nunca altera lançamentos manuais. *Evidência: `js/ferias-auto-sync.js`.*

**RN-OCR-006** Dia útil: exclui sábado, domingo, feriados nacionais fixos, móveis (Carnaval seg/ter, Sexta-feira Santa, Corpus Christi, pela Páscoa) e municipais (`data/feriados.csv`). *Evidência: `js/utils.js` (`ehDiaUtil`).*

---

## 10. CONFERÊNCIA / HOMOLOGAÇÃO (RN-CNF)

**RN-CNF-001** Ciclo de status: `rascunho` → `enviado` → (`pendente` se falta autorização de fiscal) → **`aceito`** ou **`recusado`** → `fechado` (no fechamento). `homologado` é o status dos lançamentos de ocorrência. *Evidência: `js/utils.js` (`badge`), `conferencia.html`.*

**RN-CNF-002** **A homologação é do documento**: aceitar, recusar ou devolver alcança todos os lançamentos do mesmo `visa_controle` (todos os fiscais e CNAEs). O modal mostra antes o alcance (quem recebe quanto). Não se aceita um CNAE e recusa outro do mesmo documento. Lançamentos sem controle (manual, SIM) são grupo de um. *Evidência: `conferencia.html`, `js/firestore.js` (`db_getManuaisPorVisaControle`).*

**RN-CNF-003** **Replicação proporcional**: o administrador decide quanto do valor padrão homologa; a mesma proporção vale para cada participante sobre a base dele (respeita fator 30 h e zeragens). *Evidência: `js/utils.js` (`pontosHomologadosReplicados`).*

**RN-CNF-004** Ficam **fora** da decisão do documento: competência fechada de um participante, fiscal **removido** da inspeção (campo de pontos travado em zero) e quem não tem lançamento (ocorrência, sem cadastro) — tudo listado como ressalva. *Evidência: `conferencia.html` (v1.39.1–v1.39.4).*

**RN-CNF-005** Aceitar documento com 3º fiscal pendente **autoriza** e homologa todos juntos (confirmação explícita). *Evidência: `conferencia.html`.*

**RN-CNF-006** **Rever** decisão: "↩ Pendente" devolve à fila (zera homologado, apaga motivo, avisa o fiscal); "Aceitar" só grava se os pontos mudarem (notifica "Lançamento Sobrescrito"). *Evidência: `conferencia.html` (v1.33.0).*

**RN-CNF-007** **A recusa é definitiva**: só o gestor a reverte, pelo "Rever". O motivo da recusa aparece ao fiscal (banner e modal), que recebe push e e-mail; a recusa vai também ao WCVS por `data/rmpf_recusas.csv` (VISA). *Evidência: `conferencia.html`, `js/notifications.js`; `VISA/.github/scripts/exportar-recusas-rmpf.js`.*

---

## 11. APURAÇÃO E FECHAMENTO (RN-APU)

**RN-APU-001** **Fórmula** (`js/calculo.js`):
- **PP** = soma dos pontos dos lançamentos `aceito`/`fechado`/`homologado` (usa `pontos_homologado` quando existe);
- **PN** = glosas informadas no fechamento;
- **PV** = máx(0, PP − PN), limitado a **1000** (teto);
- **Apuração (%)** = ⌈ mín( (PV − 250) × 0,2666 ; **200** ) ⌉, nunca negativa.

**RN-APU-002** **Fechamento** (Administrador, por fiscal ou em lote): os aceitos viram `fechado`, o registro fica em `fechamentos` (com PN e observação) e o PDF do relatório sai com o brasão do município. *Evidência: `fechamento.html`.*

**RN-APU-003** **Reabertura** só se nenhum mês **posterior** estiver fechado; os `fechado` voltam a `aceito`. *Evidência: `fechamento.html`.*

**RN-APU-004** A **competência aberta** é definida em Parametrização (`app_config/competencia_aberta`) e delimita importações, sincronização de férias e exportação de recusas. *Evidência: `js/firestore.js`.*

---

## 12. NOTIFICAÇÕES (RN-NOT)

**RN-NOT-001** Push (FCM) e e-mail por **evento**: recusa, devolução à análise, sobrescrita, reabertura (agregada por fiscal) e alteração no WCVS depois da recusa. *Evidência: `js/notifications.js` (dispara `notify-fiscal.yml` e `notify-fiscal-email.yml`); repescagem manual de recusas sem aviso em `notify-recusas.yml` (`.github/scripts/notify_recusas.py`).*

**RN-NOT-002** Resumos semanal e mensal são **só por disparo manual** (Actions ou botão do admin). Os tokens do RMPF ficam em `rmpf_fcmTokens` (separados dos do VISA), no máximo 5 por usuário; token morto é podado. *Evidência: workflows `notify-*.yml`; changelog v1.31.0 e v1.37.0.*

---

## 13. PARÂMETROS (Parametrização → `app_config`)

| Documento | Efeito | Padrão |
|---|---|---|
| `competencia_aberta` | competência em trabalho | — |
| `fiscal_deadline` | prazo do lançamento manual (dias) | 7, ativo |
| `fiscais_30h` | fator 40/30 na homologação | desligado |
| `visa_area_alimentacao` | pontuação por área (alimentos alta) | ligado |
| `cnae_alta_alerta` | alerta azul do CNAE 9999-9/99 | ligado |
| `github_token` | leitura dos CSVs do VISA privado | — |
| `import_state` | SHA/watermarks das importações automáticas | — |
| `notif_config` | convite e lembrete de push | — |

---

## 14. PONTOS A VALIDAR COM A GERÊNCIA [I]

- A média `MEDIA_PRODUTIVIDADE_OCORRENCIA = 1000` é marcada no código como *placeholder* "até existir média real do fiscal": confirmar se o afastamento deve render o teto ou a média histórica.
- As listas de fiscais de 30 h e de contas com regra liberada vivem no código; avaliar levá-las ao cadastro.

---

*Documento recriado em 05/11/2026 a partir do código do RMPF v1.42.0.*
