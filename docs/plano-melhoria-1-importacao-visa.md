# Plano — Melhoria 1: importação do VISA lê os lançamentos do mês uma vez só

**Situação:** implementado na v1.41.0 (04/11/2026), após o fechamento de outubro/2026, numa versão **mais conservadora** que a descrita abaixo — ver a seção 7.
**Data da análise:** 02/11/2026.

## 1. Contexto e números medidos

- Painel *Custo & Leituras* (VISA `admin.html`): cada rodada "CVS (inspeções)" lê **~9.000–9.300 documentos** e leva **190–828 s**, mesmo quando o resultado é mínimo (ex.: 02/11 11:55 — 2 criados, 14 atualizados, 9.323 leituras, 286 s).
- Causa: `importarInspecoesVISA` (`js/visa-import.js:875`) lê os **mesmos** lançamentos (`manuais`) do mês 3–4 vezes por rodada:
  - 1 getDoc do registro legado + 1 getDoc por CNAE, para cada linha × fiscal (`visa-import.js:1574`, `:1605`);
  - `db_getManuais` por fiscal no cache de pontos (`:45`);
  - `db_getManuaisTodos` no purge de órfãos (`:1981`);
  - `db_getManuaisTodos` de novo na revalidação cruzada (`:739`).
- Custo real (console Google Cloud): projeto **R$ 5,91** em out/2026; 2.648.507 leituras em 30 dias; leituras ≈ **R$ 5–11/mês**.
- Ganho estimado da melhoria:
  - leituras por rodada: ~9.300 → ~3.000;
  - economia: ~650 mil leituras/mês ≈ **R$ 1,50–2/mês** (pouco);
  - **desempenho (ganho principal):** rodada de 3–14 min → ~1–2 min (estimativa — as ~2.300 leituras por linha são feitas uma após a outra);
  - lock ativo por menos tempo; menor janela com o mês "meio atualizado".
- **Regra inegociável:** a conferência é por documento — cada linha do `inspecoes.csv` continua atualizando **todos os fiscais** dela. Nenhuma regra de pontuação, homologação, reabertura ou exclusão muda. (Importar "só um fiscal" foi descartado por gerar inconsistência entre fiscais do mesmo documento.)

## 2. Mudanças propostas (`js/visa-import.js`)

1. **Snapshot no início** (após o lock): uma consulta `db_getManuaisTodos(mes, ano)` → `Map<id, doc>`, com índices por `fiscal_email` e por `fiscal::controle`. Se a consulta falhar, a rodada segue pelo caminho atual (sem snapshot).
2. **`escrever` (`:898`) mantém o snapshot coerente** — é o ponto único de gravação:
   - upsert → insere/mescla (id via `_visaDocId`, a expor de `js/firestore.js` como `window.db_visaDocId`);
   - update → mescla o patch;
   - remover → apaga do snapshot.
   Vale também na simulação. (Verificado: nenhum `FieldValue` em `visa-import.js` — os patches são valores simples, fáceis de mesclar na memória.)
3. **Laço das linhas:** procura no snapshot pelo id determinístico; se ausente, `db_getVISAManual` (inspeção nova ou de outro mês — mesmo comportamento de hoje). Registro legado: só faz o getDoc quando não houver nenhum lançamento daquele `fiscal::controle` no snapshot.
4. **Releitura antes de gravar** (proteção contra homologação feita na Conferência durante a rodada): antes de cada upsert/update/remover/reabertura — no laço, no purge e na revalidação — reler o documento; se `status`/`updated_at` diferirem do snapshot, refazer a decisão com o documento fresco (ou pular e registrar aviso). Mantém a janela de concorrência igual à de hoje.
5. **`_getEstadoPontosVisa` (`:42`):** filtra o snapshot por fiscal em vez de chamar `db_getManuais` (ocorrências e escala continuam como estão).
6. **Purge de órfãos (`:1979`) e `revalidarCruzadoMes` (`:737`):** usam o snapshot já atualizado pelas gravações da rodada, sem nova consulta.
7. **Diagnóstico:** mensagem final com acertos/faltas do snapshot e número de releituras.

