# Validação da Escala de Plantão (VISA) no RMPF — Plano

> **Documento de planejamento** para as validações que amarram os lançamentos de
> Plantão fiscal (PLT) e a zeragem de vistorias importadas à **escala de plantão
> gerenciada no site VISA** (`plantao.html`). Motivo da validação: **forçar o
> cumprimento da escala** definida pela gerência.

---

## 1. Contexto técnico (o que viabiliza a integração)

| Item | Situação |
|---|---|
| Projeto Firebase | RMPF e VISA usam o **mesmo projeto** (`visam-3a30b`) — o RMPF lê a escala diretamente, sem API intermediária |
| Coleção da escala | `plantao/{AAAA-MM}` (1 documento por mês) |
| Permissão de leitura | `firestore.rules` do projeto: `match /plantao/{mesId} { allow read: if isAuth(); }` — qualquer usuário autenticado do RMPF já pode ler |
| Escrita | Somente Master (gerência), via `plantao.html` do VISA |
| Histórico disponível | Escala migrada desde **Jan/2026** |

### Estrutura do documento `plantao/{AAAA-MM}`

```json
{
  "mes": "2026-07",
  "criadoEm": "<timestamp>", "criadoPor": "email",
  "ultimaAlteracao": "<timestamp>",
  "dias": [
    {
      "date": "2026-07-01", "dow": 3,
      "matutino":   "NOME COMPLETO DO FISCAL 30H MAT",
      "vespertino": "NOME COMPLETO DO FISCAL 30H VESP",
      "integral":   ["NOME FISCAL 40H", "NOME FISCAL 40H"],
      "obs": "", "feriado": false,
      "regrasQuebradas": [], "auditoria": { "alteradoPor": "...", "alteradoEm": "..." }
    }
  ]
}
```

**Pontos de atenção:**

- Os fiscais são identificados por **nome completo** (mesma coleção `usuarios`
  usada pelo RMPF), não por e-mail → o match usa a normalização já existente
  `normNomeVisa` (remove acentos, uppercase, colapsa espaços), o mesmo pipeline
  nome→email da importação VISA.
- O documento reflete o **estado atual** da escala; o campo `auditoria` guarda
  apenas a última alteração (não há histórico). "Está ou estava escalado" =
  estado atual do doc na data. Se a gerência corrigir a escala retroativamente,
  as validações passam a enxergar a correção.
- Sábados, domingos e feriados **não recebem escala** no VISA (`isDiaSemPlantao`
  bloqueia). Consequência: PLT manual em fim de semana/feriado ficará bloqueado
  por "não escalado" — comportamento desejado, pois a escala é a fonte da verdade.
- Não há validação de **turno** (matutino/vespertino/integral) × horário da
  atividade: estar em qualquer turno do dia conta como "escalado na data".

---

## 2. Comportamento atual confirmado (zeragem na importação)

Resposta ao questionamento sobre o que o sistema faz hoje ao zerar vistorias
importadas em data com plantão manual já lançado:

Na importação **VISA** (`js/visa-import.js:950-959`) e **SIM**
(`js/sim-import.js:169-179`), toda vistoria (`VIS`) com pontos > 0 em data que
possui PLT manual do mesmo fiscal entra/atualiza com:

| Campo gravado na coleção `manuais` | Valor |
|---|---|
| `pontos` | `0` |
| `zerado_motivo` | `"Plantão fiscal manual em DD/MM/AAAA — não cumulativo com vistoria (Anexo VII, item 9)."` |
| `dispositivo_legal` | `"Item 9 do Anexo VII do Decreto 49.723/2023 (não cumulativo — pontuação zerada)"` |

✅ **Sim — o dispositivo legal que impede a acumulação É salvo na coleção**, via
`dispositivoLegal(item, pontos, dupla, itemDecretoOverride=9)` em
`js/utils.js:171-175`, além do `zerado_motivo` (exibido com ⚠️/tooltip em
`meus-lancamentos.html` e `conferencia.html`). O log da importação registra
*"vistoria zerada — plantão fiscal manual em DD/MM"*.

Complementos do fluxo atual:

- Vistorias já homologadas (`aceito`/`fechado`) **não** são zeradas — a
  homologação em `conferencia.html` revalida via
  `motivoNaoCumulatividadeVistoria` e bloqueia aceitar pontos > 0 em conflito.
- Vistoria cuja origem da demanda (Modalidade) é "PLANTÃO FISCAL" já entra
  zerada com dispositivo do item 9, porém **sem** `zerado_motivo`.
- O caminho inverso é bloqueado: PLT manual não pode ser lançado em data que já
  tem vistorias importadas com pontos > 0 (`lancamento.html:347` e edição em
  `meus-lancamentos.html` via `bloqueioPlantaoComVistoria`).

---

## 3. Decisões alinhadas com o gestor (03/07/2026)

1. **Importação × escala:** estar **escalado** na data já zera as vistorias
   importadas do dia, **mesmo sem PLT manual lançado**, com mensagem própria.
