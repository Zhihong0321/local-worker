# research-contact

A fast, reusable pi **skill** for B2B telemarketing contact research: given any
company (solar firm, hospital, law firm, agency…), it produces decision-maker
names, phone numbers, emails, LinkedIn profiles and a telemarketing cheat sheet
as a single compact JSON object.

It is **target-agnostic** — the same workflow works for any company. The
original manual process took ~90 minutes per company; the current pipeline does
the bulk of it in **seconds to a few minutes**.

> **Portable & distributable.** This folder is a self-contained package — see
> [`INSTALL.md`](INSTALL.md). Install with `node install.mjs`; nothing is tied
> to a machine path.

---

## 1. What it does

For a target company it collects, from public sources only:

| Section | Content |
|---|---|
| `decision_makers` | Names, titles, department, role evidence, LinkedIn URL |
| `phone_contacts` | Verified numbers normalised to E.164, labelled (mobile landline / WhatsApp) |
| `email_contacts` | Public emails + inferred email **format** (never invented) |
| `profile` | Company basics (HQ, registration, website) with source URLs |

Every value is **verbatim from a public source** and carries a raw literal
evidence URL. Nothing is guessed or hallucinated; empty beats fabricated.

---

## 2. Pipeline

```
                        ┌─────────────────────────────────────────┐
                        │            Target domain / name          │
                        └───────────────────┬─────────────────────┘
                                            │
             ┌──────────────────────────────▼──────────────────────────────┐
   Step 0    │ recon.mjs — parallel fetch of ~15 common paths                │
  (HTTP,     │  /, /contact, /our-team, /leadership, /investor-relations,   │
   fast)     │  /corporate-info, /board-of-directors, …                     │
             │  → emails, E.164 phones, socials, candidate pages, PDF links │
             └───────────────┬───────────────────────────┬─────────────────┘
                             │                           │ (annual-report link found)
                             │                           ▼
                             │              ┌──────────────────────────────┐
                             │              │ pdf-contacts.mjs (auto-run)  │
                             │              │  pdftotext -layout → parse   │
                             │              │  board table + director       │
                             │              │  profiles → names + titles    │
                             │              └──────────────┬───────────────┘
                             │                             │
             ┌───────────────▼─────────────────────────────▼───────────────┐
   Step 0.5  │ linkedin.mjs — agent-reach LinkedIn channel                  │
  (LinkedIn) │  company → company_urn                                       │
             │  search --company <urn> → named people + titles + URLs       │
             │  person / employees / sidebar                                │
             └───────────────┬─────────────────────────────────────────────┘
                             │
             ┌───────────────▼─────────────────────────────────────────────┐
   Step 1–3  │ Browser escalation — ONLY if fetch failed / JS-rendered       │
  (browser)  │  obscura scrape --concurrency 10  |  browser_tab_new/extract  │
             └───────────────┬─────────────────────────────────────────────┘
                             │
             ┌───────────────▼─────────────────────────────────────────────┐
   Step 4–6  │ Deterministic regex harvest → search fallback (DDG-lite,      │
  (verify)   │ Yahoo, Brave, Bing) → verify before reporting                 │
             └───────────────┬─────────────────────────────────────────────┘
                             ▼
                 One compact JSON object (no prose)
```

### Why "fetch first, browser last"

Benchmarked on a static corporate site:

| Method | Time per page | Use when |
|---|---|---|
| `fetch()` / `recon.mjs` | **0.3–1.7 s** | Default. Static HTML. |
| `obscura scrape --concurrency 10` | 19–32 s (parallel) | JS-rendered, many URLs |
| `mcp browser_navigate` | 23–30 s | Interactive flows only |

The browser is **~15–20× slower** than plain HTTP and most corporate sites
(WordPress especially) return identical HTML. Reaching for the browser on a
static page wastes minutes for no gain.

---

## 3. Tools used

### Obscura — stealth headless browser for AI agents (MCP)
- Binary: set `OBSCURA_BIN` to the local executable, or put `obscura` on `PATH`.
- Launch: `obscura.exe mcp --stealth` (37 `browser_*` tools)
- CLI: `obscura fetch` (raw HTTP, `--dump html|text|links|markdown|cookies`),
  `obscura scrape` (browser render, `--concurrency`, `-e/--eval`)
- Role: browser escalation, raw fetches, PDF download.

### Scrapling — web scraping MCP server
- Binary: `<repo>/scrapling-deep/.venv/Scripts/scrapling-mcp.exe`, or set
  `SCRAPLING_MCP_BIN` to the local executable.
- Tools: `scrapling_fetch`, `scrapling_stealthy_fetch`, `scrapling_bulk_fetch`,
  `scrapling_bulk_stealthy_fetch`, `scrapling_screenshot`, session tools
