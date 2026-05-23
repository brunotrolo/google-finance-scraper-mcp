# Regras de Infraestrutura — GCP Cloud Run

Esta regra se aplica sempre que você modificar `Dockerfile`, arquivos de CI/CD (`cloudbuild.yaml`, `.github/workflows/`), ou executar comandos `gcloud`.

---

## Região Obrigatória: `us-east1`

**Sempre** faça deploy na região `us-east1` (Carolina do Sul, EUA).

O Claude Web e Claude Mobile conectam a partir de datacenters na East Coast dos EUA. A latência de handshake SSE para regiões fora dos EUA (`southamerica-east1`, `europe-west1`, etc.) causa:
- Timeouts no estabelecimento da conexão SSE.
- "Este conector não possui ferramentas disponíveis" por falha silenciosa no handshake.
- Degradação de ~150-200ms por request de ferramenta.

```bash
# CORRETO
gcloud run deploy ... --region us-east1

# ERRADO para uso com Claude Web/Mobile
gcloud run deploy ... --region southamerica-east1
```

---

## Flags Obrigatórias no Cloud Run Deploy

### `--no-cpu-throttling`

Sem esta flag, o Cloud Run suspende a CPU de instâncias idle. O processo Node.js congela e a conexão SSE cai silenciosamente do lado do cliente.

**Sempre inclua esta flag:**
```bash
gcloud run deploy ... --no-cpu-throttling
```

### `--timeout=3600`

O timeout padrão é 300 segundos. Sessões longas do Claude (análise de portfólio, pesquisa extensa) excedem esse limite.

**Sempre inclua esta flag:**
```bash
gcloud run deploy ... --timeout=3600
```

### `--min-instances=1`

Cold start em servidores MCP SSE causa falha no handshake: o Claude tenta conectar antes da instância estar pronta, recebe lista de ferramentas vazia e armazena esse resultado em cache.

**Sempre inclua esta flag em produção:**
```bash
gcloud run deploy ... --min-instances=1
```

---

## Template Completo de Deploy

```bash
gcloud run deploy google-finance-scraper-mcp \
  --image us-east1-docker.pkg.dev/SEU_PROJECT_ID/mcp-servers/google-finance-scraper-mcp:latest \
  --platform managed \
  --region us-east1 \
  --port 8080 \
  --no-cpu-throttling \
  --timeout=3600 \
  --memory=512Mi \
  --min-instances=1 \
  --allow-unauthenticated
```

---

## Artifact Registry

O repositório de imagens Docker deve estar na mesma região que o Cloud Run:

```bash
# Criar repositório (uma vez)
gcloud artifacts repositories create mcp-servers \
  --repository-format=docker \
  --location=us-east1

# Path da imagem
us-east1-docker.pkg.dev/SEU_PROJECT_ID/mcp-servers/NOME_DO_SERVICO:latest
```

---

## Build via Cloud Build

Não use `docker build` local para produção. Use o Cloud Build para garantir que a imagem seja construída no ambiente GCP:

```bash
gcloud builds submit \
  --tag us-east1-docker.pkg.dev/SEU_PROJECT_ID/mcp-servers/google-finance-scraper-mcp:latest \
  .
```

O `Dockerfile` deve sempre fazer `npm ci --omit=dev` (não `npm install`) para builds reprodutíveis.

---

## Checklist de Deploy

- [ ] Região é `us-east1`?
- [ ] Flag `--no-cpu-throttling` presente?
- [ ] Flag `--timeout=3600` presente?
- [ ] Flag `--min-instances=1` presente?
- [ ] `npm run build` rodou localmente sem erros antes do `gcloud builds submit`?
- [ ] Imagem no Artifact Registry de `us-east1`?
