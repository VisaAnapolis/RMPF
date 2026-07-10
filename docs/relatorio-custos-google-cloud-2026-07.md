# Relatório de custos Google Cloud — projeto `visam-3a30b` (VISA + RMPF) — v2

**Data da análise:** 10/07/2026 (v2 — revisão com leitura direta do código de importação e medição dos gatilhos reais)
**Períodos analisados:** últimos 30 dias (09/06–09/07: **4.438.735 leituras**) e período de faturamento 1–10/jul (**1.435.286 leituras**, custo R$ 6,06 até dia 8)
**Fontes:** console Firebase/GCP (prints), leitura linha a linha de `RMPF/js/visa-auto-import.js`, `visa-import.js`, `sim-auto-import.js`, `sim-import.js`, `firestore.js`, histórico de commits do `garrado/VISA` via API do GitHub e diff real entre versões do `data/inspecoes.csv`.

> **Nota de correção (v2):** a v1 deste relatório afirmava que os auto-imports do RMPF podiam gerar "até ~144 mil leituras/dia" reimportando a cada 10 minutos. **Essa estimativa estava exagerada.** A leitura direta do código confirma que o ciclo de 10 minutos custa apenas 2–3 leituras quando nada mudou; o import pesado só roda quando o CSV é de fato commitado (medido: ~7×/dia útil) ou quando alguma OS é editada. As seções 3 e 6 foram reescritas com os números corrigidos.

---

## 1. Resumo executivo

- **Média real: ~148 mil leituras/dia nos últimos 30 dias** (cota gratuita: 50 mil/dia). Excedente médio ≈ 98 mil/dia ≈ ~2,9 milhões de leituras faturáveis/mês ≈ **R$ 10–16/mês**, com tendência de alta (o custo por execução de import cresce ao longo do mês e o volume de dados cresce mês a mês).
- **O padrão é de atividade humana, não de robôs**: dias úteis 150–290 mil; fins de semana ~45–55 mil; pico de ~590 mil em 30/jun (fechamento de competência).
- **Os auto-imports do RMPF funcionam como projetados** (gate barato, import só quando há mudança). O problema não é a frequência do polling — é que **cada execução reprocessa o mês inteiro** (~1.500–3.500 leituras), quando tipicamente só ~12 linhas do CSV mudaram entre um sync e outro.
- Os demais vilões da v1 permanecem: **páginas do VISA sem nenhum cache** (coleções inteiras a cada navegação, até 20 mil leituras por abertura da aba de estatísticas do admin) e ausência de `persistentLocalCache` nos dois apps.

---

## 2. Como o import do RMPF realmente funciona (lógica verificada)

Esta seção responde à dúvida central: *"ele realmente lê a coleção inteira e realiza leituras a cada 10 minutos?"* — **Não a cada 10 minutos; e "a coleção inteira" só em um ponto específico (purge de órfãos).**

### 2.1 O polling de 10 minutos é barato

Os dois auto-imports rodam em sessão de **Administrador** (import CVS: `conferencia.html:639` e `parametrizacao.html:588`; import SIM/Auditoria: **somente** `parametrizacao.html:593`), 1× no carregamento e a cada 10 min enquanto a aba estiver aberta. Cada ciclo:

| Passo | Import CVS (`visa-auto-import.js:106-141`) | Import SIM (`sim-auto-import.js:107-141`) |
|---|---|---|
| Competência aberta | 1 leitura (`app_config/competencia_aberta`) | 1 leitura |
| Detector de mudança | SHA do último commit de `data/inspecoes.csv` via **API do GitHub — 0 leituras Firestore** | maior `updatedAt` de `ordens_servico` (`orderBy desc limit 1`) — **1 leitura** (`firestore.js:556`) |
| Estado salvo | 1 leitura (`app_config/import_state`) | 1 leitura |
| **Total se nada mudou** | **~2 leituras** | **~3 leituras** |

Uma aba de admin aberta 10h/dia gera ~60 ciclos ≈ **120–180 leituras/dia de polling** — irrelevante. A intuição do usuário estava correta: as leituras pesadas dependem de haver atualização no CSV / na coleção de auditoria.

### 2.2 Frequência real dos gatilhos (medida, não estimada)

- **CSV (`inspecoes.csv`):** o "VISAM Server" (git do Windows) commita **~7×/dia útil** (~08h, 10h, 12h, 14h, 16h, 18h + ~01:20) e **1×/dia (01:20) aos fins de semana** — confirmado no histórico de commits de jun–jul/2026. Logo o import CVS pesado roda **~7×/dia útil**, não 48×.
- **Auditoria (`ordens_servico`):** o watermark avança quando **qualquer OS é criada/editada** no módulo AUDITORIA do VISA (`aud-os.html:659,721,740,847`, `aud-ordens.html:539`). Em dia útil isso acontece o dia todo — mas o import SIM só dispara se houver uma aba de **parametrizacao.html** aberta. Frequência real = janelas de 10 min com aba aberta E alguma OS editada: **0 a ~30 execuções/dia**, dependendo do hábito do admin.

### 2.3 O que uma execução pesada lê (aqui está o custo)

