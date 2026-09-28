# RMPF — memória do projeto

Regras de negócio e decisões já tomadas, para não serem reinvestigadas.

## Importação VISA (`js/visa-import.js`)

- A pontuação vem **somente** do `data/inspecoes.csv` do repositório `garrado/VISA`.
  O `denuncia.csv` é lido apenas para o **prazo** da denúncia (não gera lançamento).

### Denúncia de "não estabelecimento" não pontua — comportamento correto, não é bug

- Denúncia com `NAO_ESTAB = True` e sem regulado vinculado (`CODIGO`/`VISITA_CTRL`
  vazios) **não gera linha no `inspecoes.csv`**, logo não entra no RMPF.
- Quando o fiscal cadastra/vincula o estabelecimento durante o atendimento, a visita
  passa a existir no `inspecoes.csv` e é pontuada normalmente (confirmado em
  set/2026: denúncias 20260419, 20260421, 20260437 — regulado cadastrado no dia da visita).
- Quando o reclamado **não é de competência da VISA** (ex.: denúncia 20260659,
  Equatorial), não há CNAE nem complexidade, portanto **não há como pontuar** o item
  "Vistoria ou atendimento a denúncia" do Decreto 49.723/2023 — a falha está no
  decreto, não no sistema.
- **Decisão do gestor (Cláudio):** o RMPF **não** deve importar/pontuar essas denúncias
  a partir do `denuncia.csv`. Nesses casos o fiscal faz **lançamento manual** de
  operações fiscais ou serviços técnicos.