2. **Fail-open:** se o doc `plantao/AAAA-MM` não existir (mês sem escala
   publicada) ou houver erro de leitura → **permite** o lançamento/importação
   normal. Bloqueia/zera somente com escala existente.
3. **Abrangência do bloqueio de PLT fora da escala:** `lancamento.html`
   (digitação), `meus-lancamentos.html` (editar/mover data) **e**
   `conferencia.html` (revalidação na homologação).
4. **Vigência prospectiva:** nada de correção retroativa automática; casos
   antigos são tratados pelo admin na conferência.

---

## 4. Implementação

### 4.1. Novo módulo compartilhado — `js/plantao-escala.js`

Funções expostas em `window` (padrão dos demais módulos):

- `db_getEscalaMes(mesKey)` — lê `plantao/{AAAA-MM}` com **cache em memória por
  mês** (Map). Retorna o doc ou `null` (inexistente). Erro de rede → lança/retorna
  marcador de erro (para o fail-open do chamador).
- `escaladosNoDia(escalaDoc, dataISO)` — retorna `Set` de nomes normalizados
  (`normNomeVisa`) presentes em `matutino`, `vespertino` e `integral[]` do dia.
- `fiscalEscaladoNoDia(nomeFiscal, dataISO)` — resultado:
  - `{ status: 'escalado', turno }` — nome consta na data;
  - `{ status: 'nao_escalado' }` — escala do mês existe e o nome não consta na
    data (dia ausente no array `dias[]` conta como não escalado);
  - `{ status: 'sem_escala' }` — doc do mês não existe **ou** erro de leitura →
    chamadores aplicam fail-open (permitem).
- `datasEscaladoNoMes(nomeFiscal, mes, ano)` — `Set<yyyy-mm-dd>` das datas em que
  o fiscal está escalado no mês (uso nos importadores; 1 leitura por mês, cacheada).

Carregar o script **antes** de `visa-import.js`/`sim-import.js` em todas as
páginas que lançam PLT ou importam: `lancamento.html`,
`meus-lancamentos.html`, `conferencia.html` e as páginas que disparam a
importação automática (`visa-auto-import.js`/`sim-auto-import.js`).

### 4.2. Validação 1 — digitação manual de PLT (`lancamento.html`)

No `salvar()`, dentro do ramo `tipo.codigo === 'PLT'` (ao lado do bloqueio
PLT × vistoria já existente):

```
resultado = fiscalEscaladoNoDia(user.nome, data)
se resultado.status === 'nao_escalado' → bloquear:
```

> 🚫 Você **não consta na escala de plantão da gerência (VISA)** no dia
> **DD/MM/AAAA**. O lançamento de Plantão fiscal só é permitido para o fiscal
> escalado na data. Havendo troca ou substituição, solicite à gerência a
> atualização da escala antes de lançar.

- `sem_escala` → permite (com `console.warn`).
- Extra de UX (baixo custo): validar também no `change` de `f-data`, exibindo o
  alerta antecipado no mesmo padrão do aviso de ocorrência aceita.

**`meus-lancamentos.html` (editar/mover):** nova função
`bloqueioPlantaoForaEscala(idManual, dataISO)` ao lado de
`bloqueioPlantaoComVistoria` — aplicada ao editar um PLT ou mover sua data, com
a mesma mensagem. Sem isso o fiscal contornaria o bloqueio lançando em dia
válido e movendo depois.

### 4.3. Validação 2 — importação VISA e SIM (zeragem pela escala)

Nos estados por fiscal/mês (`_getEstadoPontosVisa` / `_getEstadoPontosSim`),
acrescentar `escalaDatas = datasEscaladoNoMes(nomeFiscal, mes, ano)` (nome do
fiscal resolvido pelo cadastro `usuarios`/`allFiscais`, o mesmo nome usado na
escala).

Na cadeia de zeragem da vistoria (`visa-import.js:951` / `sim-import.js:171`),
inserir a verificação da escala **logo após** a do PLT manual (ambas item 9),
antes de OPF (item 18) e REL-alta (item 13):

| Ordem | Condição | Mensagem / motivo |
|---|---|---|
| 1 | PLT manual na data (atual) | *(inalterado)* `"Plantão fiscal manual em DD/MM/AAAA — não cumulativo com vistoria (Anexo VII, item 9)."` |
| **2 (novo)** | Fiscal **escalado** na data (escala VISA) | `"Fiscal escalado pela gerência para plantão fiscal em DD/MM/AAAA (escala de plantão do VISA) — não cumulativo com vistoria (Anexo VII, item 9)."` |
| 3 | OPF manual na data | *(inalterado)* |
| 4 | REL alta na data (só VISA) | *(inalterado)* |

Para o caso novo (2):

- `pontos = 0`, `itemDecretoZerado = 9` → `dispositivo_legal` idêntico ao caso 1
  (*"Item 9 do Anexo VII do Decreto 49.723/2023 (não cumulativo — pontuação
  zerada)"*) — mantém a rastreabilidade legal já gravada hoje;
