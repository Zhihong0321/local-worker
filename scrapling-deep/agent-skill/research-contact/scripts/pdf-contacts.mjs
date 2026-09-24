#!/usr/bin/env node
/**
 * pdf-contacts.mjs — extract decision-makers and contacts from annual
 * reports / registry PDFs (Bursa, SEC, Companies House, etc.).
 *
 * Usage:
 *   node pdf-contacts.mjs <pdf-url-or-path> [--json]
 *   node pdf-contacts.mjs https://example.com/Annual-Report-2024.pdf
 *
 * Strategy:
 *   1. If a URL, download to a temp file (raw HTTP, no browser).
 *   2. Convert to text with pdftotext -layout (fallback: -raw).
 *   3. Find the "Directors Profile" / "Key Senior Management" / "Board of
 *      Directors" sections and pull NAME + TITLE pairs.
 *   4. Regex emails / phones across the whole document.
 *
 * Output: JSON on stdout with { source, people:[{name,title,evidence:"p.N"}],
 *   emails, phones }.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Section headers that introduce people profiles.
const PEOPLE_HEADERS = [
  /directors?\s*['’]?\s*profile/i,
  /board of directors/i,
  /key senior management/i,
  /senior management (profile|team)/i,
  /management team/i,
  /executive (profile|team)/i,
  /corporate (info|information)/i,
];

// A title must contain one of these to count as a role.
const TITLE_RE =
  /\b(chief\s+\w+\s+officer|group\s+(ceo|cfo|coo|cto|cio|chief\s+\w*\s*officer|vice\s+president|managing\s+director)|managing\s+director|executive\s+director|non[- ]?independent\s+non[- ]?executive\s+director|independent\s+non[- ]?executive\s+(director|chairman)|non[- ]?executive\s+(director|chairman)|chairman|president|group\s+vice\s+president|vice\s+president|head of [a-z &]+|general manager|director|ceo|cfo|coo|cto|cio)\b/i;

// All-caps or Title-Case name token.
const NAME_RE = /\b([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){1,4})\b/;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE =
  /(?:\+\d[\d\s().-]{7,}\d)|(?:\b0\d[\d\s().-]{6,}\d)|(?:\b60\d[\d\s().-]{6,}\d)/g;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return r;
}

function toE164(raw, cc = "60") {
  let s = raw.replace(/[^\d+]/g, "");
  if (!s) return "";
  if (s.startsWith("+")) return s;
  if (s.startsWith("00")) return "+" + s.slice(2);
  if (/^0\d{8,10}$/.test(s)) return "+" + cc + s.slice(1);
  if (s.startsWith(cc) && s.length >= 11) return "+" + s;
  return s.length >= 9 ? "+" + s : "";
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf.length;
}

function pdfToText(pdfPath) {
  const base = pdfPath.replace(/\.pdf$/i, "");
  for (const mode of ["-layout", "-raw"]) {
    const r = run("pdftotext", [mode, pdfPath, base + ".txt"]);
    if (r.error) {
      throw new Error(
        "pdftotext not found. Install poppler-utils (provides pdftotext).",
      );
    }
    if (r.status === 0 && existsSync(base + ".txt")) {
      return readFileSync(base + ".txt", "utf8");
    }
  }
  throw new Error("pdftotext failed for " + pdfPath);
}

/** Page number for a character offset (pdftotext inserts \f between pages). */
function pageOf(text, offset) {
  return text.slice(0, offset).split("\f").length;
}

