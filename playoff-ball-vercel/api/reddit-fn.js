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
// Multi-target: we try old.reddit.com first (tends to be more permissive
// under the same rate-limit conditions as www.reddit.com), then fall back
// to www.reddit.com. Both return identical Listing JSON.

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const url = new URL(request.url);
  const sub   = (url.searchParams.get("sub")   || "nba").replace(/[^a-zA-Z0-9_]/g, "");
  const limit = (url.searchParams.get("limit") || "15").replace(/[^0-9]/g, "") || "15";

  const targets = [
    `https://old.reddit.com/r/${sub}/hot.json?limit=${limit}`,
    `https://www.reddit.com/r/${sub}/hot.json?limit=${limit}`,
  ];

  const headers = {
    // A unique, non-browser-looking UA. Reddit accepts most unique strings.
    // Fixed: URL now matches actual deployed domain.
    "User-Agent": "PlayoffBall/1.0 (+https://playoff-ball.vercel.app) by anonymous",
    "Accept": "application/json",
  };

  let lastStatus = 502;

  for (const target of targets) {
    try {
      const res = await fetch(target, { headers });

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

      // Remember the status for the error response, then try next target.
      lastStatus = res.status;
    } catch (_err) {
      // Network error — try next target.
    }
  }

  // All targets failed.
  return new Response(
    JSON.stringify({ error: "reddit_upstream", status: lastStatus }),
    {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
      },
    }
  );
}
