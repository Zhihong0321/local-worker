#!/usr/bin/env node
/**
 * linkedin.mjs — LinkedIn enrichment via the agent-reach LinkedIn channel.
 *
 * The channel is `mcp-server-linkedin` wired into mcporter as the `linkedin`
 * MCP server. This script shells out to `mcporter call linkedin.<tool>` and
 * reduces the (very large) MCP payload to a compact, deterministic structure
 * so the agent never has to ingest a whole activity feed.
 *
 * Usage:
 *   node linkedin.mjs status
 *   node linkedin.mjs person   <linkedin-username>
 *   node linkedin.mjs search   <keywords...> [--location X] [--company X]
 *   node linkedin.mjs company  <company-name>
 *   node linkedin.mjs employees <company-name> [--keywords X]
 *   node linkedin.mjs sidebar  <linkedin-username>
 *
 * Output: JSON on stdout.
 *   { ok, tool, ... } on success
 *   { ok:false, error, hint } on failure (e.g. session expired)
 *
 * Requires (installed by the LinkedIn channel setup):
 *   - uvx on PATH                       (%APPDATA%\Python\Python312\Scripts)
 *   - mcporter on PATH                  (%APPDATA%\Roaming\npm)
 *   - a valid LinkedIn session          (~/.linkedin-mcp/profile)
 *     (re-login: run  linkedin-login.cmd  )
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Resolve mcporter even when it is not on the inherited PATH (Windows global
// npm bin + user Python Scripts are the usual locations).
// ---------------------------------------------------------------------------
function resolveBin(name) {
  const candidates = [];
  const exe = process.platform === "win32" ? `${name}.cmd` : name;
  const plain = process.platform === "win32" ? `${name}.exe` : name;
  const home = homedir();
  candidates.push(
    join(home, "AppData", "Roaming", "npm", exe),
    join(home, "AppData", "Roaming", "npm", name),
    join(home, "AppData", "Roaming", "Python", "Python312", "Scripts", plain),
    join(home, ".local", "bin", name),
  );
  for (const c of candidates) if (existsSync(c)) return c;
  return name; // fall back to PATH lookup
}

const MCPORTER = resolveBin("mcporter");

function runBin(bin, argv, opts = {}) {
  const useShell = process.platform === "win32" && (/\.(cmd|bat)$/i.test(bin) || bin === MCPORTER);
  return spawnSync(useShell ? `"${bin}"` : bin, argv, {
    encoding: "utf8",
    shell: useShell,
    ...opts,
  });
}

function callTool(tool, args = {}) {
  const argv = ["call", `linkedin.${tool}`];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === "") continue;
    argv.push(`--${k}`, String(v));
  }
  const r = runBin(MCPORTER, argv, {
    encoding: "utf8",
    timeout: 240000,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PATH: [
        join(homedir(), "AppData", "Roaming", "Python", "Python312", "Scripts"),
        join(homedir(), "AppData", "Roaming", "npm"),
        process.env.PATH || "",
      ].join(process.platform === "win32" ? ";" : ":"),
    },
  });
  const out = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();
  if (r.status !== 0 || !out) {
    const combined = `${out}\n${err}`.trim();
    const needsLogin = /no valid source session|session (is )?(invalid|expired)|not logged in|--login/i.test(
      combined,
    );
    return {
      ok: false,
      tool,
      error: combined.slice(0, 600) || `mcporter exited ${r.status} signal=${r.signal || "-"}`,
      status: r.status,
      signal: r.signal || undefined,
      hint: needsLogin
        ? "LinkedIn session missing/expired. Run linkedin-login.cmd (or: node <skill>/scripts/linkedin.mjs status) then re-login."
        : /command not found|ENOENT|not recognized/i.test(combined)
          ? "mcporter or uvx not found. See SKILL.md → LinkedIn channel setup."
          : undefined,
    };
  }
  // mcporter prints a JSON object; tolerate a leading banner line.
  const start = out.indexOf("{");
  if (start < 0) return { ok: false, tool, error: out.slice(0, 600) };
  try {
    return { ok: true, tool, raw: JSON.parse(out.slice(start)) };
  } catch (e) {
    return { ok: false, tool, error: `parse error: ${e.message}`, raw: out.slice(0, 600) };
  }
}

// ---------------------------------------------------------------------------
// Reducers — turn the giant MCP text blobs into compact structures.
// ---------------------------------------------------------------------------

/** Parse LinkedIn search-result / employee text. The server emits a flat
 * sequence of paragraphs: "<Name> • <degree>", "<Headline>", "<Location>",
 * then possibly "Current: ..." lines, separated by blank lines. */
