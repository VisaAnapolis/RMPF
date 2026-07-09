# Relatório de custos Google Cloud — projeto `visam-3a30b` (VISA + RMPF)

**Data da análise:** 09/07/2026
**Período analisado:** 1–8 de julho de 2026 (custo faturado: **R$ 6,06**, alta de 77% vs. 23–30/jun)
**Fontes:** console Firebase/GCP (prints), código dos repositórios `garrado/VISA` e `garrado/RMPF`, workflows do GitHub Actions.

---

## 1. Resumo executivo

**Pergunta 1 — "O que está encarecendo o projeto são as leituras?"**
**Sim, no custo recorrente.** O Firestore registrou **182.973 leituras em 24h** (cota gratuita: 50.000/dia — excedida em ~133 mil). Gravações (1.667/20.000) e exclusões (6/20.000) estão folgadas. Porém, no período 1–8/jul o **maior item único da fatura foi Cloud Storage (R$ 3,71)** — um custo **pontual** de carga inicial (detalhe na seção 4). O que cobra todo mês, e tende a crescer, são as leituras.

**Pergunta 2 — "O RMPF é o vilão?"**
**Os dois apps são co-vilões — e o contador é compartilhado.** VISA e RMPF usam o **mesmo projeto Firebase (`visam-3a30b`)**, então os 183 mil/dia somam os dois. O suspeito nº 1 do padrão em "degraus" do gráfico é o **auto-import do RMPF, que roda a cada 10 minutos** em abas de administrador abertas e, quando o gatilho dispara, faz um reimport completo de ~2.000–6.000 leituras por ciclo (potencial de ~144 mil/dia sozinho). O VISA contribui com **leituras de coleções inteiras sem nenhum cache** em todas as páginas mais usadas (dashboard, os.html, aud-*), incluindo até **20.000 leituras por abertura** da aba de estatísticas do admin.

**Custo mensal projetado:** ~**R$ 12–18/mês** no ritmo atual de leituras, com **tendência clara de alta** (as coleções crescem continuamente, então cada full-scan fica mais caro a cada mês). Como a projeção cruza os R$ 20/mês em pouco tempo, este relatório inclui as **sugestões de refatoração** (seção 6) — as duas primeiras devem cortar o excedente quase a zero.

---

## 2. Arquitetura relevante (contexto)

- VISA e RMPF são **sites estáticos (GitHub Pages)** que falam direto com o Firestore via SDK cliente. Não há Cloud Functions nem App Engine real — o SKU "App Engine / Cloud Firestore Read Ops Sao Paulo" na fatura é apenas a forma como o GCP fatura leituras do Firestore Native em `southamerica-east1`.
- Toda automação roda em **GitHub Actions** (crons de geocodificação, notificações, backup, sync de storage).
- **Nenhum dos dois apps usa persistência offline do Firestore** (`persistentLocalCache` / `enablePersistence`): zero ocorrências nos dois repositórios. Todo carregamento de página relê tudo do servidor — cada leitura é cobrada.

---

## 3. Firestore: de onde vêm as ~183 mil leituras/dia

### 3.1 RMPF — suspeito nº 1 (leituras automáticas recorrentes)

| # | Fonte | Onde | Frequência | Leituras estimadas |
|---|-------|------|-----------|--------------------|
| 1 | **Auto-import VISA** | `js/visa-auto-import.js:11,185` → `js/visa-import.js:958,982`; iniciado em `conferencia.html:639` e `parametrizacao.html:588` | a cada **10 min** por aba de admin aberta | ~2 leituras/ciclo se nada mudou; **~2.000–6.000/ciclo quando o SHA de `data/inspecoes.csv` muda** (getDoc por inspeção×fiscal×CNAE + 7 queries de ocorrências) |
| 2 | **Auto-import SIM** | `js/sim-auto-import.js:14,188` → `js/sim-import.js:171,323`; iniciado em `parametrizacao.html:593` | a cada **10 min** por aba de admin aberta | ~3/ciclo se nada mudou; **~1.000–4.000/ciclo quando o watermark `updatedAt` de `ordens_servico` avança** — inclui **full-scan do mês inteiro de `manuais`** para purge de órfãos |
| 3 | **Dashboard admin** | `dashboard.html:637` → `db_getManuaisTodos` (`js/firestore.js:16`) | a cada abertura/clique em Carregar | **~2.000–7.000** (mês inteiro de `manuais`, todos os fiscais) |
| 4 | **Fan-out de ocorrências** | `db_getOcorrencias` (`js/firestore.js:60,93-109`) | load de fechamento, lançamento, meus-lançamentos, ocorrências + dentro dos imports | **7 queries por chamada** (mês atual + 6 meses de lookback) |
| 5 | Guard + FCM | `js/guard.js:38`, `js/firebase-config.js:44,89,533` | toda carga de página autenticada | ~4 |