// Honorifics that reliably mark a person's name line.
const HONORIFIC_RE = /^(mr|mrs|ms|miss|dr|dato'?|datuk|datin|tan sri|tun|puan|encik|ir|prof|haji|hajjah)\b/i;

/**
 * Parse the numbered "Board of Directors" summary table used by many listed
 * companies, e.g.
 *     1.  Dato' Che Halin Bin Mohd Hashim     Independent Non-Executive Chairman
 *     2.  Lim Chin Siu                        Managing Director
 * Names may wrap onto continuation lines; positions sit in a right column.
 */
function extractBoardTable(text) {
  const people = [];
  const lines = text.split(/\r?\n/);

  // Find the header line containing "No. Name".
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/No\.\s+Name/i.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return people;

  // The header row often holds row 1's title in its right column, which shifts
  // every subsequent title up by one. Detect and correct that.
  const headerCols = lines[start - 1].trim().split(/\s{3,}/);
  let shiftedTitle = "";
  if (headerCols.length > 1 && TITLE_RE.test(headerCols[1])) {
    shiftedTitle = headerCols[1].trim();
  }

  const numNameRe = /^\s*(\d{1,2})[.)]?\s+(.+)$/;
  const collected = [];

  for (let i = start; i < lines.length && i < start + 140; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    if (/^(Audit Committee|Nomination|Sustainability and Risk|Additional Compliance|Statement)/i.test(raw.trim())) break;

    // Split into visual columns on runs of 3+ spaces.
    const cols = raw.trim().split(/\s{3,}/);
    const first = cols[0] || "";
    const nm = first.match(numNameRe);
    if (!nm) continue;

    const name = nm[2].replace(/\s+/g, " ").trim();
    if (name.split(" ").length < 2) continue;

    // Title: prefer the same-line right column; otherwise the next non-blank line.
    let title = (cols[1] || "").trim();
    if (!TITLE_RE.test(title)) {
      // look ahead past blank lines / annotation lines for a title line
      for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
        const cand = lines[k].trim();
        if (!cand) continue;
        if (/^(Appointed|Resigned)/i.test(cand)) continue;
        if (TITLE_RE.test(cand) && cand.length < 80 && !numNameRe.test(cand)) {
          title = cand;
        }
        break;
      }
    }
    collected.push({ name, title: title.replace(/\s+/g, " ").trim() });
  }

  // If the header carried a title, rotate titles down by one (row 1 gets the
  // header title; each later row keeps its own).
  if (shiftedTitle && collected.length > 0) {
    const titles = [shiftedTitle, ...collected.slice(0, -1).map((p) => p.title)];
    collected.forEach((p, idx) => {
      p.title = titles[idx] || p.title;
    });
  }

  for (const p of collected) {
    const titleMatch = p.title.match(TITLE_RE);
    people.push({
      name: p.name,
      title: titleMatch ? p.title : p.title,
      evidence: "board table",
    });
  }

  // Deduplicate by name, keeping the longest (most complete) title.
  const byKey = new Map();
  for (const p of people) {
    const k = p.name.toLowerCase().replace(/[^a-z ]/g, "").trim();
    const prev = byKey.get(k);
    if (!prev || (p.title || "").length > (prev.title || "").length) byKey.set(k, p);
  }
  return [...byKey.values()];
}

/** Is this line a person's name (ALL-CAPS or honorific-led), with no title words? */
function looksLikeNameLine(raw) {
  const t = raw.trim();
  if (!t || t.length > 45) return false;
  if (TITLE_RE.test(t)) return false; // titles are not names
  if (/\d/.test(t)) return false;
  if (/[a-z]{4,}/.test(t) && !HONORIFIC_RE.test(t)) {
    // allow "Dato' Che Halin Bin Mohd" (mixed case) only if honorific-led
    return HONORIFIC_RE.test(t);
  }
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  // ALL CAPS (allow punctuation) or honorific-led.
  const allCaps = t === t.toUpperCase() && /[A-Z]{2,}/.test(t);
  return allCaps || HONORIFIC_RE.test(t);
}

