#!/usr/bin/env node
/**
 * recon.mjs — fast, target-agnostic company contact recon.
 *
 * Fetches a domain's common contact/team/leadership pages in parallel and
 * extracts contacts deterministically (no LLM round-trips).
 *
 * Usage:
 *   node recon.mjs <domain-or-url> [extra-url ...]
 *   node recon.mjs solsenergy.com https://www.sols247.com/leadership
 *
 * Output: JSON on stdout:
 *   { target, pages:[{url,status,title,textChars}], emails:[], phones:[],
 *     socials:{}, candidatePages:[], pdfLinks:[], annualReport?:{} }
 *
 * Flags:
 *   --no-pdf   Skip auto-extracting the annual-report PDF.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const COMMON_PATHS = [
  "/",
  "/contact",
  "/contact-us",
  "/support",
  "/our-team",
  "/team",
  "/leadership",
  "/management",
  "/about",
  "/about-us",
  "/careers",
  "/investor-relations",
  "/investor-relations/corporate-info",
  "/corporate-info",
  "/board-of-directors",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone candidates: require a leading + OR a local/CC prefix, and 8-15 digits.
// Anchored on word boundaries so dates and registration numbers are rejected.
const PHONE_RE =
  /(?:\+\d[\d\s().-]{7,}\d)|(?:\b0\d[\d\s().-]{6,}\d)|(?:\b(?:60|62|65|66|84|91|92|93|94|95|880)\d[\d\s().-]{6,}\d)/g;
// Reject obvious non-phones (dates, registration numbers, years).
const PHONE_BLOCK = [
  /^20\d{10,}$/, // MY company registration (e.g. 201701007142)
  /^(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}$/, // dates
  /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/,
];
const SOCIAL_RES = {
  linkedin_person: /https?:\/\/[a-z]{0,3}\.?linkedin\.com\/in\/[A-Za-z0-9_-]+/gi,
  linkedin_company: /https?:\/\/[a-z]{0,3}\.?linkedin\.com\/company\/[A-Za-z0-9_-]+/gi,
  whatsapp: /https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send\/?\?phone=)[0-9]+/gi,
  facebook: /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9._-]+/gi,
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._-]+/gi,
};

function normaliseUrl(input) {
  if (/^https?:\/\//i.test(input)) return input;
  return "https://" + input.replace(/^\/+/, "");
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function titleOf(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/\s+/g, " ").trim()) : "";
}

/** Normalise a raw phone string to E.164 when the country is clear. */
function toE164(raw, defaultCc = "60") {
  let s = raw.replace(/[^\d+]/g, "");
  if (!s) return "";
  if (s.startsWith("+")) return s;
  if (s.startsWith("00")) return "+" + s.slice(2);
  // Malaysia local mobile e.g. 0183999247 -> +60183999247
  if (/^0\d{8,10}$/.test(s)) return "+" + defaultCc + s.slice(1);
  // Already country-coded without plus e.g. 60183999247
  if (s.startsWith(defaultCc) && s.length >= 11) return "+" + s;
  return s.length >= 9 ? "+" + s : "";
}

