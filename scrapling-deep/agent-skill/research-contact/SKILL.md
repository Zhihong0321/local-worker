---
name: research-contact
description: Fast, reusable B2B contact and decision-maker research for any company or organisation. Use when the task asks for phone numbers, emails, decision makers, LinkedIn profiles, or a telemarketing cheat sheet, or when researching a company from its website, team page, annual report, LinkedIn, or public directories. Includes a live LinkedIn channel (agent-reach / mcp-server-linkedin) for named decision-makers. Optimised for fetch-first extraction, batch navigation, and minimal LLM round-trips.
---

# Research Contact

Find actionable contact details and decision-makers for **any** target company.
This skill is target-agnostic: the same steps work for a solar firm, a hospital,
a law firm, or a government agency. Adapt the search terms, not the workflow.

## Tools in the pipeline

**Bundled scripts** (the only things you normally call):

| Script | Step | What it does | Underlying tech |
|---|---|---|---|
| `scripts/recon.mjs` | 0 | Fetch ~15 common paths in parallel + auto-detect & extract the annual-report PDF | Node `fetch()` · `pdftotext` |
| `scripts/search.mjs` | 5 | Google search → structured SERP results | `gsearch` bridge (real Chrome) |
| `scripts/linkedin.mjs` | 0.5 | Named decision-makers: name, title, location, profile URL | `mcporter` → `mcp-server-linkedin` |
| `scripts/pdf-contacts.mjs` | 2 | Directors/officers from an annual-report or registry PDF | `pdftotext -layout` + regex |

**External engines behind those scripts:**

| Tool | Role |
|---|---|
| **`gsearch` bridge** — `POST http://127.0.0.1:18787/search` | **The only search engine.** Runs Google inside the user's real Chrome, so no CAPTCHA. Contract: `gsearch-extension/AGENT.md`. |
| `mcporter` + `uvx mcp-server-linkedin` | LinkedIn MCP channel (agent-reach) |
| `pdftotext` (poppler) | PDF → text for the annual-report step |

**Escalation only — slower, gated (Steps 3–4):**

| Tool | When | Cost |
|---|---|---|
| `obscura.exe scrape --concurrency 10` | Many JS-rendered URLs at once | 19–32 s (parallel) |
| `browser_tab_new` / `browser_extract` / `browser_evaluate` (Obscura MCP) | Interactive flows, client-rendered pages | 23–30 s |
| Regex harvest | Emails/phones/socials from already-fetched HTML | ~0 s |

## Core principle: fetch first, browser last

The measured cost of each tool (benchmarked on a static corporate site):

| Method | Time per page | When to use |
|---|---|---|
| `fetch()` / recon.mjs | **0.3–1.7 s** | Default. Static/server-rendered HTML. |
| `obscura scrape --concurrency 10` | 19–32 s (parallel) | JS-rendered pages, many URLs at once. |
| `mcp browser_navigate` | 23–30 s | Interactive flows only (click, fill, login). |

**The browser is ~15–20x slower than plain HTTP.** Most corporate sites
(WordPress especially) return identical HTML to `fetch()`. Reaching for the
browser on a static page wastes minutes for zero benefit.

**Gate:** only escalate to the browser if `fetch` returns empty text, the text
contains "Enable JavaScript" / "Please enable JS", the needed data is
client-rendered, or you must click/type. Otherwise stay on HTTP.

**Dead-site fast path (important).** If recon returns near-identical short text
for every path (e.g. all pages 200 with the *same* title like "Maintenance",
"Coming Soon", "Under Construction", or a placeholder), the site is **down**.
Do **not** re-fetch it dozens of ways. Instead:
1. Fetch the **parent/group website** and the group's **contact page** once —
   these usually list the target entity's phones/emails verbatim.
2. Run **one** `search.mjs` query for the entity + "director/owner/contact".
3. Try **one** Wayback snapshot of the old contact page (optional).
4. Compile. Budget this path at **≤5 minutes total**.

## Step 0 — Recon (ONE call, does most of the work)

```bash
node <skill-dir>/scripts/recon.mjs <company-domain-or-url> [extra-url ...]
```

Fetches ~15 common paths in parallel **and auto-extracts the annual report PDF**.
Prints JSON:

