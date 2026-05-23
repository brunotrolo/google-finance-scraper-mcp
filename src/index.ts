import express from "express";
import axios from "axios";
import { load } from "cheerio";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";

const app = express();
app.use(express.json());

const mcpServer = new McpServer({
  name: "google-finance-scraper",
  version: "1.0.0",
});

mcpServer.tool(
  "get_news_sentinela",
  "Busca as últimas notícias de uma ação no Google Finance",
  { ticker: z.string().describe("Ticker da ação (ex: BBDC4 ou BBDC4:BVMF)") },
  async ({ ticker }) => {
    const normalized = ticker.includes(":") ? ticker : `${ticker}:BVMF`;
    const [symbol, exchange] = normalized.split(":");
    const url = `https://www.google.com/finance/quote/${symbol}:${exchange}?hl=pt-BR`;

    const response = await axios.get<string>(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
      },
      responseType: "text",
    });

    const $ = load(response.data);

    type NewsItem = { title: string; source: string; date: string; url: string };
    const news: NewsItem[] = [];

    $('[class*="Yfwt3"]').each((i, elem) => {
      if (i >= 6) return false;

      const title = $(elem).find('[class*="mRssg"]').text().trim();
      const source = $(elem).find('[class*="OG9vdf"]').text().trim();
      const date = $(elem).find('[class*="Q71vJd"]').text().trim();
      let href = $(elem).find("a").attr("href") ?? "";

      if (href.startsWith("./")) {
        href = "https://www.google.com/finance/" + href.slice(2);
      }

      if (title) {
        news.push({ title, source, date, url: href });
      }
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(news.slice(0, 6), null, 2),
        },
      ],
    };
  }
);

// Ghost-connection guard: only one active SSE transport at a time
let currentTransport: SSEServerTransport | null = null;

app.get("/sse", async (req, res) => {
  if (currentTransport) {
    try {
      await currentTransport.close();
    } catch {
      // ignore errors on stale transport
    }
    currentTransport = null;
  }

  const transport = new SSEServerTransport(
    "/messages",
    res as unknown as ServerResponse
  );

  transport.onclose = () => {
    if (currentTransport === transport) {
      currentTransport = null;
    }
  };

  currentTransport = transport;
  await mcpServer.connect(transport);
});

app.post("/messages", async (req, res) => {
  if (!currentTransport) {
    res.status(400).json({ error: "No active SSE connection" });
    return;
  }

  await currentTransport.handlePostMessage(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    req.body
  );
});

const PORT = 8080;
app.listen(PORT, () => {
  console.log(`MCP server listening on http://localhost:${PORT}`);
  console.log(`  SSE endpoint:      GET  /sse`);
  console.log(`  Message endpoint:  POST /messages`);
});