**Conta que fecha com o gráfico:** uma aba de admin aberta o dia todo em `parametrizacao.html` roda o import a cada 10 min. Se o gatilho (SHA do CSV ou `updatedAt` das OS) avança com frequência — e o VISA commita `data/inspecoes.csv` e edita OS durante o expediente — são até 48 execuções × ~3.000 leituras ≈ **~144 mil leituras/dia**, exatamente a ordem de grandeza observada. O padrão em degraus das 06:00 às 18:00 (horário de Brasília) no gráfico cumulativo é consistente com isso.

### 3.2 VISA — full-collection scans sem cache em toda navegação

| # | Fonte | Onde | Leituras estimadas |
|---|-------|------|--------------------|
| 1 | **os.html** | `os.html:3432-3433` — `ordens_servico` inteira + `contribuintes` inteira (1.565 docs) a cada load | N_ordens + 1.565 por visita |
| 2 | **dashboard.html** | `dashboard.html:1828` — `ordens_servico` inteira; é a landing page e usada como painel de TV | N_ordens por load, várias vezes ao dia |
| 3 | **Páginas aud-\*** | `aud-relatorio.html:280-282`, `aud-ordens.html:480-482`, `aud-contribuintes.html:359-361`, `aud-minhas-os.html:338+` — 3 coleções inteiras por visita | 1.565 + N_ordens + N_usuarios cada |
| 4 | **admin.html (estatísticas)** | `admin.html:1785-1790` — `logs_acesso` + `logs_paginas` com `limit(10000)` cada | **até 20.000 por abertura** |
| 5 | **Busca global** | `js/busca-global.js:153-154` — primeira busca da sessão lê `ordens_servico` + `contribuintes` inteiras | N_ordens + 1.565 |
| 6 | Listeners de atendimento | `atendimento-chamada.html:567`, `atendimento-whatsapp.html:661` — `onSnapshot` filtrado por dia, telas abertas o dia todo | docs do dia + 1 por alteração |
| 7 | Sidebar + guard | `js/sidebar.js:648`, `js/guard1.js:105` — em 36 páginas | ~2 por carga de página |
| 8 | Estatística de atendimento | `atendimento-estatistica.html:339` — `atendimentos` inteira, cresce sem limite | crescente |

Não há N+1 grosseiro no VISA — o problema é **coleção inteira, sem cache, a cada navegação**. Agravante: `logs_acesso`/`logs_paginas` **crescem a cada visita de página** (a sidebar registra presença), então o item 4 tende ao teto de 20.000 permanentemente.

### 3.3 Jobs agendados (não são a causa)

Os crons somam poucos milhares de leituras/dia — irrelevantes perto dos 183 mil:

- **VISA:** `geocode-contribuintes` (05:45, lê os 1.565 contribuintes), `geocode-regulados` (05:30, lê CSV — zero Firestore), `notify-os`/`notify-email-os` (3×/dia útil, leem `usuarios`), `backup-firestore` (domingo, via export gerenciado).
- **RMPF:** `notify-weekly*` (segundas), `notify-monthly*` (dia 1º).
- Service workers: nenhuma leitura em background.

---

## 4. Cloud Storage — R$ 3,71 (Class A Operations, us-central1)

**Causa identificada:** `VISA/.github/workflows/sync-storage.yml` faz `gsutil -m rsync -r -c -d` de `data/{his,reg,pdf,img}` (~1 GB, **~128 mil arquivos**, maioria JSONs minúsculos por registro) para o bucket default `visam-3a30b.firebasestorage.app` — que fica em **us-central1**, não em São Paulo. Cada upload de objeto é uma operação Class A (~US$ 0,05/10 mil ops): ~136 mil operações ≈ R$ 3,71.

**É custo de carga inicial (pontual).** Pushes seguintes só sincronizam o diff (listagem de ~128 chamadas + uploads alterados ≈ centavos). **Nenhuma ação necessária** — apenas evitar re-rodar o sync completo do zero sem necessidade.

---

## 5. Geocoding API — 3.278 requisições/dia (93,66% da cota)

- Todo o consumo vem dos **scripts de GitHub Actions do VISA** (`geocode-lib.js`, `geocode-regulados.js`, `geocode-contribuintes.js`). RMPF não geocodifica nada; nenhuma página cliente chama a API (só leem o `data/geocode_cache.json` estático).
- Os scripts têm **cache por hash de endereço** — cada endereço é geocodificado **uma única vez**. O volume alto é a drenagem do backlog: `regulados` com 26.249 registros (19.539 pendentes) + `contribuintes` (959 pendentes), acelerada pelo workflow manual `geocode-regulados-lote.yml` (até 1.000/execução) somado aos 2 crons diários de 200.
- **Autolimitante:** quando o backlog esvaziar (~2–3 meses no ritmo atual), o uso cai a quase zero.
- **Cuidado com custo:** Geocoding é pago acima da franquia gratuita (~10.000 chamadas/mês; excedente ~US$ 5/1.000). O controle interno `maxMes: 10000` em `data/geocode_usage.json` está exatamente no limite da franquia — **não aumentar esse cap** sem conferir a fatura de Maps Platform.