```
{ target,
  pages:[{url,status,title,textChars}],
  emails:[],
  phones:[{number_e164,number_raw,sources}],
  socials:{},
  candidatePages:[],
  pdfLinks:[],
  annualReport?:{ people:[{name,title,evidence}], emails, phones } }
```

Flags: `--no-pdf` skips the annual-report step.

The `annualReport.people` array is the highest-value output for **listed**
companies — it yields the full board with names + titles from an authoritative
source. For non-listed companies, `pdfLinks` will be empty and you rely on the
HTML paths.

If you already know exact URLs, pass them all as arguments and skip search.

## Step 0.5 — LinkedIn enrichment (agent-reach channel)

This skill has a **live LinkedIn channel** wired in: `mcp-server-linkedin` is
registered with `mcporter` as the `linkedin` MCP server (installed via the
agent-reach LinkedIn channel). Use it to find **named decision-makers with
titles and profile URLs** — the layer that corporate sites and annual reports
usually cannot give (sales / marketing / regional BD staff).

Always go through the bundled wrapper. It reduces the huge MCP payload to
compact JSON — **never** call `mcporter call linkedin.*` raw, it dumps the
entire activity feed into context.

```bash
node <skill-dir>/scripts/linkedin.mjs status
node <skill-dir>/scripts/linkedin.mjs company   "<Company Name>"
node <skill-dir>/scripts/linkedin.mjs employees "<Company Name>"
node <skill-dir>/scripts/linkedin.mjs search    "<Company>" --location "Malaysia"
node <skill-dir>/scripts/linkedin.mjs search    "sales" --company "<company-urn>"
node <skill-dir>/scripts/linkedin.mjs person    <linkedin-username>
node <skill-dir>/scripts/linkedin.mjs sidebar   <linkedin-username>
```

**Recommended flow:**
1. `company "<Name>"` → returns **`company_urn`** (e.g. `3760712` = Solarvest).
2. `search "<role keywords>" --company "<urn>"` → named people filtered to that
   employer: name + headline (title) + location + profile URL.
3. `person <username>` on the shortlist → headline + About snippet.
4. `sidebar <username>` → "people also viewed" (maps adjacent leadership).

**What LinkedIn realistically gives (and does not):**
- ✅ Names, **job titles**, locations, profile URLs, current/past employer.
- ✅ `employees` confirms headcount band + function breakdown + `company_urn`.
- ❌ **It does NOT expose personal phone numbers or private emails.** Contact
  info is only visible if the member published it. LinkedIn therefore
  *identifies and prioritises* people; phones/emails still come from Steps 1–5.
- ⚠️ `get_company_employees` returns an **anonymised** list ("LinkedIn Member"
  + generic headline) — use it for roles/headcount, then `search --company <urn>`
  for names. `sidebar` sometimes returns empty; treat that as normal.

**Prerequisites / session:** first run `status`. If it is not valid, the session
has expired — re-login with `linkedin-login.cmd` (or run
`uvx mcp-server-linkedin@latest --no-headless --login`). Requires `uvx`
(`%APPDATA%\Python\Python312\Scripts`) and `mcporter` (`%APPDATA%\Roaming\npm`)
on PATH; the wrapper resolves both automatically.

**Account safety:** this uses a real logged-in LinkedIn session. Keep request
volume low and space calls out; the repo advises a **secondary account**.

## Step 1 — Enumerate the right pages

`recon.mjs` already tries these; use the table to add sector/locale variants:

| Purpose | Paths to try |
|---|---|
| Team / leadership | `/our-team`, `/team`, `/leadership`, `/management`, `/about`, `/about-us` |
| Contact | `/contact`, `/contact-us`, `/support`, `/reach-us`, `/enquiry` |
| Investor / corporate | `/investor-relations`, `/investor-relations/corporate-info`, `/corporate-info`, `/board-of-directors` |
| Careers (reveals depts) | `/careers`, `/jobs`, `/join-us` |
| Annual report | usually linked from the investor page as `*.pdf` |
| Legal/registry | SSM (MY), Companies House (UK), SEC (US), etc. |

For a group of related companies, check the **group leadership page** — it often
lists cross-company directors with canonical titles the operating site omits.

