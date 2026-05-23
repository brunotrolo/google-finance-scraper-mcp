# google-finance-scraper-mcp

Servidor MCP ultra-leve para scraping de notícias e dados do Google Finance.  
Stack: **Node.js + TypeScript + Express + Axios + Cheerio** (sem Puppeteer).  
Protocolo: **MCP via SSE** (`@modelcontextprotocol/sdk`).

---

## Visão Geral

O servidor expõe ferramentas MCP consumíveis pelo Claude Web, Claude Mobile e qualquer cliente compatível com o Model Context Protocol. A comunicação acontece via Server-Sent Events (SSE): o cliente abre uma conexão persistente em `GET /sse` e envia mensagens JSON-RPC via `POST /messages`.

```
Cliente MCP (Claude Web/Mobile)
        │
        │  GET /sse  (conexão SSE persistente)
        ▼
┌───────────────────────────────┐
│   Express :8080               │
│   ├── GET  /sse               │  ← abre stream, conecta transporte
│   └── POST /messages          │  ← recebe JSON-RPC, responde via SSE
│                               │
│   McpServer (SDK 1.x)         │
│   └── tool: get_news_sentinela│
└───────────────────────────────┘
        │
        │  axios.get (User-Agent mascarado)
        ▼
  google.com/finance/quote/TICKER:EXCHANGE
        │
        │  cheerio.load(html)
        ▼
  Array<{ title, source, date, url }>
```

---

## Ferramentas Disponíveis

### `get_news_sentinela`

Retorna até 6 notícias recentes de um ticker do Google Finance.

| Parâmetro | Tipo   | Obrigatório | Descrição |
|-----------|--------|-------------|-----------|
| `ticker`  | string | sim         | Ticker da ação. Aceita `BBDC4` ou `BBDC4:BVMF`. Se sem sufixo, `:BVMF` é adicionado automaticamente. |

**Resposta (JSON stringificado):**
```json
[
  {
    "title": "Bradesco reporta lucro de R$ 6,8 bilhões no 2T25",
    "source": "Bloomberg Línea",
    "date": "há 2 dias",
    "url": "https://www.google.com/finance/..."
  }
]
```

---

## Arquitetura de Produção — Google Cloud Run

### Por que Cloud Run?

O Cloud Run é o ambiente de produção recomendado para servidores MCP com transporte SSE porque:

- **Escala a zero** quando não há conexões ativas.
- **Conexões persistentes** são suportadas nativamente (ao contrário de Cloud Functions).
- **URL HTTPS pública** é provisionada automaticamente, sem configuração de load balancer.

### Por que `us-east1` (Carolina do Sul)?

O Claude Web e o Claude Mobile (`claude.ai`) operam a partir de datacenters **nos EUA (East Coast)**. O handshake SSE é uma conexão HTTP de longa duração — qualquer latência transcontinental no estabelecimento da conexão causa:

- Timeout durante o handshake inicial.
- Desconexões esporádicas em sessões longas.
- Degradação perceptível na responsividade das ferramentas.

Ao hospedar o servidor em `us-east1`, o RTT entre o backend da Anthropic e o servidor MCP cai de ~150–200 ms (São Paulo → EUA) para **< 30 ms** (Virginia → Carolina do Sul).

> **Regra de ouro:** Sempre deploy em `us-east1` para servidores MCP integrados ao Claude Web/Mobile.

### Parâmetros Críticos do Cloud Run

#### `--no-cpu-throttling`

Por padrão, o Cloud Run **suspende a CPU** de instâncias que não estão processando uma requisição HTTP ativa. Uma conexão SSE idle (aguardando eventos) é considerada "inativa" — a CPU é throttled, o processo Node.js congela e o cliente perde a conexão.

```
❌ Sem flag: instância dorme → SSE morre → Claude perde a ferramenta
✅ Com flag:  instância ativa → SSE mantém o heartbeat → Claude conectado
```

#### `--timeout=3600`

O timeout padrão do Cloud Run é 300 segundos. Uma sessão do Claude Web pode durar horas. Definir o timeout para 3600 segundos (1 hora) evita que o Cloud Run encerre conexões SSE legítimas por inatividade.

---

## Guia de Deploy no GCP

### Pré-requisitos

```bash
gcloud auth login
gcloud config set project SEU_PROJECT_ID
gcloud config set run/region us-east1
```

### 1. Criar o Artifact Registry

```bash
gcloud artifacts repositories create mcp-servers \
  --repository-format=docker \
  --location=us-east1 \
  --description="Imagens Docker dos servidores MCP"
```

