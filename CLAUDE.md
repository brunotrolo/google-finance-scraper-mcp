# CLAUDE.md — Guia de Contexto para IAs

Este arquivo guia assistentes de IA em manutenções, extensões e debugging deste projeto.  
Leia-o inteiro antes de qualquer modificação no código.

---

## Comandos Essenciais

```bash
# Compilar TypeScript (obrigatório antes de rodar ou fazer deploy)
npm run build

# Rodar localmente
npm start

# Compilar + rodar em sequência
npm run build && npm start

# Verificar erros de tipos sem gerar output
npx tsc --noEmit

# Testar a conexão SSE localmente
curl -N http://localhost:8080/sse

# Testar a ferramenta via JSON-RPC manual (exige SSE ativo em outro terminal)
# Veja o README.md para o fluxo completo de teste
```

---

## Estrutura do Projeto

```
src/
└── index.ts     ← ÚNICO arquivo de código. Contém tudo:
                    - Inicialização do Express
                    - Configuração do McpServer (SDK MCP)
                    - Definição da ferramenta get_news_sentinela
                    - Rotas GET /sse e POST /messages
                    - Lógica de scraping (Axios + Cheerio)
```

Não há subpastas em `src/`. Toda a lógica está em `src/index.ts`.

---

## Configuração TypeScript

- **`module: "NodeNext"`** e **`moduleResolution: "NodeNext"`**: Importações de pacotes externos devem usar o path exato com extensão `.js` (ex: `@modelcontextprotocol/sdk/server/mcp.js`).
- **`target: "ESNext"`**: Código gerado usa features modernas do JS.
- **`strict: true`**: Todas as checagens de tipo são ativas. Não use `any` sem justificativa.
- **`skipLibCheck: true`**: Evita conflitos de tipos entre bibliotecas de terceiros.

---

## Padrão de Rotas Express

O servidor tem exatamente duas rotas:

| Método | Rota        | Papel |
|--------|-------------|-------|
| GET    | `/sse`      | Abre a conexão SSE persistente com o cliente MCP |
| POST   | `/messages` | Recebe mensagens JSON-RPC do cliente e as entrega ao transporte |

### REGRA CRÍTICA — Não quebre o stream do POST /messages

`express.json()` é aplicado **globalmente** neste projeto. Isso consome o body stream antes que o SDK MCP possa lê-lo. Para evitar o erro `stream is not readable`, o body já parseado é repassado como terceiro argumento:

```typescript
// CORRETO — repassa req.body como parsedBody
await transport.handlePostMessage(req, res, req.body);

// ERRADO — SDK tenta ler stream já drenado → InternalServerError
await transport.handlePostMessage(req, res);
```

**Nunca remova o `req.body` do terceiro argumento sem remover o `app.use(express.json())` global.**

---

## Como Adicionar uma Nova Ferramenta

1. Registre a ferramenta no `mcpServer` usando `mcpServer.tool()`:

```typescript
mcpServer.tool(
  "nome_da_ferramenta",          // string: nome único
  "Descrição da ferramenta",     // string: exibida no Claude
  {
    param1: z.string().describe("Descrição do parâmetro"),
    param2: z.number().optional(),
  },
  async ({ param1, param2 }) => {
    // lógica de execução
    return {
      content: [{ type: "text" as const, text: JSON.stringify(resultado) }],
    };
  }
);
```

2. O retorno **sempre** deve ser `{ content: [{ type: "text", text: string }] }`.

3. Use `z` do pacote `zod` para definir o schema dos parâmetros.

4. Nunca use `any` no tipo de retorno das ferramentas.

5. Após adicionar, rode `npm run build` para validar os tipos.

---

## Scraping com Axios + Cheerio

O projeto usa Axios para HTTP e Cheerio para parsing de DOM. Sem Puppeteer.

```typescript
// Padrão de request com User-Agent mascarado
const response = await axios.get<string>(url, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...",
    Accept: "text/html,...",
    "Accept-Language": "pt-BR,pt;q=0.9",
  },
  responseType: "text",
});

const $ = load(response.data);
```

Use seletores com `[class*="NomeParcialdaClasse"]` para seletores CSS do Google Finance, pois as classes são ofuscadas e mudam entre deploys do Google.

---

## Trava de Conexão Fantasma (Ghost-Connection Guard)

O servidor mantém uma referência ao transport SSE ativo (`currentTransport`). Quando um novo cliente se conecta via `GET /sse`, o transport anterior é fechado antes de aceitar o novo:

```typescript
if (currentTransport) {
  await currentTransport.close().catch(() => {});
  currentTransport = null;
}
```

Isso evita múltiplos transports ativos simultâneos que causariam mensagens duplicadas ou corrompidas.

---

## Deploy no GCP

Veja o README.md para os comandos completos. Resumo rápido:

```bash
npm run build
gcloud builds submit --tag us-east1-docker.pkg.dev/PROJECT/mcp-servers/google-finance-scraper-mcp:latest .
gcloud run deploy google-finance-scraper-mcp \
  --image us-east1-docker.pkg.dev/PROJECT/mcp-servers/google-finance-scraper-mcp:latest \
  --region us-east1 \
  --no-cpu-throttling \
  --timeout=3600 \
  --min-instances=1
```

**Região obrigatória:** `us-east1` — latência mínima para o backend da Anthropic (Claude Web/Mobile).

---

## Armadilhas Conhecidas

| Armadilha | Sintoma | Solução |
|-----------|---------|---------|
| `express.json()` global sem `parsedBody` | `stream is not readable` no POST /messages | Repassar `req.body` como 3º arg do `handlePostMessage` |
| Deploy fora de `us-east1` | Timeouts de SSE / handshake falha | Mudar região para `us-east1` |
| Cloud Run sem `--no-cpu-throttling` | SSE cai após ~60s de idle | Adicionar a flag no deploy |
| Cold start sem `--min-instances=1` | "Este conector não possui ferramentas" no primeiro acesso | Manter mínimo de 1 instância |
| Cache de `tools/list` da Anthropic | "Conector sem ferramentas" mesmo após fix | Reimplantar o servidor e reconectar o conector no Claude |

---

## Dependências Chave

| Pacote | Versão | Papel |
|--------|--------|-------|
| `@modelcontextprotocol/sdk` | ^1.0.0 | Protocolo MCP, SSEServerTransport, McpServer |
| `express` | ^4.18.0 | Servidor HTTP |
| `axios` | ^1.6.0 | Requisições HTTP para o Google Finance |
| `cheerio` | ^1.0.0 | Parsing de HTML (como jQuery server-side) |
| `zod` | ^3.22.0 | Validação de schema dos parâmetros das ferramentas |