## 3. Medição (`parametrizacao.html`)

8. Importação manual (`:2172`) e Simulação (`:2225`): medir `rmReadsSession()` + duração, gravar em `registrarImportStateVisa` (campos `leituras`/`dur_s`) e mostrar na tela "Leituras desta execução: X — N s". Hoje só a importação automática mede.

## 4. Riscos

| Risco | Efeito se ocorrer | Chance | Proteção |
|---|---|---|---|
| Sobrescrever homologação feita durante a rodada | Homologado volta a "enviado" | Baixa | Item 4 (releitura antes de gravar) + teste manual |
| Snapshot desatualizado após gravações da própria rodada | Purge apaga/reabre indevidamente | Baixa | Item 2 (`escrever` atualiza o snapshot) |
| Registro legado (pré-jul/2026) não encontrado | Inspeção antiga contada em dobro | Muito baixa | Item 3 (getDoc quando não há doc no snapshot) |
| Falha da consulta inicial | Rodada sem dados | Baixa | Volta ao caminho atual |

## 5. Validação (critério para ir ao ar)

- **Simulação comparativa:** mesma competência, mesmo `inspecoes.csv`, versão atual × nova → o `relatorio` (criar/atualizar/reabrir/excluir/sincronizar/migrar) deve sair **idêntico item a item**; leituras e duração menores.
- **Teste manual de concorrência:** homologar um lançamento na Conferência durante uma importação real de novembro → a homologação deve permanecer.
- Rodar a suíte de `tests/`.

## 6. Implantação

- **Somente após o fechamento de outubro**; primeira rodada real na competência de novembro (poucos lançamentos).
- Lançamentos `fechado` são intocáveis nas duas versões (`visa-import.js:1984`, `:1904`).
- Rollback: reverter o commit.
- Fora do escopo (pode vir depois): mesmo padrão em `js/sim-import.js` (`:89`, `:408`) e no dashboard do administrador (`dashboard.html:700`).

## 7. Implementação (v1.41.0 — 04/11/2026)

Desenho final, mais conservador que a seção 2 — **a memória só pode concluir "não há nada a fazer"**:

- **Snapshot** do mês lido uma vez no início (`db_getManuaisTodos`); falha → caminho antigo.
- **Linhas do CSV:** só lançamento `aceito`/`homologado`/`fechado` vem da memória. Homologado sem nenhuma diferença (origem e informativos) → `ignorados++`, sem leitura — exatamente o que o código já fazia, sem gravar. Qualquer diferença → o lançamento é **relido do banco** e decidido pelo código de sempre (reabre se alterado na origem). Enviado, pendente, recusado ou ausente → lido do banco como antes.
- **Estado de pontos por fiscal:** filtrado do snapshot em vez de `db_getManuais` por fiscal.
- **Legado:** a leitura do id sem CNAE é pulada só quando o fiscal já tem lançamento por CNAE daquela inspeção no mês e o id legado não está entre eles.
- **Purge:** continua lendo o mês do banco (dado fresco). A **revalidação cruzada** recebe essa leitura com as gravações do purge espelhadas, em vez de reler o mês. Na simulação, recebe a lista sem espelhamento (= o que a releitura traria).
- **Gravações** invalidam a entrada no snapshot (`escrever`).
- Diferença aceita: plantão/OPF manual lançado **durante** a rodada é tratado pela revalidação do fim da própria rodada (motivo "conflito"), não no laço das linhas.

Teste `tests/visa-import-snapshot.test.js`: versão anterior (commit `7da00da`) × nova sobre o mesmo banco e CSVs → banco final, relatório e contadores **idênticos**, inclusive em simulação; concorrência (homologar/recusar no meio da rodada) e falha do snapshot. Uma mutação proposital ("decidir tudo pela memória") faz o teste de concorrência falhar, confirmando que ele detecta o risco.
