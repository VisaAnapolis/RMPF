# Mirror sem PAT — solução anotada (a fazer)

> Anotado em 24/07/2026 a pedido do usuário, para executar com calma depois.
> Objetivo: **eliminar a dependência do secret `MIRROR_PAT` para sempre** e, de
> quebra, derrubar o tempo do mirror de ~7 min para ~1–2 min.

## O problema (comprovado nos logs)

O `mirror.yml` empurra o código para `VisaAnapolis/RMPF` via **chave SSH de
deploy** — e push por chave de deploy **não dispara o build automático** do
GitHub Pages no repo corporativo. Resultado, visível em todos os runs verdes
(ex.: run #329 de 22/07 e #332 de 24/07, ambos ~7min):

```
Tentativa 1/3: aguardando deploy...      ← espera 6 min por um build que nunca vem
Deploy não concluiu; solicitando build   ← o pedido explícito (usa MIRROR_PAT)
Pedido de rebuild: HTTP 201
✅ Site corporativo publicado             ← ~40s depois do pedido
```

Ou seja: **quem publica o site é o pedido feito com a PAT** — daí a dependência
do token (e as falhas quando ele expira/é trocado). Os ~6 primeiros minutos são
espera morta.

## A solução definitiva (zero PAT)

Fazer o **próprio repo corporativo** pedir o build, usando o `GITHUB_TOKEN`
automático dele (token que o GitHub cria e renova sozinho a cada run — ninguém
gera, ninguém guarda, não expira na mão de ninguém).

Evidência de que funciona: os workflows espelhados **já disparam** no
`VisaAnapolis/RMPF` a cada push do mirror (o próprio `mirror.yml` espelhado
aparece lá como *skipped* pela trava `if:`) — logo, um workflow novo com a
trava invertida vai rodar lá.

### Passo 1 — criar `.github/workflows/pages-corporate.yml`

```yaml
name: Publicar Pages corporativo

# Roda SOMENTE no espelho (VisaAnapolis/RMPF): o push do mirror chega por
# chave SSH de deploy, que não aciona o build automático do Pages. Este
# workflow pede o build com o GITHUB_TOKEN do próprio repositório — sem PAT.
# No garrado/RMPF este job aparece como "skipped" (trava if) — esperado.
on:
  push:
    branches: [main]

permissions:
  pages: write

jobs:
  pedir-build:
    runs-on: ubuntu-latest
    if: github.repository == 'VisaAnapolis/RMPF'
    steps:
      - name: Solicitar build do Pages
        run: |
          curl -sS -o /dev/null -w "Pedido de build: HTTP %{http_code}\n" -X POST \
            -H "Authorization: Bearer ${{ secrets.GITHUB_TOKEN }}" \
            -H "Accept: application/vnd.github+json" \
            "https://api.github.com/repos/${{ github.repository }}/pages/builds"
```

### Passo 2 — simplificar o passo final do `mirror.yml`

Trocar o passo "Garantir deploy do Pages corporativo" (que usa `MIRROR_PAT` e
espera 6 min) por uma confirmação **melhor-esforço, sem credenciais** (o repo
corporativo é público): poll de ~15 em 15s por até ~4 min; se confirmar,
`✅`; se não, apenas `::warning::` apontando para as Actions do repo
corporativo — **sem derrubar o mirror**. Quem acusa falha de publicação passa a
ser o workflow do Passo 1, dentro do próprio espelho.

### Passo 3 — faxina (depois de 1 ciclo verde)

- Apagar os secrets que sobraram em `garrado/RMPF → Settings → Secrets`:
  `MIRROR_PAT`, `MIRROR_RMPF` (duplicado criado durante o diagnóstico) e,
  se não usado por mais nada, `VISAANAPOLIS_PAT`.
- Revogar os tokens correspondentes em `github.com/settings/tokens`.
- `SSH_DEPLOY_KEY` **fica** — é ela que empurra o código, e funciona.

## Resultado esperado

- Mirror: ~1–2 min (hoje ~7 min), sempre verde.
- Site corporativo publica sozinho a cada merge, sem token pessoal nenhum.
- Nunca mais "desgraça de PAT".
