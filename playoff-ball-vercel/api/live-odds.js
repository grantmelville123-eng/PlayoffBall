// Vercel Edge Function: live NBA odds via The Odds API.
//
// File path → URL: this file → /api/live-odds
//
// ARCHITECTURE
// ------------
// - The API key is held server-side only (process.env.THE_ODDS_API_KEY),
//   set in the Vercel dashboard under Settings → Environment Variables.
//   The browser never sees it.
// - 5-minute cache via Cache-Control headers (Vercel's edge CDN respects
//   s-maxage), so repeat visitors don't burn quota.
// - We pass through The Odds API's X-Requests-* headers so the browser
//   (and you, in DevTools) can see remaining quota in real time.
//
// QUOTA NOTES (free tier = 500 credits/month)
// -------------------------------------------
// Each request costs (number_of_markets) credits. We request 2 markets
// (spreads, totals) → 2 credits per fetch.
// With 5-min edge caching: 12 fetches/hour max → 24 credits/hour.

export const config = { runtime: 'edge' };

const SPORT       = "basketball_nba";
const REGIONS     = "us";
const MARKETS     = "spreads,totals";
const BOOKMAKERS  = "draftkings,fanduel";
const ODDS_FORMAT = "american";

export default async function handler(request) {
  const apiKey = (typeof process !== "undefined" && process.env && process.env.THE_ODDS_API_KEY) || "";

  if (!apiKey) {
    return jsonResponse(
      { error: "no_api_key", message: "THE_ODDS_API_KEY env var is not set on this Vercel project." },
      503,
      { "Cache-Control": "public, max-age=60" }
    );
  }

  const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds`
            + `?apiKey=${encodeURIComponent(apiKey)}`
            + `&regions=${REGIONS}`
            + `&markets=${MARKETS}`
            + `&bookmakers=${BOOKMAKERS}`
            + `&oddsFormat=${ODDS_FORMAT}`;

  try {
    const upstream = await fetch(url, { headers: { "Accept": "application/json" } });

    const remaining = upstream.headers.get("x-requests-remaining") || "";
    const used      = upstream.headers.get("x-requests-used")      || "";
    const lastCost  = upstream.headers.get("x-requests-last")      || "";

    if (!upstream.ok) {
      const text = await upstream.text();
      return jsonResponse(
        { error: "upstream", status: upstream.status, body: text.slice(0, 500) },
        upstream.status,
        {
          "X-Odds-Remaining": remaining,
          "X-Odds-Used":      used,
          "X-Odds-Last-Cost": lastCost,
        }
      );
    }

    const text = await upstream.text();
    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type":  "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
        "X-Odds-Remaining": remaining,
        "X-Odds-Used":      used,
        "X-Odds-Last-Cost": lastCost,
      },
    });
  } catch (err) {
    return jsonResponse(
      { error: "fetch_failed", message: String((err && err.message) || err) },
      502
    );
  }
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