function extractPeople(text) {
  const people = [];
  const seen = new Set();
  const lines = text.split(/\r?\n/);

  let inSection = false;
  let page = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track page breaks (\f) anywhere in the line.
    const ff = line.indexOf("\f");
    if (ff >= 0) page = pageOf(text, text.indexOf(line) + ff) ;

    const trimmed = line.trim();

    if (PEOPLE_HEADERS.some((re) => re.test(trimmed)) && trimmed.length < 60) {
      inSection = true;
      continue;
    }
    if (
      inSection &&
      /^(management discussion|financial statements|corporate governance|audit committee|statement by|additional compliance|sustainability statement|analysis of|statement of)/i.test(
        trimmed,
      )
    ) {
      inSection = false;
    }
    if (!inSection) continue;

    // Pattern: a name-only line, then the following non-blank lines continue the
    // name (names wrap), until a blank line, after which comes the title.
    if (!looksLikeNameLine(trimmed)) continue;

    // Collect the contiguous non-blank name block starting at i.
    const nameParts = [trimmed];
    let j = i + 1;
    while (j < lines.length && lines[j].trim()) {
      const cont = lines[j].trim();
      if (TITLE_RE.test(cont)) break; // a title means the name block ended
      // continuation must be a short all-caps/honorific fragment (may be multi-word)
      const contWords = cont.split(/\s+/);
      const isCapsFragment =
        cont.length <= 30 &&
        contWords.length <= 4 &&
        contWords.every((w) => /^[A-Z][A-Z'.-]*$/.test(w));
      if (isCapsFragment) {
        nameParts.push(cont);
        j++;
      } else {
        break;
      }
    }
    // Skip the blank separator, then read the title line.
    while (j < lines.length && !lines[j].trim()) j++;
    if (j >= lines.length) continue;
    const titleLine = lines[j].trim();
    const tm = titleLine.match(TITLE_RE);
    if (!tm) continue;

    const cleanName = nameParts
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/,$/, "")
      .trim();
    const title = titleLine.match(/^([A-Za-z][A-Za-z&,'’ /-]{2,70})/)?.[1]?.trim() || tm[1];
    if (cleanName.split(" ").length < 2) continue;

    const key = cleanName.toLowerCase();
    // Drop a name that is a pure subset of one already captured (fragment dupes).
    const isFragment = people.some(
      (p) => p.name.toLowerCase() !== key && p.name.toLowerCase().endsWith(key),
    );
    i = j; // skip past the consumed name block + title line
    if (isFragment) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({ name: cleanName, title, evidence: `p.${page}` });
  }

  return people;
}

function extractContacts(text) {
  const emails = [...new Set((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))];
  const phones = new Map();
  for (const m of text.match(PHONE_RE) || []) {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) continue;
    if (/^20\d{10,}$/.test(digits)) continue; // company reg numbers
    const e164 = toE164(m);
    if (!e164 || e164.length < 10) continue;
    phones.set(e164, m.trim());
  }
  return {
    emails,
    phones: [...phones.entries()].map(([e164, raw]) => ({
      number_e164: e164,
      number_raw: raw,
    })),
  };
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--json");
  const input = args[0];
  if (!input) {
    console.error("Usage: node pdf-contacts.mjs <pdf-url-or-path>");
    process.exit(1);
  }

  const tmp = mkdtempSync(join(tmpdir(), "pdfc-"));
  let pdfPath;
  let source = input;
  try {
    if (/^https?:\/\//i.test(input)) {
      pdfPath = join(tmp, basename(new URL(input).pathname) || "doc.pdf");
      if (!/\.pdf$/i.test(pdfPath)) pdfPath += ".pdf";
      const bytes = await download(input, pdfPath);
      source = `${input} (${bytes} bytes)`;
    } else {
      pdfPath = input;
      if (!existsSync(pdfPath)) throw new Error("file not found: " + pdfPath);
    }

    const text = pdfToText(pdfPath);
    const tablePeople = extractBoardTable(text);
    const profilePeople = extractPeople(text);
    // Prefer the structured board table; merge any profile-only names.
    const byName = new Map();
    for (const p of [...tablePeople, ...profilePeople]) {
      const k = p.name.toLowerCase().replace(/[^a-z ]/g, "").trim();
      const prev = byName.get(k);
      if (!prev || (p.title && p.title.length > (prev.title || "").length)) byName.set(k, p);
    }
    const people = [...byName.values()];
    const { emails, phones } = extractContacts(text);

    process.stdout.write(
      JSON.stringify({ source, pages: text.split("\f").length, people, emails, phones }, null, 2) +
        "\n",
    );
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