- Role: stealth HTTP, bulk fetch, Cloudflare bypass.

### pi MCP bridge extension
- Source: `<repo>/scrapling-deep/agent-skill/mcp-bridge/index.ts`
- Installed by `node install-pi-extension.mjs` into
  `~/.pi/agent/extensions/mcp-bridge/` (`index.ts`, `package.json`).
- Why: pi has **no native MCP support**, so the bridge speaks MCP JSON-RPC over
  stdio and registers the tools inside pi.
- Commands: `/mcp-status`, `/mcp-restart`.

### agent-reach — LinkedIn channel
- Repo: https://github.com/Panniantong/agent-reach
- The channel wraps **`mcp-server-linkedin`** (stickerdaniel/linkedin-mcp-server)
  and registers it with `mcporter` — it does no scraping itself.
- It provides **one live LinkedIn channel** to this skill: named decision-makers
  with titles + profile URLs.
- Installed components:

  | Component | Version | Location |
  |---|---|---|
  | `uv` / `uvx` | 0.12.18 | `%APPDATA%\Python\Python312\Scripts` |
  | `mcporter` | 0.14.0 | `%APPDATA%\Roaming\npm` |
  | `mcp-server-linkedin` | latest (via uvx) | uv cache |
  | Patchright Chromium | latest | `~/.linkedin-mcp/patchright-browsers` |
  | LinkedIn session | — | `~/.linkedin-mcp/profile` |
  | mcporter config | — | `C:\Users\Eternalgy\.mcporter\mcporter.json` |

- Windows fixes applied during setup: browser installer redirected to
  `~/.linkedin-mcp/installer-tmp` (temp-dir ACL bug), and `PYTHONUTF8=1` /
  `PYTHONIOENCODING=utf-8` (cp1252 console crash on emoji).
- Relogin helper: `C:\Users\Eternalgy\bin\linkedin-login.cmd`
  (default = login, `status`, `logout`).

### Supporting tools
- `pdftotext` (poppler-utils, `/mingw64/bin/pdftotext`) — PDF → text
- Node v24.19.0 — all scripts
- pi `@earendil-works/pi-coding-agent` 0.87.1

---

## 4. Files

The canonical package lives in `<repo>/scrapling-deep/agent-skill/research-contact/`
and is installed into `~/.pi/agent/skills/research-contact/` by `install.mjs`.
For a new PC, follow `<repo>/FIRST_TIME_PI_WORKER_SETUP.md`.

| File | Purpose |
|---|---|
| `SKILL.md` | The target-agnostic playbook (steps, rules, fallbacks) |
| `README.md` | This file — overview, pipeline, tools, status |
| `INSTALL.md` | Portable install + prerequisites + LinkedIn channel setup |
| `install.mjs` | Self-installer (`--dest`, `--name`, `--force`, `--list`) |
| `package.json` | Package metadata / `bin` entry |
| `scripts/recon.mjs` | Parallel fetch of common pages + auto annual-report PDF |
| `scripts/pdf-contacts.mjs` | Directors/officers from an annual-report / registry PDF |
| `scripts/linkedin.mjs` | LinkedIn people/company enrichment (agent-reach channel) |
| `scripts/search.mjs` | **Google search via the `gsearch` bridge (real Chrome, no CAPTCHA)** |

### Script usage

```bash
# Step 0 — recon (+ auto annual report)
node scripts/recon.mjs <domain-or-url> [extra-url ...] [--no-pdf]

# Step 5 — web search (real Google SERP via gsearch bridge)
node scripts/search.mjs --status                       # bridge health
node scripts/search.mjs "<query>" [--pages 3] [--gl my] [--tbs qdr:m]

# Step 2 — manual PDF extraction
node scripts/pdf-contacts.mjs <pdf-url-or-path>

# Step 0.5 — LinkedIn enrichment
node scripts/linkedin.mjs status
node scripts/linkedin.mjs company   "<Company Name>"
node scripts/linkedin.mjs employees "<Company Name>"
node scripts/linkedin.mjs search    "<keywords>" --location "Malaysia"
node scripts/linkedin.mjs search    "sales" --company "<company-urn>"
node scripts/linkedin.mjs person    <linkedin-username>
node scripts/linkedin.mjs sidebar   <linkedin-username>
```

All scripts print **compact JSON on stdout** (and exit non-zero on failure, with
`{ok:false, error, hint}` for LinkedIn).

---

## 5. Status

### ✅ Working / verified