**Import CVS** (`visa-import.js:448-1230`) — o CSV inteiro vem do GitHub (0 Firestore); o filtro pega só as linhas do mês aberto (julho: **282 linhas** hoje, medido; cresce até o fim do mês). Para cada linha × fiscal reconhecido:
- 1 `getDoc` do registro legado + 1 `getDoc` por CNAE-alvo (IDs determinísticos `visa_{controle}_{cnae}_{email}` — `firestore.js:387-397`, `visa-import.js:958,982`). Não é scan de coleção, mas soma ~1.000 leituras com a expansão por CNAE.
- Na 1ª vez de cada fiscal no mês: `db_getManuais` (lançamentos do fiscal no mês) + **7 queries de ocorrências** (mês + 6 de lookback, `firestore.js:60,96`) + escala de plantão — ~1.200 leituras para ~30 fiscais.
- **Purge de órfãos: `db_getManuaisTodos(mes, ano)` (`visa-import.js:1203`) — este sim lê o mês INTEIRO de `manuais` de todos os fiscais** (~1.000–1.500 docs) para achar lançamentos removidos do CSV.
- **Total: ~3.000–3.500 leituras/execução** em meados do mês → ~7×/dia ≈ **~22–25 mil leituras/dia**.

**Import SIM** (`sim-import.js:95-350`): query das OS concluídas do mês (range em `dataCumprimento`) + 1 `getDoc` por OS (`:171`) + caches por fiscal + **o mesmo purge com scan do mês inteiro (`:323`)** ≈ **1.500–2.500 leituras/execução**. Com 10–30 execuções/dia ≈ **15–75 mil leituras/dia** — potencialmente o maior contribuinte isolado, com incerteza sobre quantas execuções de fato ocorrem (ver seção 5, "como confirmar").

O restante da lógica está correto e bem protegido: locks distribuídos transacionais com timeout de 3 min e heartbeat (`firestore.js:427-464,507-534`), preservação de homologados, regras de não-cumulatividade (Plantão/OPF/REL-alta), teto de 48 pontos por inspeção na expansão por CNAE.

### 2.4 O desperdício estrutural

Entre dois syncs consecutivos do CSV, o diff real mostrou **~12 linhas alteradas** (novas inspeções, correção de `DT_VISITA` de 08.07→06.07, `Us_altera` preenchido) — mudanças em **posições arbitrárias** do arquivo, não nas últimas linhas. Mas o import reprocessa **as 282 linhas do mês inteiro** e ainda varre o mês de `manuais` no purge. Ou seja: **~97% das leituras de cada execução são para reprocessar o que não mudou.** É aqui que está a economia, não no intervalo do polling.

---

## 3. Análise dos últimos 30 dias

- **4.438.735 leituras** (09/06–09/07) = média **~148 mil/dia**, ~3× a cota gratuita.
- **Dias úteis:** 150–290 mil. **Fins de semana:** ~45–55 mil (4–5/jul) — atividade cai ~75%, confirmando que o grosso acompanha expediente/abas abertas.
- **Pico ~590 mil em 30/jun:** dia de fechamento de competência — conferência aberta o dia todo (imports + dashboard admin com scans de mês cheio, quando cada execução está no custo máximo).
- **Pendência a investigar:** o baseline de fim de semana (~45–55 mil) sozinho já beira a cota gratuita. O sync de 01:20 + 1 import (~3 mil) não explica; hipótese principal: abas/painéis deixados abertos no fim de semana (dashboard-TV do VISA relendo `ordens_servico` inteira a cada abertura, telas de atendimento com `onSnapshot`) + navegação avulsa. Vale observar num sábado o gráfico horário do console.
- **Projeção de custo:** excedente ~2,9 mi/mês ≈ **R$ 10–16/mês** hoje; cresce com o volume de `manuais`/`ordens_servico`/`logs_*`. Sem mudanças, cruza R$ 20/mês em poucos meses — as sugestões da seção 6 seguem justificadas.

---

## 4. Storage e Geocoding (sem mudanças da v1)

- **Cloud Storage R$ 3,71 (Class A, us-central1):** carga inicial única do `sync-storage.yml` (~128 mil arquivos para o bucket default). Recorrente desprezível. Nenhuma ação.
- **Geocoding (93% da cota diária):** drenagem legítima do backlog de 26 mil regulados pelos scripts de Actions do VISA, com cache por endereço (cada um geocodificado 1×). Autolimitante (~2–3 meses). Manter o cap `maxMes: 10000` (limite da franquia gratuita).

---

## 5. Como confirmar a atribuição antes de refatorar

1. **Contar execuções reais dos imports:** gravar um histórico leve em `app_config/import_state` (array `runs` com timestamp + contadores criados/atualizados/ignorados por execução, mantendo os últimos ~50). Custo: 1 write por execução. Em 2–3 dias sabemos exatamente quantas execuções CVS/SIM ocorrem e o que cada uma fez.
2. **Observar um sábado** no gráfico horário do console (leituras por hora) para caracterizar o baseline de fim de semana.
3. Comparar dias com conferência/parametrização abertas vs. fechadas (perguntar aos admins ou olhar `logs_paginas` do VISA).

