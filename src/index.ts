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

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Referer: "https://www.google.com/",
};

type NewsItem = { title: string; source: string; date: string; url: string };

// ── Primary: HTML scrape via Axios + Cheerio ─────────────────────────────────
function scrapeNews(html: string): NewsItem[] {
  const $ = load(html);
  const news: NewsItem[] = [];

  // LIT7If containers (Google Finance layout verified 2026-05)
  // Structure:
  //   .LIT7If
  //     .jDwR9c
  //       .WrUjhf  ← source name
  //       .JQ8Czd  ← date
  //     <a href="https://...">
  //       .TQWIEd  ← title text
  $('[class*="LIT7If"]').each((_, elem) => {
    if (news.length >= 6) return false;

    const block  = $(elem);
    const title  = block.find('[class*="TQWIEd"]').first().text().trim();
    const source = block.find('[class*="WrUjhf"]').first().text().trim();
    const date   = block.find('[class*="JQ8Czd"]').first().text().trim();
    const href   = block.find("a[href]").first().attr("href") ?? "";

    if (title && href) {
      news.push({ title, source: source || "Unknown", date: date || "", url: href });
    }
  });

  if (news.length > 0) return news;

  // Fallback A: Yfwt3 containers (2024 layout)
  $('[class*="Yfwt3"]').each((_, elem) => {
    if (news.length >= 6) return false;

    const block  = $(elem);
    const title  =
      block.find('[class*="mRssg"]').first().text().trim() ||
      block.find('[class*="TQWIEd"]').first().text().trim();
    const source =
      block.find('[class*="OG9vdf"]').first().text().trim() ||
      block.find('[class*="WrUjhf"]').first().text().trim();
    const date   =
      block.find('[class*="Q71vJd"]').first().text().trim() ||
      block.find('[class*="JQ8Czd"]').first().text().trim();
    let href = block.find("a[href]").first().attr("href") ?? "";

    if (href.startsWith("./")) {
      href = "https://www.google.com/finance/" + href.slice(2);
    }

    if (title && href) {
      news.push({ title, source: source || "Unknown", date: date || "", url: href });
    }
  });

  if (news.length > 0) return news;

  // Fallback B: any <a> whose href looks like a news story
  $("a[href]").each((_, elem) => {
    if (news.length >= 6) return false;

    const el   = $(elem);
    const href = el.attr("href") ?? "";
    const isNewsLink =
      /\/(news|story|article|articles|noticia|noticias)/.test(href) ||
      /bloomberg|reuters|cnbc|wsj|ft\.com|g1\.globo|infomoney|valor/.test(href);

    if (!isNewsLink) return;

    const title = el.find("[class]").first().text().trim() || el.text().trim();
    if (!title || title.length < 10) return;
    if (news.some((n) => n.url === href)) return;

    const container = el.parent();
    const source = container.find('[class*="WrUjhf"], [class*="OG9vdf"]').first().text().trim();
    const date   = container.find('[class*="JQ8Czd"], [class*="Q71vJd"]').first().text().trim();

    news.push({ title, source: source || "Unknown", date: date || "", url: href });
  });

  return news;
}

// ── RSS fallback (Google News) ────────────────────────────────────────────────
// Activated when the HTML scrape returns empty (bot-detection / geo-block).
// Google News RSS does not apply the same bot-detection as google.com/finance.
async function fetchRSSFallback(symbol: string): Promise<NewsItem[]> {
  const rssUrl =
    `https://news.google.com/rss/search?q=${symbol}` +
    `+site:valor.globo.com+OR+site:infomoney.com.br+OR+site:exame.com+OR+site:moneytimes.com.br` +
    `&hl=pt-BR&gl=BR&ceid=BR:pt`;

  const response = await axios.get<string>(rssUrl, {
    headers: {
      "User-Agent": BROWSER_HEADERS["User-Agent"],
      Accept: "application/rss+xml, application/xml, text/xml, */*",
      "Accept-Language": "pt-BR,pt;q=0.9",
    },
    responseType: "text",
    timeout: 10000,
  });

  // xmlMode: true treats <link> and <source> as regular XML elements (not HTML voids)
  const $ = load(response.data, { xmlMode: true });
  const news: NewsItem[] = [];

  $("item").each((_, elem) => {
    if (news.length >= 6) return false;

    const title   = $(elem).find("title").text().trim();
    // In RSS 2.0, <link> is a text node with the URL
    const link    = $(elem).find("link").text().trim() ||
                    $(elem).find("guid").text().trim();
    const source  = $(elem).find("source").text().trim();
    const pubDate = $(elem).find("pubDate").text().trim();

    if (title && link) {
      news.push({
        title,
        source: source || "Google News",
        date:   pubDate,
        url:    link,
      });
    }
  });

  return news;
}

// ── MCP tool ─────────────────────────────────────────────────────────────────
mcpServer.tool(
  "get_news_sentinela",
  "Busca as últimas notícias de uma ação da B3 no Google Finance (fallback via RSS do Google News)",
  { ticker: z.string().describe("Símbolo da ação na B3 (ex: BBDC4, PETR4, VALE3)") },
  async ({ ticker }) => {
    const symbol = ticker.includes(":") ? ticker.split(":")[0] : ticker;

    // ── Step 1: HTML scrape (primary) ────────────────────────────────────────
    let news: NewsItem[] = [];
    try {
      const url = `https://www.google.com/finance/quote/${symbol}:BMFBOVESPA?hl=pt-BR`;
      const response = await axios.get<string>(url, {
        headers: BROWSER_HEADERS,
        responseType: "text",
        timeout: 15000,
      });
      news = scrapeNews(response.data);
    } catch {
      // Primary fetch failed — proceed to RSS fallback below
    }

    // ── Step 2: RSS fallback when HTML is empty (bot-detection triggered) ────
    if (news.length === 0) {
      try {
        news = await fetchRSSFallback(symbol);
      } catch {
        // Both strategies failed — return empty array gracefully
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(news, null, 2),
        },
      ],
    };
  }
);

// ── Express routes ────────────────────────────────────────────────────────────
let currentTransport: SSEServerTransport | null = null;

app.get("/sse", async (_req, res) => {
  if (currentTransport) {
    try {
      await currentTransport.close();
    } catch { /* ignore stale transport errors */ }
    currentTransport = null;
  }

  const transport = new SSEServerTransport(
    "/messages",
    res as unknown as ServerResponse
  );

  transport.onclose = () => {
    if (currentTransport === transport) currentTransport = null;
  };

  currentTransport = transport;
  await mcpServer.connect(transport);
});

app.post("/messages", async (req, res) => {
  if (!currentTransport) {
    res.status(400).json({ error: "No active SSE connection" });
    return;
  }

  // express.json() already consumed the body stream; pass req.body as parsedBody
  // to prevent "stream is not readable" — see .claude/rules/express-stream.md
  await currentTransport.handlePostMessage(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    req.body
  );
});

const PORT = process.env["PORT"] ? parseInt(process.env["PORT"]) : 8080;
app.listen(PORT, () => {
  console.log(`MCP server listening on http://localhost:${PORT}`);
  console.log(`  SSE:      GET  /sse`);
  console.log(`  Messages: POST /messages`);
});