### 2. Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY build/ ./build/
EXPOSE 8080
CMD ["node", "build/index.js"]
```

### 3. Build e Push da Imagem

```bash
# Compilar TypeScript
npm run build

# Build e push direto via Cloud Build
gcloud builds submit \
  --tag us-east1-docker.pkg.dev/SEU_PROJECT_ID/mcp-servers/google-finance-scraper-mcp:latest \
  .
```

### 4. Deploy no Cloud Run

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

> **`--min-instances=1`:** Evita cold start. Para SSE, o cold start causa falha no handshake — o cliente tenta conectar antes da instância estar pronta.

### 5. Verificar o Deploy

```bash
# URL do serviço
gcloud run services describe google-finance-scraper-mcp \
  --region us-east1 \
  --format='value(status.url)'

# Testar SSE manualmente
curl -N https://SEU_SERVICO-xxxxxx-ue.a.run.app/sse
```

---

## Bugs Críticos Resolvidos

### Bug 1 — `InternalServerError: stream is not readable`

**Contexto:** Ao usar `app.use(express.json())` como middleware **global**, o Express consome o body stream de `POST /messages` antes que o `SSEServerTransport.handlePostMessage` possa lê-lo. O SDK tenta fazer `getRawBody(req)` em um stream já drenado e lança o erro.

**Sintoma:**
```
InternalServerError: stream is not readable
    at SSEServerTransport.handlePostMessage (sse.js:...)
```

**Solução — Duas opções válidas:**

**Opção A (adotada neste projeto):** Manter o `express.json()` global e repassar o body já parseado como terceiro argumento:
```typescript
// O body foi consumido pelo middleware — repassamos req.body como parsedBody
await transport.handlePostMessage(req, res, req.body);
```

**Opção B (mais limpa):** Remover o `express.json()` global e deixar o SDK ler o raw body diretamente:
```typescript
// Sem express.json() global:
app.post("/messages", async (req, res) => {
  await transport.handlePostMessage(req, res); // SDK lê o raw stream
});
```

> **Regra:** Nunca adicione parsers de body na rota `POST /messages` sem repassar `req.body` como terceiro argumento (`parsedBody`) ao `handlePostMessage`.

---

### Bug 2 — "Este conector não possui ferramentas disponíveis" (Cache da Anthropic)

**Contexto:** O Claude Web e Mobile fazem `tools/list` durante a inicialização e **armazenam o resultado em cache**. Se o servidor responder com lista vazia (cold start, race condition, falha no handshake), esse cache negativo persiste mesmo após o problema ser corrigido.

**Sintoma:** Claude exibe "Este conector não possui ferramentas disponíveis" mesmo com o servidor operacional.

**Solução — TOOL_REGISTRY Estático:**

Expor um `TOOL_REGISTRY` hardcoded garante que `tools/list` sempre retorne a lista completa, independente do estado de inicialização do SDK:

```typescript
const TOOL_REGISTRY = [
  {
    name: "get_news_sentinela",
    description: "Busca as últimas notícias de uma ação no Google Finance",
    inputSchema: {
      type: "object",
      properties: {
        ticker: {
          type: "string",
          description: "Ticker (ex: BBDC4 ou BBDC4:BVMF)"
        }
      },
      required: ["ticker"]
    }
  }
] as const;
```

Combinar o TOOL_REGISTRY estático com o handler dinâmico do SDK torna o servidor resiliente ao cache da Anthropic e a race conditions de inicialização.

---

## Estrutura do Projeto

```
google-finance-scraper-mcp/
├── src/
│   └── index.ts               # Entry point: Express + MCP SSE + ferramentas
├── build/                     # Saída do TypeScript (gerado — não commitar)
├── .claude/
│   ├── settings.json          # Comandos pré-aprovados para o Claude Code
│   └── rules/
│       ├── express-stream.md  # Regra crítica: isolamento do POST /messages
│       └── infra.md           # Regras de deploy GCP
├── CLAUDE.md                  # Guia de contexto para IAs
├── README.md                  # Este arquivo
├── package.json
├── package-lock.json
├── tsconfig.json
└── .gitignore
```

---

## Desenvolvimento Local

```bash
# Instalar dependências
npm install

# Compilar TypeScript
npm run build

# Rodar o servidor
npm start
# → MCP server listening on http://localhost:8080

# Testar SSE (em outro terminal)
curl -N http://localhost:8080/sse
```

---

## Variáveis de Ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PORT`   | `8080` | Porta do servidor Express |

---

## Referências

- [Model Context Protocol Specification](https://modelcontextprotocol.io)
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [Cloud Run — Conexões WebSocket e SSE](https://cloud.google.com/run/docs/triggering/websockets)
- [Google Finance](https://www.google.com/finance)
