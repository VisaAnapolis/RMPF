# RMPF
Relatório Mensal de Produtividade Fiscal

## 🔄 Mirror automático → visaanapolis/RMPF

O workflow `.github/workflows/mirror.yml` sincroniza automaticamente todo push em `garrado/RMPF` para `visaanapolis/RMPF`.

Após espelhar, o workflow acompanha o build do GitHub Pages em `visaanapolis/RMPF` até ele publicar. Se o deploy corporativo falhar (ex.: erro transitório do GitHub), ele solicita novos builds automaticamente (até 3 tentativas) e, se mesmo assim não publicar, o job falha — ou seja, basta olhar o Actions de `garrado/RMPF`: verde significa código **e site** corporativos atualizados.

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

---

## 🔧 Configuração de CORS do Firebase Storage

Para que o upload de anexos (PDFs) funcione a partir do GitHub Pages (`https://visaanapolis.github.io`), é necessário aplicar a configuração de CORS ao bucket do Firebase Storage **uma única vez**.

### Pré-requisitos

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) instalado (`gcloud`)
- Conta com acesso ao projeto Firebase `visam-3a30b`

### Como aplicar

```bash
# 1. Autentique-se no Google Cloud
gcloud auth login

# 2. Aplique o arquivo cors.json ao bucket
gcloud storage buckets update gs://visam-3a30b.firebasestorage.app --cors-file=cors.json
```

### Verificar se está aplicado

```bash
gcloud storage buckets describe gs://visam-3a30b.firebasestorage.app --format="json(cors_config)"
```

> ⚠️ Sem essa configuração, o Firebase Storage bloqueará os uploads com erro de CORS (ERR_FAILED), e os anexos não serão salvos.
