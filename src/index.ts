// ─── Types ────────────────────────────────────────────────────────────────

interface NewsItem {
  title: string;
  link: string;
  source: string;
  category: string;
  pubDate: string;
  summary: string;
}

interface Env {
  NEWS_KV: KVNamespace;
}

// ─── RSS XML Parser (pure JS, no dependencies) ───────────────────────────

function parseRSS(xml: string, source: string, category: string): NewsItem[] {
  const items: NewsItem[] = [];

  // Split by <item> or <entry> (Atom)
  const itemBlobs = xml.split(/<item|<entry/).slice(1);

  for (const blob of itemBlobs) {
    const title = extractCdata(blob, "title");
    const link = extractLink(blob);
    const pubDate = extractText(blob, "pubDate") || extractText(blob, "published") || extractText(blob, "updated") || "";
    const summary = extractCdata(blob, "description") || extractCdata(blob, "summary") || extractCdata(blob, "content") || "";

    if (title && link) {
      items.push({
        title: decodeEntities(stripTags(title).trim()),
        link: link.trim(),
        source,
        category,
        pubDate: pubDate.trim(),
        summary: decodeEntities(stripTags(summary).trim()).slice(0, 200),
      });
    }
  }

  return items;
}

function extractCdata(blob: string, tag: string): string {
  // Try CDATA first: <tag><![CDATA[...]]></tag>
  const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i");
  const cdataMatch = blob.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1];

  // Fall back to plain text: <tag>...</tag>
  const plainRegex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const plainMatch = blob.match(plainRegex);
  return plainMatch ? plainMatch[1] : "";
}

function extractText(blob: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i");
  const match = blob.match(regex);
  return match ? match[1] : "";
}

function extractLink(blob: string): string {
  // Atom: <link href="..." />
  const hrefMatch = blob.match(/<link[^>]+href=["']([^"']+)["']/i);
  if (hrefMatch) return hrefMatch[1];

  // RSS: <link>...</link>
  const linkMatch = blob.match(/<link[^>]*>([^<]*)<\/link>/i);
  return linkMatch ? linkMatch[1] : "";
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ─── RSS Sources ─────────────────────────────────────────────────────────

const RSS_SOURCES = [
  { url: "https://techcrunch.com/category/artificial-intelligence/feed/", source: "TechCrunch", category: "ai" },
  { url: "https://techcrunch.com/tag/robotics/feed/", source: "TechCrunch", category: "robotics" },
  { url: "https://venturebeat.com/category/ai/feed/", source: "VentureBeat", category: "ai" },
  { url: "https://www.therobotreport.com/feed/", source: "The Robot Report", category: "robotics" },
];

// ─── Fetch RSS ───────────────────────────────────────────────────────────

async function fetchRSS(url: string, source: string, category: string): Promise<NewsItem[]> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; WelaiBot/1.0; +https://welai.org)",
        Accept: "application/rss+xml, application/xml, text/xml",
      },
      cf: { cacheTtl: 0 },
    });

    if (!res.ok) {
      console.error(`[${source}] HTTP ${res.status} from ${url}`);
      return [];
    }

    const xml = await res.text();
    return parseRSS(xml, source, category);
  } catch (err) {
    console.error(`[${source}] fetch error:`, err);
    return [];
  }
}

// ─── Fetch Handler ───────────────────────────────────────────────────────

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const cached = await env.NEWS_KV.get("latest", "json");
  const news: NewsItem[] = cached ? (cached as unknown as NewsItem[]) : [];

  const category = new URL(request.url).searchParams.get("category");
  const filtered = category ? news.filter((n) => n.category === category) : news;

  return new Response(renderHTML(filtered, category), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ─── Scheduled Handler ───────────────────────────────────────────────────

async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const results = await Promise.allSettled(
    RSS_SOURCES.map((src) => fetchRSS(src.url, src.source, src.category))
  );

  let allNews: NewsItem[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      allNews = allNews.concat(r.value);
    }
  }

  // Sort by pubDate descending
  allNews.sort((a, b) => {
    const da = new Date(a.pubDate).getTime();
    const db = new Date(b.pubDate).getTime();
    return (isNaN(db) ? 0 : db) - (isNaN(da) ? 0 : da);
  });

  // Keep latest 120 items
  allNews = allNews.slice(0, 120);

  await env.NEWS_KV.put("latest", JSON.stringify(allNews));
  console.log(`[scheduled] stored ${allNews.length} news items`);
}

// ─── HTML Renderer ───────────────────────────────────────────────────────

