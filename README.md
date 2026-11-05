# RMPF
Relatório Mensal de Produtividade Fiscal

## 📚 Documentação

Comece por [`docs/README.md`](docs/README.md) (arquitetura, páginas, coleções e
automação). As regras de negócio numeradas estão em
[`docs/RN-RMPF-REGRAS-NEGOCIO-v1.0.md`](docs/RN-RMPF-REGRAS-NEGOCIO-v1.0.md).

---

## 🔄 Mirror automático → VisaAnapolis/RMPF

O workflow `.github/workflows/mirror.yml` espelha todo push em `garrado/RMPF`
para `VisaAnapolis/RMPF` (`git push --mirror` com a chave SSH do secret
`SSH_DEPLOY_KEY`). A publicação do site corporativo é feita **lá**, pelo
`.github/workflows/pages-corporativo.yml`, com o `GITHUB_TOKEN` do próprio
repositório — **não há mais PAT** (`MIRROR_PAT` foi aposentado na v1.36.0, depois
de expirar e congelar o site).

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