---

## 6. Projeção de custo mensal e sugestões de refatoração

**Projeção no ritmo atual:** ~133 mil leituras excedentes/dia × preço de `southamerica-east1` ≈ R$ 0,40–0,60/dia ≈ **R$ 12–18/mês**, somado a centavos de Storage/rede. **Tendência de alta:** `ordens_servico`, `atendimentos` e `logs_*` crescem continuamente, e o custo de cada full-scan cresce junto — sem mudanças, o projeto cruza R$ 20/mês nos próximos meses. Por isso, seguem as sugestões, em ordem de impacto:

### Prioridade 1 — RMPF: domar os auto-imports (maior alavanca, corta até ~70% das leituras)

**R1. Mover os imports VISA/SIM do navegador para uma GitHub Action agendada.**
Hoje o import roda a cada 10 min **por aba de admin aberta** (`visa-auto-import.js`, `sim-auto-import.js`). Como Action (ex.: a cada 30–60 min, com Admin SDK), roda **1× por ciclo no total**, independe de abas abertas e ainda elimina execuções concorrentes. Alternativa mínima: aumentar o intervalo de 10 → 60 min e garantir instância única (lock em `app_config`).

**R2. Importar só o delta, não o mês inteiro.**
Quando o gatilho dispara, o reimport reprocessa todas as inspeções/OS do mês com getDoc por item (`visa-import.js:958,982`; `sim-import.js:171`). Guardar no estado do import a última linha/OS processada (ou hash por registro) e reprocessar apenas o que mudou reduz o "storm" de ~3.000 leituras para dezenas.

**R3. Eliminar o full-scan de `manuais` no purge de órfãos do SIM** (`sim-import.js:323`) — filtrar por `origem == 'sim'` + competência em vez de ler o mês inteiro de todos os fiscais; idem para o dashboard admin (`db_getManuaisTodos`), que pode paginar ou agregar com `count()`.

**R4. Reduzir o fan-out 7× de `db_getOcorrencias`** (`firestore.js:60`): um único range query por campo indexado de competência (ex.: `competencia >= 'AAAA-MM'`) em vez de 7 queries mês a mês.

### Prioridade 2 — VISA: cache no cliente (corta o grosso do restante)

**V1. Ativar `persistentLocalCache` (IndexedDB) na inicialização do Firestore** em todas as páginas (mudança de ~3 linhas por página, ou centralizada num módulo de init compartilhado). Recargas e navegações passam a servir do cache local; só docs alterados são lidos do servidor quando combinado com V2.

**V2. Cachear `contribuintes` e `ordens_servico` com watermark.**
Guardar o snapshot em IndexedDB/localStorage com TTL + campo `updatedAt`; a cada visita, buscar apenas `where('updatedAt', '>', ultimaSync)`. Isso elimina o grosso de `os.html`, `dashboard.html`, `aud-*` e `busca-global.js` (hoje: coleções inteiras por visita).

**V3. admin.html (estatísticas):** trocar os dois `limit(10000)` (`admin.html:1785-1790`) por janela de tempo menor + agregações `count()`/`getCountFromServer`, e instituir limpeza/TTL para `logs_acesso`/`logs_paginas` (que crescem a cada visita de página).

**V4. Painel de TV (dashboard):** trocar o reload de coleção inteira por `onSnapshot` com filtro (paga 1 leitura por doc alterado em vez de N_ordens por refresh) ou refresh com o cache de V2.

### Prioridade 3 — Guard-rails (proteção, não economia direta)

- **G1.** Manter o cap de Geocoding em ≤10.000/mês (franquia gratuita); acompanhar `data/geocode_usage.json`.
- **G2.** Manter o orçamento de R$ 50 com alertas (já existe) e conferir a página de uso do Firestore 1×/semana até as correções entrarem.
- **G3.** Para atribuição futura VISA × RMPF, considerar prefixos de coleção por app ou bancos nomeados — hoje é impossível separar as leituras por app no console.

### Impacto estimado do pacote

| Ação | Corte estimado nas leituras/dia |
|------|--------------------------------|
| R1+R2+R3 (auto-imports RMPF) | −100 a −140 mil |
| V1+V2 (cache VISA) | −20 a −40 mil |
| V3 (logs admin) | −10 a −20 mil por abertura da aba |
| **Total** | **volta para dentro da cota gratuita de 50 mil/dia → custo recorrente ≈ R$ 0** |

---

## 7. Como verificar depois das mudanças

1. Console Firebase → Firestore → Uso: leituras/24h devem cair para < 50 mil (dentro da cota gratuita) após R1–R3; observar o gráfico cumulativo — os "degraus" de 10 em 10 minutos devem sumir.
2. Billing → Relatórios → SKU "Cloud Firestore Read Ops Sao Paulo": deve zerar (ou quase) no mês seguinte.
3. Geocoding: quota diária deve voltar a ~400/dia (2 crons de 200) quando o backlog acabar; `geocode_progress.json` com `pendentes: 0`.