## Step 2 — Annual report / registry PDF (listed companies)

`recon.mjs` runs this automatically when it finds an annual-report link. To run
it manually on any PDF (annual report, prospectus, registry filing):

```bash
node <skill-dir>/scripts/pdf-contacts.mjs <pdf-url-or-path>
```

Returns `{ source, pages, people:[{name,title,evidence}], emails, phones }`.
Requires `pdftotext` (poppler-utils), available at `/mingw64/bin/pdftotext`.

It handles two common layouts:
- Prose "Directors Profile" entries (name block, then title line).
- The numbered "Board of Directors / No. Name … Position" summary table.

This is the canonical source for directors + titles and usually beats scraping
the website's team page (which may be stale or omit board members).

## Step 3 — Batch open and extract (only if the browser is needed)

Open every candidate page in its own tab in ONE assistant turn, then extract:

```
browser_tab_new(url: "<team page>")
browser_tab_new(url: "<contact page>")
browser_tab_new(url: "<group leadership>")
```

When you have **many** JS-rendered URLs, prefer the `obscura scrape` CLI, which
renders up to `--concurrency 10` in parallel in a single process:

```bash
obscura.exe scrape <url1> <url2> <url3> --format markdown --quiet --timeout 40
```

Then per tab, ONE extraction call. For a team page use `browser_extract`:

```
browser_extract(schema: {
  "people[]": ".team-card, .member, [class*=team] article",
  "names[]":   ".team-card h3, .member-name, [class*=name]",
  "titles[]":  ".team-card p, .member-role, [class*=role], [class*=title]"
})
```

If selectors are unknown, use ONE `browser_evaluate` that returns a compact list
instead of a snapshot:

```js
browser_evaluate(expression:
  "JSON.stringify([...document.querySelectorAll('h1,h2,h3,h4,p,li,a')]"
  + ".map(e=>({t:e.tagName,txt:e.innerText.trim()}))"
  + ".filter(x=>x.txt && x.txt.length<120).slice(0,400))")
```

**Never** take a default full `browser_snapshot`; pass `max_chars: 1500` if you
must snapshot at all.

## Step 4 — Harvest contacts deterministically

From the page HTML (via `browser_evaluate` on `document.documentElement.innerHTML`
or from the recon script), regex — do NOT eyeball:

- emails: `/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g`
- phones: `/\+?\d[\d\s().-]{7,}\d/g` then normalise
- socials: `linkedin\.com\/(in|company)\/...`, `wa\.me\/...`, `facebook`, `instagram`

WhatsApp widget numbers (`.qlwapp` / `wa.me` / `api.whatsapp.com/send?phone=`)
are real, dialable WhatsApp lines — extract them from the raw HTML even when
they don't appear in the visible text.

Normalise to E.164. Malaysia mobile prefixes: 010,011,012,013,014,016,017,018,019.
Reject dates, company registration numbers (e.g. `201701007142`), and JS/CSS
digit runs — matching raw HTML for phones produces false positives, so match the
**stripped text** instead.

## Step 5 — Search (only when pages lack contacts)

For **people/decision-makers**, try Step 0.5 (LinkedIn) first — it is direct and
structured. Use web search mainly for **phones and emails**, and for people at
companies with no LinkedIn presence.

### Search engine priority (use `scripts/search.mjs`)

**Primary: `search.mjs` → real Google SERP via the local `gsearch` bridge.**
The bridge (`http://127.0.0.1:18787/search`) drives the user's **own Chrome**, so
Google sees a real person — **no CAPTCHA walls, no API key**. It returns
structured results (title/url/snippet), not an LLM summary.

```bash
node <skill-dir>/scripts/search.mjs --status                  # bridge health
node <skill-dir>/scripts/search.mjs "<query>"                 # ~10 results
node <skill-dir>/scripts/search.mjs "<query>" --pages 3       # ~30 results
node <skill-dir>/scripts/search.mjs "<query>" --gl my --hl en # country/language
node <skill-dir>/scripts/search.mjs "<query>" --tbs qdr:m     # past month
```

Google operators work: `site:`, `"exact phrase"`, `-exclude`, `OR`,
`filetype:pdf`, `intitle:`, `after:YYYY-MM-DD`.

