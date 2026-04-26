// Vercel Edge Function: server-side Reddit fetch with a proper User-Agent.
//
// File path determines URL: this file → /api/reddit-fn
//
// Why this exists: Reddit aggressively blocks/rate-limits requests whose
// User-Agent looks like a default browser or library UA, especially from
// mobile Safari. This Function lets us *set* the UA to a unique string
// Reddit accepts.
//
// Caching: 5-min Cache-Control so Vercel's edge caches the JSON. Hundreds
// of visitors all share the same cached response, and we only hit Reddit
// once per 5 min — keeping us well under any per-IP rate limit.
//
// Strategy:
//   1. Try old.reddit.com JSON (tends to be more permissive than www).
//   2. Try www.reddit.com JSON.
//   3. Fall back to the Atom RSS feed — a different endpoint that sometimes
//      survives IP-level blocks that the JSON API doesn't. Posts arrive
//      without upvote/comment counts (RSS doesn't carry those), so we
//      return nulls and let the frontend render just the title + link.

export const config = { runtime: 'edge' };

// Decode the handful of HTML entities Reddit uses in RSS titles.
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

// Parse an Atom/RSS feed from Reddit into the same children-array shape
// the frontend already knows how to render. ups/num_comments are null
// because the RSS feed doesn't expose them.
function parseRss(xml) {
  const children = [];
  const entryRx = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRx.exec(xml)) !== null) {
    const block = m[1];

    // Title may be plain text or wrapped in CDATA.
    const titleM = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(block);
    const title = titleM ? decodeEntities(titleM[1].trim()) : "";

    // Atom link: <link rel="alternate" href="https://www.reddit.com/r/nba/comments/..."/>
    const linkM = /<link[^>]+href="([^"]+)"/.exec(block);
    const href = linkM ? linkM[1] : "";

    if (!title || !href) continue;

    // Normalise to a relative permalink so renderRedditItems can prepend the base URL.
    const permalink = href.replace(/^https?:\/\/(?:www\.)?reddit\.com/, "") || href;

    children.push({
      data: {
        title,
        permalink,
        ups: null,          // not in RSS
        num_comments: null, // not in RSS
        stickied: false,
      }
    });
  }
  return children;
}

export default async function handler(request) {
  const url = new URL(request.url);
  const sub   = (url.searchParams.get("sub")   || "nba").replace(/[^a-zA-Z0-9_]/g, "");
  const limit = (url.searchParams.get("limit") || "15").replace(/[^0-9]/g, "") || "15";

  const ua = "PlayoffBall/1.0 (+https://playoff-ball.vercel.app) by anonymous";

  // ── Phase 1: JSON API ────────────────────────────────────────────────────
  const jsonTargets = [
    `https://old.reddit.com/r/${sub}/hot.json?limit=${limit}`,
    `https://www.reddit.com/r/${sub}/hot.json?limit=${limit}`,
  ];

  for (const target of jsonTargets) {
    try {
      const res = await fetch(target, {
        headers: { "User-Agent": ua, "Accept": "application/json" },
      });
      if (res.ok) {
        const text = await res.text();
        return new Response(text, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
          },
        });
      }
    } catch (_) { /* try next */ }
  }

  // ── Phase 2: RSS/Atom feed ───────────────────────────────────────────────
  const rssTarget = `https://www.reddit.com/r/${sub}/hot.rss?limit=${limit}`;
  try {
    const res = await fetch(rssTarget, {
      headers: { "User-Agent": ua, "Accept": "application/atom+xml, application/rss+xml, text/xml" },
    });
    if (res.ok) {
      const xml = await res.text();
      const children = parseRss(xml);
      if (children.length) {
        return new Response(
          JSON.stringify({ data: { children }, _source: "rss" }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
            },
          }
        );
      }
    }
  } catch (_) { /* fall through to error */ }

  // ── All sources failed ───────────────────────────────────────────────────
  return new Response(
    JSON.stringify({ error: "reddit_upstream", message: "JSON and RSS endpoints both failed" }),
    {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
      },
    }
  );
}
