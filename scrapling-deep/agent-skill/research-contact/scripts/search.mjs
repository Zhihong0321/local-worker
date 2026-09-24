#!/usr/bin/env node
/**
 * search.mjs — Google search for the research-contact skill.
 *
 * ENGINE: the local `gsearch` bridge ONLY.
 *   http://127.0.0.1:18787/search  →  worker.mjs  ←WebSocket← Chrome extension
 *
 * The bridge drives the user's **real Chrome**, so Google sees a real person
 * instead of a bot: no CAPTCHA walls, no API key, no proxy. It returns the
 * actual SERP as structured JSON.
 *
 * Full contract: local-worker/scrapling-deep/gsearch-extension/AGENT.md
 *
 * USAGE
 * -----
 *   node search.mjs "<query>"                     # ~10 Google results
 *   node search.mjs "<query>" --pages 3           # up to ~30 results
 *   node search.mjs "<query>" --gl my --hl en     # country / language
 *   node search.mjs "<query>" --tbs qdr:m         # time filter (past month)
 *   node search.mjs --status                      # bridge health check
 *
 * Google operators work in `query`: site:, "exact phrase", -exclude, OR,
 * filetype:pdf, intitle:, after:YYYY-MM-DD.
 *
 * OUTPUT (stdout, one JSON object)
 *   { ok, engine, query, url, stats, results[], featured, knowledge,
 *     peopleAlsoAsk, related, took_s, duration_s, error?, stop? }
 *   results[] entries are {position, title, url, snippet}.
 *
 * EXIT CODES
 *   0 ok · 1 no results / bad request · 2 needs a human (captcha/offline)
 *
 * RULES (from AGENT.md)
 *   • Searches are serialised with a 3–6 s gap — NEVER fire them in parallel;
 *     bursts are what trigger CAPTCHAs even in a real browser.
 *   • Budget ~20–30 searches per task.
 *   • Prefer a precise query over more pages; `pages` is capped at 5.
 *   • Snippets are not the page — fetch `url` with the normal fetch tool to read it.
 *   • On `captcha` / `extension_offline`: STOP and tell the user. Both need a human.
 */

const GSEARCH_URL = process.env.GSEARCH_URL || "http://127.0.0.1:18787";
const GSEARCH_TOKEN = (process.env.GSEARCH_TOKEN || "").trim();

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const out = { query: "", pages: 1, hl: "", gl: "", tbs: "", timeout: 300, status: false };
  const parts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--status") out.status = true;
    else if (a === "--pages") out.pages = Math.min(5, Math.max(1, Number(argv[++i]) || 1));
    else if (a === "--hl") out.hl = argv[++i] || "";
    else if (a === "--gl") out.gl = argv[++i] || "";
    else if (a === "--tbs") out.tbs = argv[++i] || "";
    else if (a === "--timeout") out.timeout = Number(argv[++i]) || 300;
    else parts.push(a);
  }
  out.query = parts.join(" ").trim();
  return out;
}

/* --------------------------------------------------------------- gsearch */

async function gsearchStatus() {
  try {
    const r = await fetch(`${GSEARCH_URL}/status`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    return {
      ok: !!(j && j.listening && j.extension && j.extension.connected),
      listening: !!j?.listening,
      extension_connected: !!j?.extension?.connected,
      busy: !!j?.busy,
      queued: j?.queued ?? null,
      connected_since: j?.extension?.since ?? null,
      extension_version: j?.extension?.version ?? null,
      error: j?.listening && !j?.extension?.connected ? "extension_offline" : undefined,
    };
  } catch (err) {
    return { ok: false, error: "bridge_unreachable", detail: String(err.message || err) };
  }
}

async function runGsearch(query, opts) {
  const started = Date.now();
  const body = { query, pages: opts.pages };
  if (opts.hl) body.hl = opts.hl;
  if (opts.gl) body.gl = opts.gl;
  if (opts.tbs) body.tbs = opts.tbs;

  const headers = { "content-type": "application/json" };
  if (GSEARCH_TOKEN) headers.authorization = `Bearer ${GSEARCH_TOKEN}`;

  let res;
  try {
    res = await fetch(`${GSEARCH_URL}/search`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // A CAPTCHA can hold the request for minutes — AGENT.md says allow 300s.
      signal: AbortSignal.timeout(opts.timeout * 1000),
    });
  } catch (err) {
    return {
      ok: false,
      engine: "gsearch",
      error: "bridge_unreachable",
      detail: String(err.message || err),
      stop: "needs_human",
      duration_s: Number(((Date.now() - started) / 1000).toFixed(1)),
    };
  }

  const duration_s = Number(((Date.now() - started) / 1000).toFixed(1));
  let j = null;
  try {
    j = await res.json();
  } catch {
    /* handled below */
  }

  if (!res.ok) {
    const code = j?.code || `http_${res.status}`;
    const needsHuman = code === "captcha" || code === "extension_offline";
    return {
      ok: false,
      engine: "gsearch",
      error: code,
      detail: j?.error || `HTTP ${res.status}`,
      stop: needsHuman ? "needs_human" : undefined,
      duration_s,
    };
  }

  const results = Array.isArray(j?.results) ? j.results : [];
  return {
    ok: results.length > 0,
    engine: "gsearch",
    url: j?.url || "",
    stats: j?.stats ?? null,
    results,
    featured: j?.featured ?? null,
    knowledge: j?.knowledge ?? null,
    peopleAlsoAsk: j?.peopleAlsoAsk ?? [],
    related: j?.related ?? [],
    took_s: j?.tookMs != null ? Number((j.tookMs / 1000).toFixed(1)) : null,
    duration_s,
    error: results.length ? undefined : "no_results",
  };
}

/* ------------------------------------------------------------------ main */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.status) {
    const s = await gsearchStatus();
    process.stdout.write(JSON.stringify({ engine: "gsearch", ...s }, null, 2) + "\n");
    process.exit(s.ok ? 0 : 2);
  }

  if (!opts.query) {
    console.error(
      'Usage: node search.mjs "<query>" [--pages N] [--gl my] [--hl en] [--tbs qdr:m]\n' +
        "       [--timeout S] | --status",
    );
    process.exit(1);
  }

  const r = await runGsearch(opts.query, opts);

  if (r.ok) {
    process.stdout.write(JSON.stringify({ ...r, query: opts.query }, null, 2) + "\n");
    return;
  }

  // Needs a human (CAPTCHA / Chrome closed / extension disabled) — report it
  // clearly and stop. Retrying will not help.
  if (r.stop === "needs_human") {
    process.stdout.write(
      JSON.stringify(
        {
          ...r,
          query: opts.query,
          hint:
            r.error === "extension_offline"
              ? "Chrome is closed or the gsearch extension is disabled — enable it in chrome://extensions, then retry."
              : "Google asked for a CAPTCHA — solve it in the Chrome tab, then retry.",
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(2);
  }

  process.stdout.write(JSON.stringify({ ...r, query: opts.query }, null, 2) + "\n");
  process.exit(1);
}

main();