---

## 6. Sugestões revisadas (em ordem de impacto)

### R1. Mover os imports para uma GitHub Action agendada *(continua válida, motivo revisado)*
Não pelo "excesso de polling" (que é barato), mas porque: roda 1× por ciclo no total (em vez de 1× por aba de admin aberta), elimina locks concorrentes, funciona sem ninguém logado, e permite alinhar o agendamento à cadência real do CSV (7 syncs/dia → rodar ~15 min depois de cada horário de sync, ou a cada 2h em horário comercial).

### R2 (nova). Import CVS por **diff de versões do CSV** — a correção do ponto levantado pelo usuário
A v1 sugeria "importar só o delta", o que seria errado se implementado como "olhar as últimas linhas" — registros antigos mudam de status/data/fiscal em qualquer posição do arquivo. A forma correta, que cobre esses casos:

1. O estado salvo já guarda o SHA da última importação (`import_state.visa.commit_sha`). Baixar do GitHub **as duas versões** do CSV (a do SHA salvo e a atual) — 0 leituras Firestore.
2. Indexar as duas por chave **CONTROLE** e comparar linha a linha (hash/comparação de campos): produz os conjuntos **adicionados**, **alterados** (qualquer campo: `DT_VISITA`, fiscais, tipo, `Us_altera`…) e **removidos**.
3. Processar **apenas** esses CONTROLEs com a lógica atual (getDocs determinísticos, regras de não-cumulatividade etc.).
4. **Removidos saem do próprio diff** → excluir direto pelos IDs determinísticos (`_visaDocId`), **eliminando o scan `db_getManuaisTodos` do purge** em cada execução. Manter uma reconciliação completa (lógica atual) 1×/semana ou por botão manual, como rede de segurança.
5. Fallback: se a versão anterior não puder ser baixada (SHA antigo, arquivo renomeado), rodar o import completo atual.

Efeito: execução típica cai de ~3.000–3.500 para **~100–300 leituras** (~12 linhas × expansão + caches dos fiscais afetados). Economia de ~20 mil leituras/dia.

*Cuidado de implementação:* mudanças em arquivos auxiliares (`cnae.csv`, `cae.csv`, `requerimento.csv`…) também alteram o resultado sem mudar o `inspecoes.csv` — incluir os SHAs desses arquivos no estado salvo e, quando um deles mudar, rodar o import completo.

### R3 (nova). Import SIM por **delta de `updatedAt`**
Trocar a query "todas as OS concluídas do mês" por `where('updatedAt', '>', watermarkSalvo)` (filtrando mês/status no cliente, como já faz): lê **só as OS alteradas** desde a última execução. OS que *saíram* do status concluída também aparecem no delta (a edição bumpa `updatedAt`), permitindo remover o lançamento correspondente sem o scan de órfãos — de novo, reconciliação completa semanal como segurança. Efeito: execução típica cai de ~1.500–2.500 para **~20–100 leituras**, e o custo de rodar com frequência deixa de importar.

### R4. Eliminar `db_getManuaisTodos` das execuções rotineiras
Consequência direta de R2+R3 (purge via diff/delta). Também vale para o dashboard admin do RMPF (`dashboard.html:637`), que lê o mês inteiro de `manuais` de todos os fiscais a cada abertura — paginar por fiscal ou usar agregações `count()` onde só se exibem totais.

### V1–V4 (VISA — mantidas da v1)
- **V1.** Ativar `persistentLocalCache` (IndexedDB) na inicialização do Firestore de todas as páginas dos dois apps.
- **V2.** Cachear `contribuintes`/`ordens_servico` com watermark `updatedAt` no cliente (os.html, dashboard, aud-*, busca-global leem coleções inteiras a cada navegação).
- **V3.** admin.html: trocar os dois `limit(10000)` de `logs_acesso`/`logs_paginas` (`admin.html:1785-1790`) por janela menor + `count()`; TTL/limpeza dessas coleções.
- **V4.** Reduzir o fan-out 7× de `db_getOcorrencias` (`firestore.js:60,96`) para 1 range query por campo de competência indexado.

### Impacto estimado do pacote revisado

| Ação | Corte estimado (leituras/dia útil) |
|---|---|
| R2 (diff CSV) | −20 mil |
| R3 (delta SIM) | −15 a −70 mil (conforme frequência real) |
| V1+V2 (cache VISA) | −30 a −60 mil |
| V3 (logs admin) | −10 a −20 mil por abertura |
| **Resultado** | **de ~150–290 mil para dentro/perto da cota de 50 mil/dia → custo recorrente ≈ R$ 0** |

---

## 7. Verificação pós-mudanças

1. Console Firestore → Uso: dias úteis abaixo de ~60 mil; o degrau pós-sync do CSV (visível ~10h20, 12h20…) deve encolher ~10×.
2. `import_state.runs` (se implementado o item 5.1): execuções com dezenas de leituras, não milhares.
3. Billing → SKU "Cloud Firestore Read Ops Sao Paulo" ≈ 0 no mês seguinte.
