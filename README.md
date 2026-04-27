# RMPF
Relatório Mensal de Produtividade Fiscal

## 🔄 Mirror automático → visaanapolis/RMPF

O workflow `.github/workflows/mirror.yml` sincroniza automaticamente todo push em `garrado/RMPF` para `visaanapolis/RMPF`.

### Configuração (usa PAT — muito mais simples que SSH)

**Passo 1 — Criar o Personal Access Token na conta `visaanapolis`**
1. Acesse https://github.com/settings/tokens (logado como `visaanapolis`)
2. Clique em **"Generate new token (classic)"**
3. Nome: `mirror-rmpf`
4. Escopos necessários: ✅ `repo` (marcar o item pai — seleciona todos os subitens)
5. Expiration: **No expiration** (ou o prazo que preferir)
6. Clique em **"Generate token"** e **copie o token** (começa com `ghp_...`)

**Passo 2 — Adicionar o token como Secret em `garrado/RMPF`**
1. Acesse https://github.com/garrado/RMPF/settings/secrets/actions
2. Clique em **"New repository secret"**
3. Nome: `MIRROR_PAT`
4. Valor: cole o token copiado (`ghp_...`)
5. Clique em **"Add secret"**

**Passo 3 — Testar**
1. Acesse https://github.com/garrado/RMPF/actions
2. Selecione o workflow **"Mirror → visaanapolis/RMPF"**
3. Clique em **"Run workflow"** → **"Run workflow"**
4. Aguarde — deve ficar verde ✅

> ⚠️ Certifique-se que o repositório `visaanapolis/RMPF` existe antes de rodar o workflow.
