// Vercel Edge Function: catch-all proxy for ESPN's core API.
//
// File path: api/espn-core/[...path].js  →  matches /api/espn-core/<anything>/<here>
// Forwards to https://sports.core.api.espn.com/<same-path>
//
// We set a real browser User-Agent because ESPN sometimes returns 403 to
// bare server-side User-Agents from datacenter IPs.

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const url = new URL(request.url);
  // url.pathname is like "/api/espn-core/v2/sports/basketball/leagues/nba/..."
  const path = url.pathname.replace(/^\/api\/espn-core\/?/, "");
  const target = `https://sports.core.api.espn.com/${path}${url.search}`;

  try {
    const upstream = await fetch(target, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.espn.com/",
      },
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "proxy_failed", target, message: String((err && err.message) || err) }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}
