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

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const url = new URL(request.url);
  const sub   = (url.searchParams.get("sub")   || "nba").replace(/[^a-zA-Z0-9_]/g, "");
  const limit = (url.searchParams.get("limit") || "15").replace(/[^0-9]/g, "") || "15";
  const target = `https://www.reddit.com/r/${sub}/hot.json?limit=${limit}`;

  try {
    const res = await fetch(target, {
      headers: {
        // A unique, non-browser-looking UA. Reddit accepts most unique strings.
        "User-Agent": "PlayoffBall/1.0 (+https://playoffball.vercel.app) by anonymous",
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: "reddit_upstream", status: res.status }),
        {
          status: res.status,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=60",
          },
        }
      );
    }

    const text = await res.text();
    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "fetch_failed", message: String((err && err.message) || err) }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