function renderHTML(news: NewsItem[], activeCategory: string | null): string {
  const categoryLabels: Record<string, { label: string; color: string }> = {
    ai: { label: "AI", color: "#00d4ff" },
    robotics: { label: "机器人", color: "#ff6b35" },
    vc: { label: "VC投资", color: "#a855f7" },
  };

  const newsCards = news
    .map(
      (item) => {
        const cat = categoryLabels[item.category] || { label: item.category, color: "#666" };
        const dateStr = formatDate(item.pubDate);
        return `
    <a href="${escapeHtml(item.link)}" target="_blank" rel="noopener" class="news-card">
      <div class="card-meta">
        <span class="category-badge" style="--badge-color: ${cat.color}">${cat.label}</span>
        <span class="source">${escapeHtml(item.source)}</span>
        <span class="date">${dateStr}</span>
      </div>
      <h2 class="card-title">${escapeHtml(item.title)}</h2>
      ${item.summary ? `<p class="card-summary">${escapeHtml(item.summary)}</p>` : ""}
    </a>`;
      }
    )
    .join("\n");

  const filterLinks = Object.entries(categoryLabels)
    .map(([key, val]) => {
      const active = activeCategory === key ? ' class="active"' : "";
      return `<a href="/?category=${key}"${active}>${val.label}</a>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WELAI.ORG - AI 与机器人前沿资讯</title>
  <meta name="description" content="每日聚合 AI、机器人、VC投资最新资讯，来自 TechCrunch、VentureBeat 等权威来源">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'><stop offset='0%25' stop-color='%2300d4ff'/><stop offset='100%25' stop-color='%23a855f7'/></linearGradient></defs><circle cx='50' cy='50' r='8' fill='url(%23g)'/><line x1='50' y1='42' x2='35' y2='22' stroke='url(%23g)' stroke-width='3' stroke-linecap='round'/><circle cx='35' cy='22' r='5' fill='%2300d4ff'/><line x1='50' y1='42' x2='65' y2='22' stroke='url(%23g)' stroke-width='3' stroke-linecap='round'/><circle cx='65' cy='22' r='5' fill='%23a855f7'/><line x1='50' y1='58' x2='35' y2='78' stroke='url(%23g)' stroke-width='3' stroke-linecap='round'/><circle cx='35' cy='78' r='5' fill='%237b61ff'/><line x1='50' y1='58' x2='65' y2='78' stroke='url(%23g)' stroke-width='3' stroke-linecap='round'/><circle cx='65' cy='78' r='5' fill='%2300d4ff'/><line x1='42' y1='50' x2='22' y2='50' stroke='url(%23g)' stroke-width='3' stroke-linecap='round'/><circle cx='22' cy='50' r='4' fill='%2300d4ff'/><line x1='58' y1='50' x2='78' y2='50' stroke='url(%23g)' stroke-width='3' stroke-linecap='round'/><circle cx='78' cy='50' r='4' fill='%23a855f7'/></svg>">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0a0a0f;
      --surface: rgba(255, 255, 255, 0.04);
      --surface-hover: rgba(255, 255, 255, 0.08);
      --border: rgba(255, 255, 255, 0.08);
      --text: #e0e0e8;
      --text-dim: #8888a0;
      --accent-cyan: #00d4ff;
      --accent-purple: #a855f7;
      --accent-orange: #ff6b35;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
    }

    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.6;
    }

    /* Ambient gradient background */
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse 80% 50% at 20% 10%, rgba(0, 212, 255, 0.08), transparent),
        radial-gradient(ellipse 60% 40% at 80% 80%, rgba(168, 85, 247, 0.06), transparent);
      pointer-events: none;
      z-index: 0;
    }

    .container {
      position: relative;
      z-index: 1;
      max-width: 900px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }

    /* ── Header ── */
    header {
      text-align: center;
      margin-bottom: 2.5rem;
    }

    .logo {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
    }

    .logo-icon {
      filter: drop-shadow(0 0 8px rgba(0, 212, 255, 0.3));
    }

    .logo-text {
      font-size: 2.4rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      background: linear-gradient(135deg, var(--accent-cyan), var(--accent-purple));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .logo-dot {
      opacity: 0.55;
    }

    .tagline {
      color: var(--text-dim);
      font-size: 0.95rem;
      margin-top: 0.4rem;
    }

    /* ── Filters ── */
    .filters {
      display: flex;
      justify-content: center;
      gap: 0.6rem;
      margin-bottom: 2rem;
      flex-wrap: wrap;
    }

    .filters a {
      text-decoration: none;
      color: var(--text-dim);
      padding: 0.4rem 1rem;
      border-radius: 999px;
      border: 1px solid var(--border);
      font-size: 0.85rem;
      transition: all 0.2s;
      backdrop-filter: blur(8px);
      background: var(--surface);
    }

    .filters a:hover,
    .filters a.active {
      color: var(--accent-cyan);
      border-color: var(--accent-cyan);
      background: rgba(0, 212, 255, 0.08);
      box-shadow: 0 0 12px rgba(0, 212, 255, 0.15);
    }

    /* ── News Grid ── */
    .news-list {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .news-card {
      display: block;
      text-decoration: none;
      color: inherit;
      padding: 1.2rem 1.4rem;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--surface);
      backdrop-filter: blur(12px);
      transition: all 0.25s ease;
    }

    .news-card:hover {
      background: var(--surface-hover);
      border-color: rgba(0, 212, 255, 0.2);
      transform: translateY(-2px);
      box-shadow:
        0 4px 20px rgba(0, 0, 0, 0.3),
        0 0 30px rgba(0, 212, 255, 0.05);
    }

    .card-meta {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin-bottom: 0.5rem;
      font-size: 0.78rem;
      flex-wrap: wrap;
    }

    .category-badge {
      padding: 0.15rem 0.6rem;
      border-radius: 999px;
      font-weight: 600;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--badge-color);
      border: 1px solid var(--badge-color);
      background: color-mix(in srgb, var(--badge-color) 10%, transparent);
    }

    .source { color: var(--text-dim); }
    .date { color: var(--text-dim); margin-left: auto; }

    .card-title {
      font-size: 1.05rem;
      font-weight: 600;
      line-height: 1.4;
      color: var(--text);
    }

    .card-summary {
      font-size: 0.85rem;
      color: var(--text-dim);
      margin-top: 0.4rem;
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    /* ── Empty State ── */
    .empty-state {
      text-align: center;
      padding: 4rem 1rem;
      color: var(--text-dim);
    }

    .empty-state .icon {
      font-size: 3rem;
      margin-bottom: 1rem;
      opacity: 0.5;
    }

    /* ── Footer ── */
    footer {
      text-align: center;
      padding: 3rem 0 1.5rem;
      color: var(--text-dim);
      font-size: 0.78rem;
    }

    footer a {
      color: var(--accent-cyan);
      text-decoration: none;
    }

    /* ── Responsive ── */
    @media (max-width: 640px) {
      .container { padding: 1.2rem 1rem; }
      .logo { font-size: 1.8rem; }
      .news-card { padding: 1rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">
        <svg class="logo-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="44" height="44">
          <defs>
            <linearGradient id="lg" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#00d4ff"/>
              <stop offset="50%" stop-color="#7b61ff"/>
              <stop offset="100%" stop-color="#a855f7"/>
            </linearGradient>
          </defs>
          <circle cx="40" cy="40" r="7" fill="url(#lg)"/>
          <line x1="40" y1="33" x2="24" y2="12" stroke="url(#lg)" stroke-width="2" stroke-linecap="round"/>
          <circle cx="24" cy="12" r="4.5" fill="#00d4ff"/>
          <line x1="40" y1="33" x2="56" y2="12" stroke="url(#lg)" stroke-width="2" stroke-linecap="round"/>
          <circle cx="56" cy="12" r="4.5" fill="#a855f7"/>
          <line x1="40" y1="47" x2="24" y2="68" stroke="url(#lg)" stroke-width="2" stroke-linecap="round"/>
          <circle cx="24" cy="68" r="4.5" fill="#7b61ff"/>
          <line x1="40" y1="47" x2="56" y2="68" stroke="url(#lg)" stroke-width="2" stroke-linecap="round"/>
          <circle cx="56" cy="68" r="4.5" fill="#00d4ff"/>
          <line x1="33" y1="40" x2="12" y2="40" stroke="url(#lg)" stroke-width="2" stroke-linecap="round"/>
          <circle cx="12" cy="40" r="3.5" fill="#00d4ff" opacity="0.7"/>
          <line x1="47" y1="40" x2="68" y2="40" stroke="url(#lg)" stroke-width="2" stroke-linecap="round"/>
          <circle cx="68" cy="40" r="3.5" fill="#a855f7" opacity="0.7"/>
          <circle cx="40" cy="40" r="13" fill="none" stroke="#00d4ff" stroke-width="0.8" opacity="0.2"/>
          <circle cx="40" cy="40" r="20" fill="none" stroke="#a855f7" stroke-width="0.5" opacity="0.12"/>
          <!-- Secondary connections -->
          <line x1="24" y1="12" x2="12" y2="40" stroke="url(#lg)" stroke-width="0.7" opacity="0.2"/>
          <line x1="56" y1="12" x2="68" y2="40" stroke="url(#lg)" stroke-width="0.7" opacity="0.2"/>
          <line x1="24" y1="68" x2="12" y2="40" stroke="url(#lg)" stroke-width="0.7" opacity="0.2"/>
          <line x1="56" y1="68" x2="68" y2="40" stroke="url(#lg)" stroke-width="0.7" opacity="0.2"/>
        </svg>
        <span class="logo-text">WELAI<span class="logo-dot">.ORG</span></span>
      </div>
      <p class="tagline">AI · 机器人 · 前沿科技 — 每日聚合</p>
    </header>

    <nav class="filters">
      <a href="/"${activeCategory ? "" : ' class="active"'}>全部</a>
      ${filterLinks}
    </nav>

    <main class="news-list">
      ${
        news.length
          ? newsCards
          : `<div class="empty-state">
          <div class="icon">⚡</div>
          <p>暂无资讯，请稍后再来</p>
        </div>`
      }
    </main>

    <footer>
      <p>数据来源：TechCrunch · VentureBeat · The Robot Report</p>
      <p>每 30 分钟自动更新 | 部署于 <a href="https://developers.cloudflare.com/workers/" target="_blank">Cloudflare Workers</a></p>
    </footer>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr.slice(0, 16);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

// ─── Worker Export ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(event, env));
  },
};