async function fetchPage(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": UA, accept: "text/html,*/*" },
    });
    const html = await res.text();
    return { url: res.url, status: res.status, html };
  } catch (err) {
    return { url, status: 0, html: "", error: String(err.message || err) };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const flags = new Set(rawArgs.filter((a) => a.startsWith("--")));
  const args = rawArgs.filter((a) => !a.startsWith("--"));
  if (args.length === 0) {
    console.error("Usage: node recon.mjs <domain-or-url> [extra-url ...] [--no-pdf]");
    process.exit(1);
  }

  const first = normaliseUrl(args[0]);
  const origin = originOf(first);
  const explicit = args.slice(1).map(normaliseUrl);

  const targets = new Set();
  if (explicit.length > 0) {
    targets.add(first);
    explicit.forEach((u) => targets.add(u));
  } else {
    for (const p of COMMON_PATHS) targets.add(origin + p);
  }

  const results = await Promise.all([...targets].map((u) => fetchPage(u)));

  const emails = new Set();
  const phones = new Map(); // e164 -> {raw, sources:Set}
  const socials = {};
  const pages = [];
  const candidatePages = [];
  const pdfLinks = new Set();

  for (const r of results) {
    if (!r.html) {
      pages.push({ url: r.url, status: r.status, error: r.error || "no body" });
      continue;
    }
    const text = stripHtml(r.html);
    pages.push({
      url: r.url,
      status: r.status,
      title: titleOf(r.html),
      textChars: text.length,
    });

    for (const m of r.html.match(EMAIL_RE) || []) {
      const e = m.toLowerCase();
      if (e.endsWith(".png") || e.endsWith(".jpg")) continue;
      emails.add(e);
    }

    for (const m of text.match(PHONE_RE) || []) {
      const digits = m.replace(/\D/g, "");
      if (digits.length < 8 || digits.length > 15) continue;
      if (PHONE_BLOCK.some((re) => re.test(digits))) continue;
      // Require a plausible phone shape: starts with +, a local 0, or a known CC.
      const compact = m.trim();
      if (!/^(?:\+|0|60|62|65|66|84|91|92|93|94|95|880)/.test(compact.replace(/[\s().-]/g, "")))
        continue;
      const e164 = toE164(m);
      if (!e164 || e164.length < 10 || e164.length > 16) continue;
      const rec = phones.get(e164) || { raw: m.trim(), sources: new Set() };
      rec.sources.add(r.url);
      phones.set(e164, rec);
    }

    for (const [key, re] of Object.entries(SOCIAL_RES)) {
      for (const m of r.html.match(re) || []) {
        (socials[key] ||= new Set()).add(m.replace(/\/$/, ""));
      }
    }

    // Flag pages likely to hold people/contacts, for browser follow-up.
    const lc = (r.url + " " + text.slice(0, 2000)).toLowerCase();
    if (/(our team|leadership|management|director|founder|ceo|contact)/.test(lc)) {
      candidatePages.push(r.url);
    }

    // Collect annual-report / registry PDF links for the follow-up pipeline.
    for (const m of r.html.match(/href=["']([^"']+\.pdf)["']/gi) || []) {
      const href = m.replace(/^href=["']/i, "").replace(/["']$/, "");
      let abs;
      try {
        abs = new URL(href, r.url).href;
      } catch {
        continue;
      }
      if (/annual[-_ ]?report|ar\d{4}|corporate|governance|integrated/i.test(abs) ) {
        pdfLinks.add(abs);
      }
    }
  }

  const out = {
    target: first,
    pages,
    emails: [...emails].sort(),
    phones: [...phones.entries()].map(([e164, v]) => ({
      number_e164: e164,
      number_raw: v.raw,
      sources: [...v.sources],
    })),
    socials: Object.fromEntries(
      Object.entries(socials).map(([k, v]) => [k, [...v].sort()]),
    ),
    candidatePages,
    pdfLinks: [...pdfLinks].sort(),
  };

  // Auto-run the PDF pipeline on the most likely annual report, when present.
  if (pdfLinks.size > 0 && !flags.has("--no-pdf")) {
    const pdfScript = fileURLToPath(new URL("./pdf-contacts.mjs", import.meta.url));
    const candidates = [...pdfLinks].sort(
      (a, b) => /annual[-_ ]?report/i.test(b) - /annual[-_ ]?report/i.test(a),
    );
    try {
      const r = spawnSync(process.execPath, [pdfScript, candidates[0]], {
        encoding: "utf8",
        timeout: 120000,
      });
      if (r.status === 0 && r.stdout) out.annualReport = JSON.parse(r.stdout);
    } catch {
      /* best-effort */
    }
  }

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main();