- log de importação: *"⚠️ CONTROLE X — Fulano: vistoria zerada — fiscal escalado
  pela gerência para plantão fiscal em DD/MM (escala VISA)."*;
- vistorias homologadas continuam intocadas (regra existente).

Efeito prático (força o cumprimento da escala): escalado → as vistorias do dia
não pontuam de nenhuma forma; a pontuação do dia vem do plantão cumprido e
lançado (item 6, 48 pts).

### 4.4. Validação 3 — homologação (`conferencia.html`)

> **Ajuste de 03/07/2026 (pós-implantação):** a pedido da gestão, os conflitos
> na homologação **não bloqueiam** mais — o administrador é **avisado** e
> decide caso a caso (confirmação), podendo ajustar a pontuação homologada.

- **PLT manual:** ao homologar, checar `fiscalEscaladoNoDia`; se
  `nao_escalado`, exibir confirmação *"fiscal não consta na escala de plantão
  da gerência (VISA) em DD/MM/AAAA — homologar mesmo assim?"*. Exceções
  legítimas (substituição de última hora) podem ser homologadas diretamente,
  ou a escala é atualizada no VISA antes.
- **Vistorias:** `motivoNaoCumulatividadeVistoria` (`js/visa-import.js:159`)
  ganha a checagem da escala, retornando o motivo *"fiscal escalado pela
  gerência para plantão no mesmo dia (Anexo VII, item 9)"* — ao homologar
  vistoria com pontos > 0 em conflito, o admin é avisado de que pela regra a
  pontuação seria zero e confirma (ou não) a homologação com os pontos
  informados.

### 4.5. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `js/plantao-escala.js` | 🆕 leitura/cache da escala + helpers de match |
| `lancamento.html` | bloqueio de PLT fora da escala + aviso no change de data + include do módulo |
| `meus-lancamentos.html` | `bloqueioPlantaoForaEscala` na edição/movimentação + include |
| `js/visa-import.js` | zeragem pela escala (após PLT manual) + `motivoNaoCumulatividadeVistoria` |
| `js/sim-import.js` | zeragem pela escala (após PLT manual) |
| `conferencia.html` | bloqueio de homologação de PLT fora da escala + include |
| `docs/integracao-visa-rmpf.md` | atualizar seção 15.1 e resumo (16) |
| `changelog.html` / `js/version.js` | registro da versão |

### 4.6. Custo Firestore

1 leitura extra por **mês consultado** (doc `plantao/AAAA-MM`), com cache — na
digitação manual e uma única vez por importação. Desprezível.

---

## 5. Casos de borda mapeados

- **PLT importado do VISA** (tipo "PRORROGACAO" → PLT, `origem: 'visa_csv'`,
  0 pts): fora do escopo — o bloqueio vale só para PLT manual (`ehPlantaoManual`
  já exclui `visa_csv`).
- **Nome divergente** entre `usuarios` e a escala: improvável (a escala é
  montada a partir da própria coleção `usuarios`), mas se o match falhar o
  fiscal aparece como `nao_escalado` → bloqueio conservador; correção = ajustar
  o cadastro. Registrar no log da importação quando o nome do fiscal não for
  encontrado em nenhum dia da escala do mês, para diagnóstico rápido.
- **Escala alterada depois do lançamento/importação:** a revalidação na
  homologação (4.4) captura; reimportar também reaplica a regra (registros não
  homologados são sobrescritos).
- **Dia com `feriado: true` / fim de semana:** sem escalados → PLT manual
  bloqueado (correto: não há plantão nesses dias na escala do VISA).
- **Fiscal de 30h vs 40h:** indiferente — presença em qualquer campo do dia
  (`matutino`, `vespertino`, `integral[]`) conta como escalado.

## 6. Roteiro de testes manuais

1. PLT manual em dia em que o fiscal está escalado → salva normalmente.
2. PLT manual em dia sem o fiscal na escala → bloqueado com a mensagem nova.
3. PLT manual em mês sem doc `plantao/AAAA-MM` → permitido (fail-open).
4. Editar PLT existente movendo para dia fora da escala → bloqueado.
5. Importar VISA com vistoria em dia em que o fiscal está escalado (sem PLT
   manual) → vistoria zerada com `zerado_motivo` da escala e
   `dispositivo_legal` item 9; log com a mensagem nova.
6. Mesmo cenário no SIM → idem.
7. Dia com PLT manual **e** escalado → prevalece a mensagem atual (PLT manual).
8. Homologar PLT de fiscal não escalado → bloqueado em `conferencia.html`.
9. Homologar vistoria com pontos > 0 em dia em que o fiscal está escalado →
   bloqueado pela revalidação.
10. Vistoria já homologada em dia de escala → intocada na reimportação.

---

*Plano elaborado em 03/07/2026 — decisões alinhadas com a gestão (seção 3).
Implementação em PR subsequente.*