function parsePeopleText(text) {
  if (!text) return [];
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out = [];
  const DEGREE_RE = / • \d(?:st|nd|rd|th)\+?$/;
  for (let i = 0; i < paras.length; i++) {
    if (!DEGREE_RE.test(paras[i])) continue;
    const name = paras[i].replace(DEGREE_RE, "").trim();
    if (!name || /^LinkedIn Member$/i.test(name)) continue;
    const headline = paras[i + 1] && !DEGREE_RE.test(paras[i + 1]) ? paras[i + 1] : "";
    const location = paras[i + 2] && !DEGREE_RE.test(paras[i + 2]) && !/^Connect$/i.test(paras[i + 2]) ? paras[i + 2] : "";
    let current = "";
    for (let k = i + 1; k < Math.min(i + 5, paras.length); k++) {
      const m = paras[k].match(/^Current:\s*(.+)$/i);
      if (m) {
        current = m[1].trim();
        break;
      }
    }
    out.push({ name, headline, location, current });
  }
  return out;
}

function extractUrlFromError(err) {
  const m = String(err || "").match(/https?:\/\/(?:www\.)?linkedin\.com\/[^\s"\\]+/);
  return m ? m[0] : "";
}

function personRefs(refs, kind = "person") {
  return (refs || [])
    .filter((r) => r.kind === kind && r.url)
    .map((r) => ({ name: (r.text || "").trim(), url: `https://www.linkedin.com${r.url}` }));
}

function status() {
  const bin = resolveBin("uvx");
  const r = runBin(
    bin,
    [
      "mcp-server-linkedin@latest",
      "--installer-temp-dir",
      join(homedir(), ".linkedin-mcp", "installer-tmp"),
      "--status",
    ],
    {
      encoding: "utf8",
      timeout: 180000,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    },
  );
  const text = `${r.stdout || ""}${r.stderr || ""}`.trim();
  const valid = /Session is valid/i.test(text);
  const profileDir = join(homedir(), ".linkedin-mcp", "profile");
  return {
    ok: valid,
    tool: "status",
    session_valid: valid,
    profile_dir: profileDir,
    profile_exists: existsSync(profileDir),
    detail: text.split("\n").slice(-3).join("\n"),
    hint: valid ? undefined : "Run linkedin-login.cmd to create a session.",
  };
}

// ---------------------------------------------------------------------------
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
    } else positional.push(rest[i]);
  }

  let res;
  switch (cmd) {
    case "status":
      return emit(status());

    case "person": {
      const username = positional[0];
      if (!username) return emit({ ok: false, error: "usage: person <linkedin-username>" });
      const r = callTool("get_person_profile", { linkedin_username: username });
      if (!r.ok) return emit(r);
      const s = r.raw.sections || {};
      const main = s.main_profile || "";
      const name = (main.split("\n").find((l) => l.trim()) || "").trim();
      const headline = (main.split("\n").find((l) => /CEO|Director|Manager|Head|Founder|Engineer|@/i.test(l)) || "").trim();
      const location = (main.split("\n").find((l) => /Malaysia|Kuala|Selangor|Penang|Johor|Singapore/i.test(l)) || "").trim();
      return emit({
        ok: true,
        tool: "get_person_profile",
        url: r.raw.url,
        name,
        headline,
        location,
        about: (main.match(/About\n+([\s\S]*?)\n+… more/) || [])[1]?.slice(0, 1200) || "",
        references: personRefs(r.raw.references?.main_profile),
      });
    }

    case "search": {
      const keywords = positional.join(" ").trim();
      if (!keywords) return emit({ ok: false, error: "usage: search <keywords> [--location X] [--company X]" });
      const args = { keywords };
      if (flags.location) args.location = flags.location;
      if (flags.company) args.current_company = flags.company;
      if (flags.network) args.network = flags.network;
      const r = callTool("search_people", args);
      if (!r.ok) return emit(r);
      const text = r.raw.sections?.search_results || "";
      return emit({
        ok: true,
        tool: "search_people",
        url: r.raw.url,
        keywords,
        people: parsePeopleText(text),
        profiles: personRefs(r.raw.references?.search_results),
      });
    }

    case "company": {
      const name = positional.join(" ").trim();
      if (!name) return emit({ ok: false, error: "usage: company <company-name>" });
      const r = callTool("get_company_profile", { company_name: name });
      // Guard (must run even when the tool reports failure — an '&' produces a
      // wrong-company slug and a non-success status): names containing
      // '&', '/', '.' make the upstream tool slugify to the first token
      // ("A&O Frozen Mart" -> "A"), returning an unrelated company.
      const firstToken = name.split(/[\s&/,.-]+/).filter(Boolean)[0] || "";
      const detectedUrl = String(r.raw?.url || "") || extractUrlFromError(r.error) || "";
      const slug = (detectedUrl.match(/\/company\/([^/?#]+)/) || [])[1] || "";
      const brokenSlug = !!slug && slug.toLowerCase() === firstToken.toLowerCase() && name.replace(/\s/g, "").length > slug.length + 1;
      if (brokenSlug) {
        return emit({
          ok: false,
          tool: "get_company_profile",
          error: `company slug resolved to "${slug}" from "${name}" — name contains '&'/'/'/'.' and is not usable as a LinkedIn slug`,
          hint: "Search people by name instead, or pass a slug you know (e.g. company 'solarvest'). LinkedIn has no reliable page for this name.",
        });
      }
      if (!r.ok) return emit(r);
      const refs = r.raw.references || {};
      const urn = Object.values(refs)
        .flat()
        .find((x) => x && x.kind === "company_urn");
      return emit({
        ok: true,
        tool: "get_company_profile",
        url: detectedUrl,
        company_urn: urn?.value || "",
        sections: Object.fromEntries(
          Object.entries(r.raw.sections || {}).map(([k, v]) => [k, String(v).slice(0, 1500)]),
        ),
        references: personRefs(refs.main_profile),
      });
    }

    case "employees": {
      const name = positional.join(" ").trim();
      if (!name) return emit({ ok: false, error: "usage: employees <company-name> [--keywords X]" });
      const args = { company_name: name };
      if (flags.keywords) args.keywords = flags.keywords;
      const r = callTool("get_company_employees", args);
      if (!r.ok) return emit(r);
      const text = r.raw.sections?.employees || "";
      const refs = r.raw.references?.employees || [];
      // The numeric company URN (needed for search_people --company).
      const urn = (refs.find((x) => x.kind === "company_urn") || {}).value || "";
      // Employee rows here are anonymised ("LinkedIn Member" + headline).
      const paras = text
        .split(/\n{2,}/)
        .map((p) => p.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const headlines = [];
      for (let i = 0; i < paras.length; i++) {
        if (/^LinkedIn Member$/i.test(paras[i]) && paras[i + 1]) headlines.push(paras[i + 1]);
      }
      return emit({
        ok: true,
        tool: "get_company_employees",
        url: r.raw.url,
        company_urn: urn,
        demographics: text.slice(0, text.indexOf("How you are connected") > 0 ? text.indexOf("How you are connected") : 2000),
        anonymised_headlines: headlines,
        note: "Employee list is anonymised by LinkedIn here; use `search <keywords> --company <urn>` for named people.",
      });
    }

    case "sidebar": {
      const username = positional[0];
      if (!username) return emit({ ok: false, error: "usage: sidebar <linkedin-username>" });
      const r = callTool("get_sidebar_profiles", { linkedin_username: username });
      if (!r.ok) return emit(r);
      const refs = r.raw.references || {};
      const profiles = [];
      for (const [k, v] of Object.entries(refs)) {
        if (Array.isArray(v)) profiles.push(...personRefs(v));
      }
      return emit({
        ok: true,
        tool: "get_sidebar_profiles",
        url: r.raw.url,
        profiles,
        note: profiles.length ? undefined : "Server returned no sidebar profiles for this member.",
      });
    }

    default:
      return emit({
        ok: false,
        error: `unknown command: ${cmd || "(none)"}`,
        usage: [
          "status",
          "person <linkedin-username>",
          "search <keywords...> [--location X] [--company X] [--network F|S|O]",
          "company <company-name>",
          "employees <company-name> [--keywords X]",
          "sidebar <linkedin-username>",
        ],
      });
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(obj.ok ? 0 : 1);
}

main();