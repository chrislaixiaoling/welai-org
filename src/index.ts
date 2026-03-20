// ─── Types ────────────────────────────────────────────────────────────────

interface NewsItem {
  title: string;
  link: string;
  source: string;
  category: string;
  pubDate: string;
  summary: string;
  image: string;
}

interface Env {
  NEWS_KV: KVNamespace;
  INSTAPAPER_CONSUMER_KEY: string;
  INSTAPAPER_CONSUMER_SECRET: string;
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
    const rawContent = extractCdata(blob, "content") || extractCdata(blob, "description") || "";

    if (title && link) {
      items.push({
        title: decodeEntities(stripTags(title).trim()),
        link: link.trim(),
        source,
        category,
        pubDate: pubDate.trim(),
        summary: decodeEntities(stripTags(summary).trim()).slice(0, 200),
        image: extractImage(blob, rawContent),
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

function extractImage(blob: string, rawContent: string): string {
  // 1. <enclosure type="image/..." url="..." />
  const enclosure = blob.match(/<enclosure[^>]+type=["']image\/[^"']*["'][^>]+url=["']([^"']+)["']/i);
  if (enclosure) return enclosure[1];
  const enclosure2 = blob.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image\/[^"']*["']/i);
  if (enclosure2) return enclosure2[1];

  // 2. <media:content type="image/..." url="..." />
  const mediaContent = blob.match(/<media:content[^>]+url=["']([^"']+)["']/i);
  if (mediaContent && /\.(jpg|jpeg|png|gif|webp|svg)/i.test(mediaContent[1])) return mediaContent[1];

  // 3. <media:thumbnail url="..." />
  const mediaThumb = blob.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i);
  if (mediaThumb) return mediaThumb[1];

  // 4. <img src="..." from raw content/description (not stripped)
  const imgMatch = rawContent.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  // 5. direct image URL in raw content
  const directImg = rawContent.match(/(https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|gif|webp))/i);
  if (directImg) return directImg[1];

  return "";
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

// ─── Instapaper OAuth 1.0a (xAuth) ───────────────────────────────────────

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

async function hmacSha1(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function buildOAuthHeader(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string
): Promise<string> {
  const sigBase = Object.keys(params).sort().map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join("&");
  const signKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const baseStr = `${method}&${percentEncode(url)}&${percentEncode(sigBase)}`;
  const sig = await hmacSha1(signKey, baseStr);

  const oauthParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith("oauth_")) oauthParams[k] = v;
  }
  oauthParams["oauth_signature"] = sig;

  return "OAuth " + Object.keys(oauthParams).sort().map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`).join(", ");
}

async function instapaperXAuth(env: Env, username: string, password: string): Promise<{ token: string; secret: string } | null> {
  const url = "https://www.instapaper.com/api/1/oauth/access_token";
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, "");

  const params: Record<string, string> = {
    oauth_consumer_key: env.INSTAPAPER_CONSUMER_KEY,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: ts,
    oauth_nonce: nonce,
    oauth_version: "1.0",
    x_auth_username: username,
    x_auth_password: password,
    x_auth_mode: "client_auth",
  };

  const authHeader = await buildOAuthHeader("POST", url, params, env.INSTAPAPER_CONSUMER_SECRET, "");

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/x-www-form-urlencoded" },
    body: Object.entries({ x_auth_username: username, x_auth_password: password, x_auth_mode: "client_auth" })
      .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`).join("&"),
  });

  if (!res.ok) { console.error("[instapaper] xAuth failed:", res.status); return null; }
  const text = await res.text();
  const tokenMatch = text.match(/oauth_token=([^\n&]+)/);
  const secretMatch = text.match(/oauth_token_secret=([^\n&]+)/);
  if (tokenMatch && secretMatch) return { token: tokenMatch[1], secret: secretMatch[1] };
  return null;
}

