// Vercel Edge Function: deployment diagnostics dashboard.
//
// /api/diag       → HTML dashboard (shell + client-side loader)
// /api/diag?json  → JSON status report (8s timeout per upstream)
//
// Renders the HTML shell IMMEDIATELY (no upstream fetches). The page then
// calls /api/diag?json client-side to populate each row. A hung upstream
// can never blank out the whole page.

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const url = new URL(request.url);
  const wantJson = url.searchParams.has("json");
  const hasOddsKey = !!(typeof process !== "undefined" && process.env && process.env.THE_ODDS_API_KEY);

  if (wantJson) return jsonReport(hasOddsKey, request);
  return htmlShell(hasOddsKey);
}

/* ───────────── JSON report ───────────── */

async function jsonReport(hasOddsKey, request) {
  // Wrap the entire report in a try/catch so any unexpected error still returns
  // valid JSON to the client (instead of a 500 with no body, which makes the
  // dashboard render "did not match the expected pattern" from JSON.parse).
  try {
    return await buildJsonReport(hasOddsKey, request);
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: "diag_internal_error",
        message: errString(e),
        deployedAt: new Date().toISOString(),
      }, null, 2),
      { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }
    );
  }
}

async function buildJsonReport(hasOddsKey, request) {
  const browserHeaders = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.espn.com/",
  };

  async function timedFetch(target, headers, ms = 8000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(target, { headers, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function pingOdds() {
    if (!hasOddsKey) {
      return { ok: false, status: null, note: "THE_ODDS_API_KEY env var is NOT set on this deployment." };
    }
    const u = `https://api.the-odds-api.com/v4/sports/?apiKey=${encodeURIComponent(process.env.THE_ODDS_API_KEY)}`;
    try {
      const r = await timedFetch(u, { "Accept": "application/json" });
      return {
        ok: r.ok,
        status: r.status,
        remaining: r.headers.get("x-requests-remaining") || null,
        used: r.headers.get("x-requests-used") || null,
        note: r.ok
          ? "API key valid."
          : `HTTP ${r.status} — ${r.status === 401 ? "key invalid or not yet activated by The Odds API." : "unexpected upstream response."}`,
      };
    } catch (e) {
      return { ok: false, status: null, error: errString(e) };
    }
  }

  async function ping(label, target) {
    try {
      const r = await timedFetch(target, browserHeaders);
      let bodyHint = "";
      let bodySize = 0;
      let injuryCount = null;
      try {
        const fullTxt = await r.text();
        bodySize = fullTxt.length;
        bodyHint = fullTxt.slice(0, 200).replace(/\s+/g, " ").trim();
        // If this looks like an injuries endpoint, count entries so we can see
        // which URL actually returns data.
        if (/injuries/i.test(target)) {
          try {
            const j = JSON.parse(fullTxt);
            // site v2:   { injuries: [{athletes:[...]}, ...] } OR { injuries: [...] }
            // site web:  { items: [...] }
            // core v2:   { items: [...] }
            let n = 0;
            if (Array.isArray(j.injuries)) {
              for (const w of j.injuries) {
                if (Array.isArray(w.athletes)) n += w.athletes.length;
                else n += 1;
              }
            } else if (Array.isArray(j.items)) {
              n = j.items.length;
            }
            injuryCount = n;
          } catch (_) {}
        }
      } catch (_) {}
      return {
        label, target,
        ok: r.ok,
        status: r.status,
        contentType: r.headers.get("content-type") || "",
        bodySize,
        injuryCount,
        bodyHint,
      };
    } catch (e) {
      return { label, target, ok: false, error: errString(e) };
    }
  }

  const SAMPLE_TEAM_ID = "13"; // Lakers — used purely to verify the route is alive.
  // Derive our own origin defensively. If anything's odd we fall back to a
  // relative path; fetch() in Edge requires absolute URLs but we'd rather have
  // one bad row than a 500 that breaks the whole dashboard.
  let selfOrigin = "";
  try { selfOrigin = new URL(request.url).origin; } catch (_) {}

  const [odds, leaders, leadersProxy, injSiteV2, injSiteWeb, injCore, injProxy, scoreboard] = await Promise.all([
    pingOdds(),
    ping("ESPN core (leaders, direct)",
      "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2026/types/3/leaders"),
    // Same path, through the Vercel catch-all proxy — verifies routing is intact.
    selfOrigin
      ? ping("ESPN core (leaders, via proxy)",
          `${selfOrigin}/api/espn-core/v2/sports/basketball/leagues/nba/seasons/2026/types/3/leaders`)
      : Promise.resolve({ label: "ESPN core (leaders, via proxy)", ok: false, error: "could not derive own origin" }),
    ping("Injuries — site v2 (per-team)",
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${SAMPLE_TEAM_ID}/injuries`),
    ping("Injuries — site web common v3 (per-team)",
      `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/teams/${SAMPLE_TEAM_ID}/injuries`),
    ping("Injuries — core v2 (per-team)",
      `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/teams/${SAMPLE_TEAM_ID}/injuries?limit=50`),
    selfOrigin
      ? ping("Injuries — site v2 via proxy",
          `${selfOrigin}/api/espn-site/apis/site/v2/sports/basketball/nba/teams/${SAMPLE_TEAM_ID}/injuries`)
      : Promise.resolve({ label: "Injuries — site v2 via proxy", ok: false, error: "could not derive own origin" }),
    ping("ESPN site (scoreboard)",
      "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"),
  ]);

  const anyInjuriesWork =
    (injSiteV2 && injSiteV2.injuryCount > 0) ||
    (injSiteWeb && injSiteWeb.injuryCount > 0) ||
    (injCore && injCore.injuryCount > 0);

  const report = {
    deployedAt: new Date().toISOString(),
    envVars: { THE_ODDS_API_KEY_set: hasOddsKey },
    upstreams: {
      odds,
      leaders,
      leadersProxy,
      injSiteV2,
      injSiteWeb,
      injCore,
      injProxy,
      scoreboard,
    },
    hint: !hasOddsKey
      ? "Env var missing. Add THE_ODDS_API_KEY in Vercel → Project Settings → Environment Variables, then trigger a NEW deployment."
      : !anyInjuriesWork
        ? "Heads up: every injury endpoint returned 0 entries for the sample team. ESPN may have an empty roster for that team in the off-season, or the per-team injuries product is currently empty league-wide."
        : (odds && odds.ok ? "All systems look healthy." : "Env var is set but Odds API rejected the request — see odds.note above."),
  };

  return new Response(JSON.stringify(report, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function errString(e) {
  if (!e) return "unknown error";
  if (e.name === "AbortError") return "timed out after 8s";
  return String((e && e.message) || e);
}

/* ───────────── HTML shell ───────────── */

function htmlShell(hasOddsKey) {
  const envBadge = hasOddsKey
    ? `<span class="badge ok">SET</span>`
    : `<span class="badge fail">MISSING</span>`;
  const envNote = hasOddsKey
    ? "Variable is visible to this Function."
    : "Variable is NOT visible. Add it in Vercel → Project Settings → Environment Variables, then trigger a new deployment.";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Playoff Ball — Diagnostics</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { background:#111; color:#eee; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; margin:0; padding:24px; }
  h1 { font-size:22px; margin:0 0 8px; }
  h2 { font-size:14px; margin:24px 0 8px; color:#9ec5ff; text-transform:uppercase; letter-spacing:0.5px; }
  table { border-collapse:collapse; width:100%; max-width:900px; }
  th { text-align:left; padding:8px 10px; border-bottom:2px solid #444; font-size:12px; color:#888; text-transform:uppercase; }
  td { padding:10px; border-bottom:1px solid #2a2a2a; vertical-align:top; }
  pre { background:#1a1a1a; padding:12px; border-radius:6px; overflow:auto; font-size:12px; color:#bbb; max-width:900px; }
  .meta { color:#888; font-size:13px; margin-bottom:24px; }
  a { color:#9ec5ff; }
  .badge { padding:2px 8px; border-radius:4px; font-size:12px; color:#fff; font-weight:600; }
  .badge.ok   { background:#1f7a3a; }
  .badge.fail { background:#7a1f1f; }
  .badge.pending { background:#444; }
  .muted { color:#888; font-size:12px; }
  .mono  { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; color:#aaa; }
</style>
</head>
<body>
  <h1>Playoff Ball — Deployment Diagnostics</h1>
  <div class="meta">Loaded at <span id="loadedAt"></span> · <a href="?json">View raw JSON</a> · <a href="/">Back to site</a></div>

  <h2>Environment</h2>
  <table>
    <tr>
      <td><strong>THE_ODDS_API_KEY</strong></td>
      <td>${envBadge}</td>
      <td colspan="2" class="muted">${envNote}</td>
    </tr>
  </table>

  <h2>Upstreams</h2>
  <table>
    <thead><tr><th>Source</th><th>Status</th><th>HTTP</th><th>Detail</th></tr></thead>
    <tbody id="upstreams">
      <tr><td colspan="4" class="muted">Loading upstream checks…</td></tr>
    </tbody>
  </table>

  <h2>Hint</h2>
  <p style="color:#ccc;max-width:900px" id="hint">…</p>

  <h2>Raw report</h2>
  <pre id="raw">loading…</pre>

<script>
  document.getElementById("loadedAt").textContent = new Date().toLocaleString();

  function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function row(label, info){
    var ok = info && info.ok;
    var status = info && info.status != null ? "HTTP " + info.status : (info && info.error ? "error" : "—");
    var note = info ? (info.note || info.error || info.bodyHint || "") : "";
    var extras = [];
    if (info && info.remaining != null)  extras.push("Quota remaining: " + info.remaining);
    if (info && info.used      != null)  extras.push("Quota used: " + info.used);
    if (info && info.injuryCount != null) extras.push("Injury entries: " + info.injuryCount);
    if (info && info.bodySize  != null && info.bodySize > 0)  extras.push("Body size: " + info.bodySize);
    if (info && info.contentType)        extras.push("Content-Type: " + info.contentType);
    return "<tr><td><strong>" + esc(label) + "</strong></td>"
         + "<td><span class='badge " + (ok?"ok":"fail") + "'>" + (ok?"OK":"FAIL") + "</span></td>"
         + "<td class='mono'>" + esc(status) + "</td>"
         + "<td>" + esc(note) + (extras.length ? "<div class='muted' style='margin-top:4px'>" + esc(extras.join(" · ")) + "</div>" : "") + "</td></tr>";
  }

  fetch("/api/diag?json", { cache: "no-store" }).then(function(r){ return r.json(); }).then(function(report){
    document.getElementById("raw").textContent = JSON.stringify(report, null, 2);
    document.getElementById("hint").textContent = report.hint || "";
    var u = report.upstreams || {};
    document.getElementById("upstreams").innerHTML =
        row("The Odds API",                   u.odds)
      + row("Leaders (direct)",               u.leaders)
      + row("Leaders (via Vercel proxy)",     u.leadersProxy)
      + row("Injuries — site v2 (direct)",    u.injSiteV2)
      + row("Injuries — site web (direct)",   u.injSiteWeb)
      + row("Injuries — core (direct)",       u.injCore)
      + row("Injuries — site v2 (proxy)",     u.injProxy)
      + row("ESPN scoreboard",                u.scoreboard);
  }).catch(function(e){
    document.getElementById("raw").textContent = "Failed to load /api/diag?json: " + (e && e.message ? e.message : e);
    document.getElementById("hint").textContent = "Diag JSON endpoint failed. The HTML shell loaded but the upstream check did not. Try refreshing.";
  });
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
