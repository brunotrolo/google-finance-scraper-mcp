import express from "express";
import puppeteer, { type Browser } from "puppeteer";
import { load } from "cheerio";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── Persistent browser singleton ────────────────────────────────────────────
// Reused across requests to amortise the ~2s Chromium startup cost.
// Re-launched automatically if the process crashes.
let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;

  const executablePath = process.env["PUPPETEER_EXECUTABLE_PATH"];
  browser = await puppeteer.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--no-sandbox",            // required when running as root in containers
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // /dev/shm is too small in Cloud Run (64 MB)
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-sync",
    ],
  });

  browser.on("disconnected", () => { browser = null; });
  return browser;
}

// ── HTTP fetch via Puppeteer ─────────────────────────────────────────────────
async function fetchWithPuppeteer(url: string): Promise<string> {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Referer": "https://www.google.com/",
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for the news section to be injected by Google's JS.
    // On a real browser session, Google Finance renders ticker-specific news.
    await page
      .waitForSelector('[class*="LIT7If"]', { timeout: 10000 })
      .catch(() => { /* fallbacks in scrapeNews handle missing nodes */ });

    return await page.content();
  } finally {
    await page.close();
  }
}

// ── HTML parser (Cheerio) ────────────────────────────────────────────────────
type NewsItem = { title: string; source: string; date: string; url: string };

function scrapeNews(html: string): NewsItem[] {
  const $ = load(html);
  const news: NewsItem[] = [];

  // Primary: LIT7If containers (Google Finance layout verified 2026-05)
  // Structure:
  //   .LIT7If
  //     .jDwR9c
  //       .WrUjhf  ← source name
  //       .JQ8Czd  ← date
  //     <a href="https://...">
  //       .TQWIEd  ← title text
  $('[class*="LIT7If"]').each((_, elem) => {
    if (news.length >= 6) return false;

    const block = $(elem);
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

    const block = $(elem);
    const title =
      block.find('[class*="mRssg"]').first().text().trim() ||
      block.find('[class*="TQWIEd"]').first().text().trim();
    const source =
      block.find('[class*="OG9vdf"]').first().text().trim() ||
      block.find('[class*="WrUjhf"]').first().text().trim();
    const date =
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

// ── MCP server ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

const mcpServer = new McpServer({
  name: "google-finance-scraper",
  version: "1.0.0",
});

mcpServer.tool(
  "get_news_sentinela",
  "Busca as últimas notícias de uma ação no Google Finance usando Puppeteer (navegador headless real)",
  { ticker: z.string().describe("Ticker da ação (ex: BBDC4 ou BBDC4:BVMF)") },
  async ({ ticker }) => {
    const normalized = ticker.includes(":") ? ticker : `${ticker}:BVMF`;
    const [symbol, exchange] = normalized.split(":");
    const url = `https://www.google.com/finance/quote/${symbol}:${exchange}?hl=pt-BR`;

    const html  = await fetchWithPuppeteer(url);
    const news  = scrapeNews(html);

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

// ── Express routes ───────────────────────────────────────────────────────────
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

// ── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT",  () => { void shutdown().then(() => process.exit(0)); });

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env["PORT"] ? parseInt(process.env["PORT"]) : 8080;
app.listen(PORT, () => {
  console.log(`MCP server listening on http://localhost:${PORT}`);
  console.log(`  SSE:      GET  /sse`);
  console.log(`  Messages: POST /messages`);
  console.log(`  Browser:  Puppeteer headless (lazy-init on first request)`);
});