async function fetchInstapaperBookmarks(accessToken: string, accessTokenSecret: string, env: Env): Promise<NewsItem[]> {
  try {
    const url = "https://www.instapaper.com/api/1/bookmarks/list";
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID().replace(/-/g, "");

    const params: Record<string, string> = {
      oauth_consumer_key: env.INSTAPAPER_CONSUMER_KEY,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: ts,
      oauth_nonce: nonce,
      oauth_version: "1.0",
      oauth_token: accessToken,
      limit: "50",
      folder_id: "unread",
    };

    const authHeader = await buildOAuthHeader("POST", url, params, env.INSTAPAPER_CONSUMER_SECRET, accessTokenSecret);

    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/x-www-form-urlencoded" },
      body: "limit=50&folder_id=unread",
    });

    if (!res.ok) { console.error("[instapaper] bookmarks failed:", res.status); return []; }
    const data = (await res.json()) as Array<Record<string, unknown>>;
    const bookmarks = data.filter((item) => item.type === "bookmark");

    const items: NewsItem[] = bookmarks.map((b) => ({
      title: String(b.title || ""),
      link: String(b.url || ""),
      source: "Instapaper",
      category: "reading",
      pubDate: b.time ? new Date(Number(b.time) * 1000).toISOString() : "",
      summary: String(b.description || ""),
      image: "",
    }));

    const imagePromises = items.map(async (item) => {
      if (!item.link) return;
      item.image = await fetchOgImage(item.link);
    });
    await Promise.allSettled(imagePromises);

    return items;
  } catch (err) {
    console.error("[instapaper] fetch error:", err);
    return [];
  }
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

// ─── OG Image Fetcher ──────────────────────────────────────────────────

async function fetchOgImage(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; WelaiBot/1.0; +https://welai.org)",
        Accept: "text/html",
      },
      cf: { cacheTtl: 86400 },
    });

    if (!res.ok) return "";

    const html = await res.text();
    // Only read first 50KB to find og:image
    const head = html.slice(0, 50000);

    // og:image
    const ogMatch = head.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || head.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch) return ogMatch[1];

    // twitter:image
    const twMatch = head.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      || head.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    if (twMatch) return twMatch[1];

    return "";
  } catch {
    return "";
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
  const [rssResults, instapaperItems] = await Promise.all([
    Promise.allSettled(RSS_SOURCES.map((src) => fetchRSS(src.url, src.source, src.category))),
    (async () => {
      const creds = await env.NEWS_KV.get("instapaper_creds", "json") as { token: string; secret: string } | null;
      if (!creds) {
        // Auto-authenticate on first run
        const auth = await instapaperXAuth(env, "wizatom@gmail.com", "lxl75A79");
        if (auth) {
          await env.NEWS_KV.put("instapaper_creds", JSON.stringify(auth));
          return fetchInstapaperBookmarks(auth.token, auth.secret, env);
        }
        return [];
      }
      return fetchInstapaperBookmarks(creds.token, creds.secret, env);
    })(),
  ]);

  let allNews: NewsItem[] = [];
  for (const r of rssResults) {
    if (r.status === "fulfilled") {
      allNews = allNews.concat(r.value);
    }
  }
  allNews = allNews.concat(instapaperItems);

  // Sort by pubDate descending
  allNews.sort((a, b) => {
    const da = new Date(a.pubDate).getTime();
    const db = new Date(b.pubDate).getTime();
    return (isNaN(db) ? 0 : db) - (isNaN(da) ? 0 : da);
  });

  // Keep latest 120 items
  allNews = allNews.slice(0, 120);

  // Fetch OG images for top 10 items (for banner)
  const imagePromises = allNews.slice(0, 10).map(async (item) => {
    if (!item.image) {
      item.image = await fetchOgImage(item.link);
    }
  });
  await Promise.allSettled(imagePromises);

  await env.NEWS_KV.put("latest", JSON.stringify(allNews));
  console.log(`[scheduled] stored ${allNews.length} news items`);
}

// ─── HTML Renderer ───────────────────────────────────────────────────────

