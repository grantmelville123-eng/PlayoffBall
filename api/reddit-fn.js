// Vercel Edge Function: server-side Reddit fetch via OAuth.
//
// File path determines URL: this file → /api/reddit-fn
//
// Why OAuth: Reddit blocks unauthenticated JSON API calls from shared cloud
// IP ranges (Vercel edge nodes). OAuth traffic goes through a separate
// endpoint (oauth.reddit.com) that Reddit doesn't rate-limit the same way.
//
// Required Vercel env vars (set in project Settings → Environment Variables):
//   REDDIT_CLIENT_ID     — "personal use script" client ID from reddit.com/prefs/apps
//   REDDIT_CLIENT_SECRET — secret from the same app
//
// Flow (client_credentials grant — no user login needed):
//   1. POST /api/v1/access_token with Basic auth → get a bearer token.
//   2. GET oauth.reddit.com/r/{sub}/hot with that token → get posts.
//
// Caching: 5-min Cache-Control so Vercel's edge caches the response.
// Hundreds of visitors share one cached response; Reddit only sees one
// token request + one posts request per 5-minute window per edge region.
//
// Fallback: if OAuth env vars are missing or the OAuth call fails, we
// still try the unauthenticated JSON endpoints as a last resort so the
// function degrades gracefully during setup.

export const config = { runtime: 'edge' };

const UA = "PlayoffBall/1.0 (+https://playoff-ball.vercel.app) by anonymous";

const OK_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
};

async function getOAuthToken(clientId, clientSecret) {
  // Basic auth = base64(clientId:clientSecret). btoa() is available in Edge runtime.
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("No access_token in response");
  return data.access_token;
}

export default async function handler(request) {
  const url = new URL(request.url);
  const sub   = (url.searchParams.get("sub")   || "nba").replace(/[^a-zA-Z0-9_]/g, "");
  const limit = (url.searchParams.get("limit") || "15").replace(/[^0-9]/g, "") || "15";

  // ── Phase 1: OAuth (preferred) ───────────────────────────────────────────
  const clientId     = (typeof REDDIT_CLIENT_ID     !== "undefined") ? REDDIT_CLIENT_ID     : null;
  const clientSecret = (typeof REDDIT_CLIENT_SECRET !== "undefined") ? REDDIT_CLIENT_SECRET : null;

  if (clientId && clientSecret) {
    try {
      const token = await getOAuthToken(clientId, clientSecret);
      const res = await fetch(`https://oauth.reddit.com/r/${sub}/hot?limit=${limit}&raw_json=1`, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "User-Agent": UA,
          "Accept": "application/json",
        },
      });
      if (res.ok) {
        const text = await res.text();
        return new Response(text, { status: 200, headers: OK_HEADERS });
      }
    } catch (_) {
      // OAuth failed — fall through to unauthenticated attempts.
    }
  }

  // ── Phase 2: Unauthenticated JSON (fallback / pre-setup) ─────────────────
  const jsonTargets = [
    `https://old.reddit.com/r/${sub}/hot.json?limit=${limit}`,
    `https://www.reddit.com/r/${sub}/hot.json?limit=${limit}`,
  ];
  for (const target of jsonTargets) {
    try {
      const res = await fetch(target, {
        headers: { "User-Agent": UA, "Accept": "application/json" },
      });
      if (res.ok) {
        const text = await res.text();
        return new Response(text, { status: 200, headers: OK_HEADERS });
      }
    } catch (_) { /* try next */ }
  }

  // ── All sources failed ───────────────────────────────────────────────────
  return new Response(
    JSON.stringify({ error: "reddit_upstream", message: "OAuth and unauthenticated endpoints both failed" }),
    {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
    }
  );
}