| Component | Status |
|---|---|
| Obscura MCP (`browser_*`, 37 tools) | ✅ verified |
| Scrapling MCP (13 tools) | ✅ verified |
| pi MCP bridge extension | ✅ auto-loads (user extension) |
| `recon.mjs` | ✅ 0.4–3.8 s for 15 pages; target-agnostic |
| `pdf-contacts.mjs` | ✅ both 2024 & 2026 Solarvest reports parsed |
| `linkedin.mjs` + LinkedIn session | ✅ session valid; 19 tools; live data confirmed |
| `mcporter` LinkedIn server health | ✅ `linkedin (19 tools, 5.7s)` |

**End-to-end example:** `node recon.mjs solarvest.com` → in ~16 s returned
5 emails, 16 phones, and the **complete 11-member board from the 2026 annual
report**.

**Target-agnostic check:** `node recon.mjs sunwaymedical.com` (non-listed
hospital) → 6 emails + 6 phones in **3.6 s**, correctly skipping the PDF step.

### ⚠️ Limitations / caveats

- **LinkedIn does not expose personal phones or private emails.** Contact info
  is visible only if the member published it. LinkedIn *identifies and
  prioritises* people; phones/emails still come from Steps 1–5.
- `get_company_employees` returns an **anonymised** list ("LinkedIn Member" +
  generic headline) — good for roles/headcount; use
  `search --company <urn>` for names.
- `sidebar` sometimes returns empty for a member — treat as normal.
- **Account risk:** the LinkedIn channel drives a real logged-in session via
  saved cookies. Keep volume low; the repo advises a **secondary account**.
- Data brokers (RocketReach, ZoomInfo, ContactOut, Lusha, SignalHire) are
  Cloudflare-gated/paywalled; only masked emails / formats are readable.
- The PDF name extractor keys off honorific / ALL-CAPS name lines, so a
  "Key Senior Management" section using mixed-case inline names is not captured
  by the PDF path (the HTML/search/LinkedIn paths cover those).

### 📋 Deferred / possible next steps

- Cache Cloudflare-gated directory cookies via `browser_storage_state`.
- Improve PDF extraction for mixed-case "Key Senior Management" blocks.
- Optional: install the rest of agent-reach (Twitter, Reddit, etc.) if needed —
  **not required for LinkedIn**, which is now wired in directly.

---

## 6. Session / re-login

LinkedIn sessions expire. If `linkedin.mjs status` reports invalid:

```
C:\Users\Eternalgy\bin\linkedin-login.cmd          # opens a browser; log in manually
C:\Users\Eternalgy\bin\linkedin-login.cmd status   # check
C:\Users\Eternalgy\bin\linkedin-login.cmd logout   # clear
```

The login window handles 2FA / captcha and closes itself once the session is
captured.

---

## 7. Testing in a new session

The skill is discovered by pi automatically. To exercise it, pass a fresh prompt
in a new session, e.g.:

> Research the decision-makers and contact details for **<Company Name>** and
> return the single JSON object defined for the research-contact skill.

Expected behaviour: recon runs first, the annual report is auto-extracted for
listed companies, LinkedIn enrichment fills the sales/leadership layer, and any
gaps are filled by the search fallback — all verified before reporting.

---

## 8. Running as a queue worker job

This Skill is also callable from the `local-worker` job queue, so a report can be
requested without a human opening a pi session. The adapter lives in the worker
repository, not in this package:

```
local-worker/research-contact.mjs          # job handler (payload validation + JSON contract)
local-worker/worker.mjs                    # registers research.contact / research.probe
local-worker/README.md → §6                # full payload and result contract
```

How it works: the handler validates a small structured payload, then runs
`pi --print --no-session --skill <this directory>` with a fixed system prompt that
keeps the Skill's workflow in charge. It accepts only the final JSON object, so a
run that ends in prose or a half-finished report fails loudly instead of being
reported as a result.

Job types:

| Type | Purpose |
|---|---|
| `research.contact` | Run one full report for a company |
| `research.probe` | Report whether the Skill, Pi, `pdftotext`, and the gsearch bridge are available |

Local invocation (no queue):

```bash
node research-contact.mjs probe
node research-contact.mjs contact '{"name":"Solarvest","domain":"solarvest.com"}'
```

> **Queue producer lives elsewhere.** This repository implements the worker
> **consumer** only. The central broker that creates and allows job types is the
> ee-auto cloud service, so `research.contact` must be allowed there too before a
> job can be queued end-to-end.

### Blocking on a human

A queued run cannot ask a question, so every human-only gate is reported as a
`needs_human` failure rather than waited on: a Google CAPTCHA, a Chrome window
with the gsearch extension closed, or an expired LinkedIn session. The three have
different remedies, and the handler passes through the diagnostic text so the
operator can tell them apart without re-running the job.
