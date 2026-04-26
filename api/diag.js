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

  if (wantJson) return jsonReport(hasOddsKey);
  return htmlShell(hasOddsKey);
}

/* ───────────── JSON report ───────────── */

async function jsonReport(hasOddsKey) {
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
      try {
        const txt = (await r.text()).slice(0, 200);
        bodyHint = txt.replace(/\s+/g, " ").trim();
      } catch (_) {}
      return {
        label, target,
        ok: r.ok,
        status: r.status,
        contentType: r.headers.get("content-type") || "",
        bodyHint,
      };
    } catch (e) {
      return { label, target, ok: false, error: errString(e) };
    }
  }

  const [odds, leaders, injuries, scoreboard] = await Promise.all([
    pingOdds(),
    ping("ESPN core (leaders)",       "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2026/types/3/leaders"),
    // Per-team URL — pinged for the Lakers (id=13) just to verify the route is alive.
    // The frontend fans out across all visible teams.
    ping("ESPN site (injuries, sample team)", "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/13/injuries"),
    ping("ESPN site (scoreboard)",    "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"),
  ]);

  const report = {
    deployedAt: new Date().toISOString(),
    envVars: { THE_ODDS_API_KEY_set: hasOddsKey },
    upstreams: { odds, leaders, injuries, scoreboard },
    hint: !hasOddsKey
      ? "Env var missing. Add THE_ODDS_API_KEY in Vercel → Project Settings → Environment Variables, then trigger a NEW deployment."
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
      <tr><td>The Odds API</td><td><span class="badge pending">…</span></td><td class="mono">checking</td><td class="muted">contacting upstream</td></tr>
      <tr><td>ESPN core (leaders)</td><td><span class="badge pending">…</span></td><td class="mono">checking</td><td class="muted">contacting upstream</td></tr>
      <tr><td>ESPN web (injuries)</td><td><span class="badge pending">…</span></td><td class="mono">checking</td><td class="muted">contacting upstream</td></tr>
      <tr><td>ESPN site (scoreboard)</td><td><span class="badge pending">…</span></td><td class="mono">checking</td><td class="muted">contacting upstream</td></tr>
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
        row("The Odds API",            u.odds)
      + row("ESPN core (leaders)",     u.leaders)
      + row("ESPN web (injuries)",     u.injuries)
      + row("ESPN site (scoreboard)",  u.scoreboard);
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