function renderHTML(news: NewsItem[], activeCategory: string | null): string {
  const categoryLabels: Record<string, { label: string; color: string }> = {
    ai: { label: "AI", color: "#00e5ff" },
    robotics: { label: "机器人", color: "#ff6b35" },
    vc: { label: "VC投资", color: "#f0b040" },
    reading: { label: "稍后读", color: "#a78bfa" },
  };

  const newsCards = news
    .map(
      (item, i) => {
        const cat = categoryLabels[item.category] || { label: item.category, color: "#5a5a6e" };
        const dateStr = formatDate(item.pubDate);
        const serial = String(i + 1).padStart(3, "0");
        return `
    <a href="${escapeHtml(item.link)}" target="_blank" rel="noopener" class="news-card" style="--accent: ${cat.color}; animation-delay: ${Math.min(i * 0.04, 1.2)}s">
      <div class="card-index">${serial}</div>
      <div class="card-body">
        <div class="card-meta">
          <span class="category-badge">${cat.label}</span>
          <span class="source">${escapeHtml(item.source)}</span>
          <span class="card-dot"></span>
          <span class="date">${dateStr}</span>
        </div>
        <h2 class="card-title">${escapeHtml(item.title)}</h2>
        ${item.summary ? `<p class="card-summary">${escapeHtml(item.summary)}</p>` : ""}
      </div>
      <div class="card-arrow">→</div>
    </a>`;
      }
    )
    .join("\n");

  const filterLinks = Object.entries(categoryLabels)
    .map(([key, val]) => {
      const active = activeCategory === key ? " active" : "";
      return `<a href="/?category=${key}" class="filter-btn${active}" style="--data-color: ${val.color}">${val.label}</a>`;
    })
    .join("\n");

  const tickerItems = news.slice(0, 5).map((n) => `<span class="ticker-item">${escapeHtml(n.title)}</span>`).join("");

  // Banner: top 3 items with images
  const bannerNews = news.filter((n) => n.image).slice(0, 3);
  const bannerHTML = bannerNews.length
    ? `<div class="banner">${bannerNews
        .map((item) => {
          const cat = categoryLabels[item.category] || { label: item.category, color: "#5a5a6e" };
          return `
    <a href="${escapeHtml(item.link)}" target="_blank" rel="noopener" class="banner-item">
      <img class="banner-img" src="${escapeHtml(item.image)}" alt="" loading="lazy">
      <div class="banner-overlay"></div>
      <div class="banner-content">
        <div class="banner-label">${cat.label} · ${escapeHtml(item.source)}</div>
        <h2 class="banner-title">${escapeHtml(item.title)}</h2>
        <div class="banner-source">${formatDate(item.pubDate)}</div>
      </div>
    </a>`;
        })
        .join("")}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>未来科技局 — AI · 机器人 · 前沿科技情报</title>
  <meta name="description" content="未来科技局 — 每日聚合 AI、机器人、VC投资最新科技情报">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='10' y='10' width='80' height='80' rx='8' fill='none' stroke='%23f0b040' stroke-width='6'/><text x='50' y='62' text-anchor='middle' font-size='40' font-weight='bold' fill='%23f0b040' font-family='serif'>局</text></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Serif+SC:wght@600;700;900&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg-deep: #faf9f5;
      --bg-surface: #f2f0ea;
      --bg-card: #ffffff;
      --bg-card-hover: #f5f3ed;
      --border: rgba(120, 90, 30, 0.12);
      --border-bright: rgba(120, 90, 30, 0.28);
      --text-primary: #1a1a1a;
      --text-secondary: #6b6b6b;
      --text-muted: #a0a0a0;
      --accent-gold: #b8860b;
      --accent-gold-dim: rgba(184, 134, 11, 0.08);
      --accent-cyan: #0891b2;
      --mono: "IBM Plex Mono", "SF Mono", "Fira Code", monospace;
      --serif: "Noto Serif SC", "Songti SC", "SimSun", serif;
      --sans: -apple-system, "Noto Sans SC", "PingFang SC", sans-serif;
    }

    html { font-size: 16px; -webkit-font-smoothing: antialiased; }

    body {
      font-family: var(--sans);
      background: var(--bg-deep);
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.6;
      overflow-x: hidden;
    }

    /* ── Scan lines overlay ── */
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(184, 134, 11, 0.012) 2px,
        rgba(184, 134, 11, 0.012) 4px
      );
      pointer-events: none;
      z-index: 9999;
    }

    /* ── Grain texture ── */
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      opacity: 0.018;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      pointer-events: none;
      z-index: 9998;
    }

    .wrapper {
      position: relative;
      z-index: 1;
      max-width: 880px;
      margin: 0 auto;
      padding: 0 1.5rem;
    }

    /* ══════════════════════════════════════════
       HEADER
       ══════════════════════════════════════════ */

    .masthead {
      padding: 3.5rem 0 0;
      margin-bottom: 2rem;
      text-align: center;
      position: relative;
    }

    /* Decorative corner brackets */
    .masthead::before,
    .masthead::after {
      content: "";
      position: absolute;
      width: 28px;
      height: 28px;
      border-color: var(--accent-gold);
      border-style: solid;
      opacity: 0.3;
    }
    .masthead::before {
      top: 1.5rem; left: 0;
      border-width: 2px 0 0 2px;
    }
    .masthead::after {
      top: 1.5rem; right: 0;
      border-width: 2px 2px 0 0;
    }

    .masthead-stamp {
      display: inline-block;
      font-family: var(--mono);
      font-size: 0.65rem;
      letter-spacing: 0.35em;
      text-transform: uppercase;
      color: var(--accent-gold);
      border: 1px solid var(--accent-gold-dim);
      padding: 0.2rem 1rem;
      margin-bottom: 1.2rem;
      opacity: 0.7;
      animation: fadeIn 0.6s ease both;
    }

    .masthead-title {
      font-family: var(--serif);
      font-size: 3.2rem;
      font-weight: 900;
      letter-spacing: 0.08em;
      color: var(--text-primary);
      line-height: 1.2;
      margin-bottom: 0.5rem;
      animation: titleReveal 0.8s ease both;
      position: relative;
    }

    /* Glow behind title */
    .masthead-title::after {
      content: "未来科技局";
      position: absolute;
      inset: 0;
      color: var(--accent-gold);
      filter: blur(30px);
      opacity: 0.08;
      z-index: -1;
    }

    .masthead-sub {
      font-family: var(--mono);
      font-size: 0.78rem;
      color: var(--text-muted);
      letter-spacing: 0.15em;
      animation: fadeIn 0.8s 0.2s ease both;
    }

    .masthead-sub span {
      color: var(--accent-gold);
      opacity: 0.6;
    }

    /* Decorative divider */
    .divider {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin: 1.5rem 0;
      animation: fadeIn 0.6s 0.3s ease both;
    }
    .divider::before,
    .divider::after {
      content: "";
      flex: 1;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--accent-gold-dim), transparent);
    }
    .divider-diamond {
      width: 6px;
      height: 6px;
      background: var(--accent-gold);
      transform: rotate(45deg);
      opacity: 0.5;
    }

    /* ══════════════════════════════════════════
       TICKER
       ══════════════════════════════════════════ */

    .ticker-strip {
      overflow: hidden;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      padding: 0.55rem 0;
      margin-bottom: 1.8rem;
      animation: fadeIn 0.6s 0.4s ease both;
      position: relative;
    }

    .ticker-strip::before {
      content: "LIVE";
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      font-family: var(--mono);
      font-size: 0.6rem;
      font-weight: 600;
      letter-spacing: 0.15em;
      color: #fff;
      background: var(--accent-gold);
      padding: 0.15rem 0.5rem;
      z-index: 2;
    }

    .ticker-content {
      display: flex;
      animation: tickerScroll 40s linear infinite;
      padding-left: 3.5rem;
    }

    .ticker-item {
      flex-shrink: 0;
      font-family: var(--mono);
      font-size: 0.72rem;
      color: var(--text-secondary);
      white-space: nowrap;
      padding-right: 3rem;
    }

    .ticker-item::before {
      content: "◆";
      color: var(--accent-gold);
      opacity: 0.4;
      margin-right: 0.6rem;
      font-size: 0.5rem;
      vertical-align: middle;
    }

    @keyframes tickerScroll {
      0% { transform: translateX(0); }
      100% { transform: translateX(-50%); }
    }

    /* ══════════════════════════════════════════
       BANNER
       ══════════════════════════════════════════ */

    .banner {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 2px;
      margin-bottom: 2rem;
      animation: fadeIn 0.8s 0.35s ease both;
    }

    .banner-item {
      position: relative;
      overflow: hidden;
      text-decoration: none;
      color: var(--text-primary);
      display: block;
      min-height: 220px;
      transition: transform 0.4s ease;
    }

    .banner-item:hover {
      transform: scale(1.01);
      z-index: 2;
    }

    .banner-img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: transform 0.6s ease, filter 0.4s ease;
    }

    .banner-item:hover .banner-img {
      transform: scale(1.06);
      filter: brightness(1.1);
    }

    .banner-overlay {
      position: absolute;
      inset: 0;
      background: linear-gradient(
        0deg,
        rgba(250, 249, 245, 0.95) 0%,
        rgba(250, 249, 245, 0.55) 40%,
        rgba(250, 249, 245, 0.1) 100%
      );
      z-index: 1;
    }

    /* Scan line effect on banner */
    .banner-item::after {
      content: "";
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 3px,
        rgba(184, 134, 11, 0.02) 3px,
        rgba(184, 134, 11, 0.02) 6px
      );
      z-index: 2;
      pointer-events: none;
    }

    .banner-content {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 1.2rem;
      z-index: 3;
    }

    .banner-item:first-child .banner-content {
      padding: 1.2rem;
    }

    .banner-label {
      font-family: var(--mono);
      font-size: 0.58rem;
      font-weight: 600;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: var(--accent-gold);
      margin-bottom: 0.4rem;
    }

    .banner-title {
      font-size: 0.88rem;
      font-weight: 600;
      line-height: 1.45;
      color: var(--text-primary);
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .banner-item:first-child .banner-title {
      font-size: 0.88rem;
      -webkit-line-clamp: 3;
    }

    .banner-source {
      font-family: var(--mono);
      font-size: 0.62rem;
      color: var(--text-muted);
      margin-top: 0.4rem;
    }

    /* Decorative border accent on hover */
    .banner-item::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 2px;
      background: linear-gradient(90deg, var(--accent-gold), transparent);
      z-index: 4;
      transform: scaleX(0);
      transform-origin: left;
      transition: transform 0.4s ease;
    }

    .banner-item:hover::before {
      transform: scaleX(1);
    }

    @media (max-width: 640px) {
      .banner {
        grid-template-columns: 1fr;
        gap: 2px;
      }
      .banner-item {
        min-height: 160px !important;
      }
    }

    /* ══════════════════════════════════════════
       FILTERS
       ══════════════════════════════════════════ */

    .filters {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 2rem;
      flex-wrap: wrap;
      animation: fadeIn 0.6s 0.5s ease both;
    }

    .filter-btn {
      text-decoration: none;
      font-family: var(--mono);
      font-size: 0.72rem;
      font-weight: 500;
      letter-spacing: 0.08em;
      color: var(--text-muted);
      padding: 0.4rem 0.9rem;
      border: 1px solid var(--border);
      background: transparent;
      transition: all 0.25s ease;
      position: relative;
      overflow: hidden;
    }

    .filter-btn::before {
      content: "";
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      height: 1px;
      background: var(--data-color, var(--accent-gold));
      transform: scaleX(0);
      transition: transform 0.3s ease;
    }

    .filter-btn:hover,
    .filter-btn.active {
      color: var(--text-primary);
      border-color: var(--border-bright);
      background: var(--accent-gold-dim);
    }

    .filter-btn:hover::before,
    .filter-btn.active::before {
      transform: scaleX(1);
    }

    /* ══════════════════════════════════════════
       NEWS CARDS
       ══════════════════════════════════════════ */

    .news-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .news-card {
      display: flex;
      align-items: stretch;
      text-decoration: none;
      color: inherit;
      background: var(--bg-card);
      border-left: 2px solid transparent;
      transition: all 0.3s ease;
      animation: cardSlideIn 0.5s ease both;
      position: relative;
    }

    .news-card:hover {
      background: var(--bg-card-hover);
      border-left-color: var(--accent, var(--accent-gold));
      transform: translateX(4px);
    }

    .news-card:hover .card-arrow {
      opacity: 1;
      transform: translateX(0);
      color: var(--accent, var(--accent-gold));
    }

    .news-card:hover .card-index {
      color: var(--accent, var(--accent-gold));
      opacity: 1;
    }

    .card-index {
      flex-shrink: 0;
      width: 52px;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 1.15rem;
      font-family: var(--mono);
      font-size: 0.68rem;
      font-weight: 600;
      color: var(--text-muted);
      opacity: 0.4;
      transition: all 0.3s ease;
    }

    .card-body {
      flex: 1;
      padding: 0.9rem 1rem 0.9rem 0;
      min-width: 0;
    }

    .card-meta {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.35rem;
      font-size: 0.7rem;
      flex-wrap: wrap;
    }

    .category-badge {
      font-family: var(--mono);
      font-size: 0.6rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--accent, var(--accent-gold));
      padding: 0.1rem 0.45rem;
      border: 1px solid currentColor;
      opacity: 0.8;
    }

    .source {
      color: var(--text-muted);
      font-family: var(--mono);
    }

    .card-dot {
      width: 3px;
      height: 3px;
      border-radius: 50%;
      background: var(--text-muted);
      opacity: 0.3;
    }

    .date {
      color: var(--text-muted);
      font-family: var(--mono);
      margin-left: auto;
    }

    .card-title {
      font-size: 0.95rem;
      font-weight: 600;
      line-height: 1.5;
      color: var(--text-primary);
      transition: color 0.2s;
    }

    .news-card:hover .card-title {
      color: var(--accent-gold);
    }

    .card-summary {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin-top: 0.3rem;
      line-height: 1.55;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .card-arrow {
      flex-shrink: 0;
      width: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      color: var(--text-muted);
      opacity: 0;
      transform: translateX(-6px);
      transition: all 0.3s ease;
    }

    /* ══════════════════════════════════════════
       EMPTY STATE
       ══════════════════════════════════════════ */

    .empty-state {
      text-align: center;
      padding: 5rem 1rem;
      color: var(--text-muted);
      border: 1px solid var(--border);
    }

    .empty-state-icon {
      font-family: var(--mono);
      font-size: 0.7rem;
      letter-spacing: 0.3em;
      color: var(--accent-gold);
      opacity: 0.4;
      margin-bottom: 1rem;
    }

    .empty-state p {
      font-size: 0.85rem;
    }

    /* ══════════════════════════════════════════
       FOOTER
       ══════════════════════════════════════════ */

    footer {
      padding: 2.5rem 0 2rem;
      border-top: 1px solid var(--border);
      margin-top: 2.5rem;
    }

    .footer-inner {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.8rem;
    }

    .footer-sources {
      font-family: var(--mono);
      font-size: 0.65rem;
      color: var(--text-muted);
      letter-spacing: 0.05em;
    }

    .footer-meta {
      font-family: var(--mono);
      font-size: 0.65rem;
      color: var(--text-muted);
      letter-spacing: 0.05em;
    }

    footer a {
      color: var(--accent-gold);
      text-decoration: none;
      opacity: 0.7;
      transition: opacity 0.2s;
    }

    footer a:hover { opacity: 1; }

    .footer-stamp {
      text-align: center;
      margin-top: 1.2rem;
      font-family: var(--mono);
      font-size: 0.58rem;
      color: var(--text-muted);
      opacity: 0.3;
      letter-spacing: 0.25em;
    }

    /* ══════════════════════════════════════════
       ANIMATIONS
       ══════════════════════════════════════════ */

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes titleReveal {
      from { opacity: 0; letter-spacing: 0.2em; }
      to { opacity: 1; letter-spacing: 0.08em; }
    }

    @keyframes cardSlideIn {
      from { opacity: 0; transform: translateX(-12px); }
      to { opacity: 1; transform: translateX(0); }
    }

    /* ══════════════════════════════════════════
       RESPONSIVE
       ══════════════════════════════════════════ */

    @media (max-width: 640px) {
      .wrapper { padding: 0 1rem; }
      .masthead { padding-top: 2rem; }
      .masthead-title { font-size: 2.2rem; }
      .card-index { width: 36px; font-size: 0.6rem; }
      .card-body { padding: 0.75rem 0.5rem 0.75rem 0; }
      .card-title { font-size: 0.88rem; }
      .card-arrow { display: none; }
      .footer-inner { flex-direction: column; text-align: center; }
      .ticker-strip::before { display: none; }
      .ticker-content { padding-left: 0; }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <header class="masthead">
      <div class="masthead-stamp">FUTURE TECH INTELLIGENCE</div>
      <h1 class="masthead-title">未来科技局</h1>
      <p class="masthead-sub"><span>◆</span> AI · 机器人 · 前沿科技情报聚合 <span>◆</span></p>
    </header>

    <div class="divider"><div class="divider-diamond"></div></div>

    ${tickerItems ? `<div class="ticker-strip"><div class="ticker-content">${tickerItems}${tickerItems}</div></div>` : ""}

    ${bannerHTML}

    <nav class="filters">
      <a href="/" class="filter-btn${activeCategory ? "" : " active"}">全部</a>
      ${filterLinks}
    </nav>

    <main class="news-list">
      ${
        news.length
          ? newsCards
          : `<div class="empty-state">
          <div class="empty-state-icon">◆ NO SIGNAL ◆</div>
          <p>情报通道暂无数据，请稍后再来</p>
        </div>`
      }
    </main>

    <footer>
      <div class="footer-inner">
        <div class="footer-sources">数据来源 TechCrunch · VentureBeat · The Robot Report · Instapaper</div>
        <div class="footer-meta">每 30 分钟更新 · 部署于 <a href="https://developers.cloudflare.com/workers/" target="_blank">Cloudflare Workers</a></div>
      </div>
      <div class="footer-stamp">未来科技局 — CLASSIFIED INTELLIGENCE BUREAU</div>
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