Output is one compact JSON object:
`{ok, engine, query, results[], featured, knowledge, peopleAlsoAsk, related,
stats, url, duration_s, tried[]}`. Each result is `{position,title,url,snippet}`.

**Fallback chain** (automatic): none — `gsearch` is the only engine. If the
bridge is unreachable it reports `bridge_unreachable`; if Chrome is closed or
the extension is disabled it reports `extension_offline`. Both need a human;
there is no silent second engine to burn minutes on.

> **STOP-LOSS (read this).** `captcha` or `extension_offline` from `gsearch`
> needs a **human** — stop and report, do **not** retry in a loop. Keep to
> **~20–30 searches per task**; beyond that Google gets suspicious even of a real
> browser. Searches are rate-limited to one at a time with a 3–6 s gap, so
> **never fire them in parallel**. Prefer a precise query over more pages.
>
> If you get **3 failed/blocked searches in a row**, stop searching. Instead:
> (a) fetch official corporate + parent/group sites directly (rarely blocked);
> (b) fetch registry/directory pages once; (c) compile from what you have.
> Budget the whole search phase at **≤5 minutes**.

**Legacy fallback engines** (only if the bridge is unavailable and you must fall
back to raw HTTP — these CAPTCHA often, so treat them as a last resort):

1. `https://lite.duckduckgo.com/lite/?q=` (best for exact `"phrase"` queries)
2. `https://search.yahoo.com/search?p=` (resilient, good for local directories)
3. `https://search.brave.com/search?q=` (rich B2B snippets; rate-limits fast)
4. `https://www.bing.com/search?q=`

Query patterns that pay off (independent — issue them, don't chain dependently):

```
"<Full Name>" <Company> email
"<Company>" "@<domain>"
"<Company>" "support@" OR "info@" OR "sales@"
"<Company>" <city> phone number
"<Full Name>" <Company> linkedin
"<Company>" "Chief <role>" OR "Head of <dept>"
<Company> myhijau OR registry OR "company profile"
```

Data-broker snippets (RocketReach, ZoomInfo, ContactOut, SignalHire, MyHIJAU,
ENF Solar, Yellow Pages, BusinessList) reveal masked emails like `j******@domain.com`
and email **formats** (e.g. `{first_initial}{last}@domain.com`). Report the
format, but never invent the unmasked address.

If an engine returns a CAPTCHA page (`/sorry/`, "Verifying", "unusual traffic"),
do NOT retry it. Move to the next engine. Pacing: wait 3–6s between queries to
the same engine.

## Step 6 — Verify before reporting

- A number/email is reportable only if it appears verbatim in a public source.
- LinkedIn may be cited for a **name/title/profile URL**; its profile URL is a
  raw literal URL and is acceptable evidence for the person's role.
- Prefer official site > annual report / registry > LinkedIn (role) > trade
  directory > data broker.
- Cross-check the main line against at least two sources when possible.
- Leave fields empty rather than guessing. Never fabricate.

## Output

Return exactly the JSON object the task requests. No prose outside it.
Evidence fields must be raw literal URLs, not descriptions.

## Anti-patterns (each cost real minutes)

- ❌ `browser_navigate` + `browser_snapshot` for static pages (~25 s each).
- ❌ Skipping the annual-report PDF for a listed company (it holds the full board).
- ❌ Calling `mcporter call linkedin.*` raw — it dumps the whole activity feed.
- ❌ Expecting LinkedIn to yield personal phones/emails (it does not).
- ❌ Retrying Google/Bing after CAPTCHA.
- ❌ One search per assistant turn when several are independent.
- ❌ Reading full nav/footer boilerplate instead of extracting contacts.
- ❌ Matching phone numbers against raw HTML (picks up JS/CSS/registry noise).
- ❌ Navigating one company at a time when several share a group site.

## Files

| File | Purpose |
|---|---|
| `scripts/recon.mjs` | Parallel fetch of common pages + auto annual-report PDF |
| `scripts/pdf-contacts.mjs` | Directors/officers from an annual-report / registry PDF |
| `scripts/linkedin.mjs` | LinkedIn people/company enrichment (agent-reach channel) |
