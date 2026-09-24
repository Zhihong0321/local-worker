# Install — research-contact

A portable pi skill. Nothing is machine-specific: the scripts resolve Node,
`mcporter` and `uvx` from `$HOME`/`PATH` at runtime.

## 1. Install the skill

From inside this folder:

```bash
node install.mjs
```

This copies the skill into your pi skills directory:

- default: `$PI_SKILLS_DIR` (if set), else `~/.pi/agent/skills/research-contact`
- custom root: `node install.mjs --dest /path/to/skills`
- custom folder name: `node install.mjs --name my-research`
- overwrite: `node install.mjs --force`
- dry run: `node install.mjs --list`

Then verify pi sees it:

```bash
pi --print --no-session "name the files in the research-contact skill"
```

> **Manual install alternative:** copy this folder to
> `~/.pi/agent/skills/research-contact/` yourself. Anything named
> `research-contact/` containing `SKILL.md` is discovered automatically.

## 2. Prerequisites

| Need | Required for | Notes |
|---|---|---|
| Node ≥ 18 | all scripts | v24 tested |
| `pdftotext` (poppler-utils) | annual-report PDF step | optional — step is skipped if absent |
| `gsearch` bridge (real Chrome) | `search.mjs` **only** search engine | required — no API key, but Chrome + the extension must be running |
| `uvx` + `mcporter` + LinkedIn session | LinkedIn enrichment (Step 0.5) | optional — everything else works without it |

The core workflow (website recon, PDFs, web search) needs **only Node**.
Missing optional pieces degrade gracefully: no `pdftotext` → PDF step skipped;
no LinkedIn session → Step 0.5 reports `session_valid:false` with a hint.

## 2b. Recommended: Google search via the `gsearch` bridge

Free search engines CAPTCHA-block datacenter IPs. The skill avoids this by
talking to the **`gsearch` bridge**, which runs Google searches inside the
user's **real Chrome** — so Google sees a person, not a bot. No API key.

**Endpoint:** `POST http://127.0.0.1:18787/search` (served by `worker.mjs` in
the `local-worker`). Full contract: `local-worker/scrapling-deep/gsearch-extension/AGENT.md`.

Setup:
1. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → pick
   the `gsearch-extension` folder.
2. Start the worker (`start-worker.bat`); the log shows
   `[gsearch] listening on http://127.0.0.1:18787` then `extension connected`.
3. Verify from here:

```bash
node scripts/search.mjs --status        # extension_connected: true
node scripts/search.mjs "test query"    # engine: gsearch
```

Env overrides: `GSEARCH_URL` (default `http://127.0.0.1:18787`),
`GSEARCH_TOKEN` (if the worker sets one).

If the bridge is offline, `search.mjs` returns `extension_offline` (Chrome closed
or extension disabled) or `bridge_unreachable` (worker not running). Both need a
human to fix — there is deliberate **no** silent secondary engine, so a dead
bridge never burns minutes.

## 3. Optional: enable the LinkedIn channel

The LinkedIn channel is `mcp-server-linkedin` registered with `mcporter`
(the "agent-reach" LinkedIn channel). Setup:

```bash
# a) uv / uvx  — https://docs.astral.sh/uv/getting-started/installation/
#    (pip fallback:  python -m pip install --user uv )

# b) mcporter
npm install -g mcporter

# c) register the server (writes ~/.mcporter/mcporter.json)
mcporter config add linkedin --command uvx \
  --arg mcp-server-linkedin@latest \
  --env UV_HTTP_TIMEOUT=300 --scope home

# d) first login — opens a browser, log in manually (handles 2FA/captcha)
uvx mcp-server-linkedin@latest --no-headless --login
```

Verify:

```bash
node scripts/linkedin.mjs status          # → session_valid: true
mcporter list | grep linkedin             # → linkedin (19 tools, …)
```

### Windows-specific fixes (already handled by the wrapper)

If you hit either of these, the same workarounds apply:

- **Browser installer ACL error** (`...Temp grants ... permission to replace
  private state`): add
  `--installer-temp-dir %USERPROFILE%\.linkedin-mcp\installer-tmp` to the
  `uvx` args (and to the `mcporter` config), and create that folder first.
- **`UnicodeEncodeError: 'charmap' codec`**: set `PYTHONUTF8=1` and
  `PYTHONIOENCODING=utf-8`. `linkedin.mjs` sets these automatically.

Re-login helper (`linkedin-login.cmd`):

```bat
@echo off
SET "PATH=%APPDATA%\Python\Python312\Scripts;%PATH%"
SET PYTHONUTF8=1
SET PYTHONIOENCODING=utf-8
uvx mcp-server-linkedin@latest ^
  --installer-temp-dir "%USERPROFILE%\.linkedin-mcp\installer-tmp" ^
  --no-headless --login
```

> **Account safety:** the LinkedIn channel drives a real logged-in session via
> saved cookies. Keep request volume low; prefer a secondary account.

## 4. Quick self-test

```bash
# Website recon (+ auto annual report when a PDF is found)
node scripts/recon.mjs solarvest.com
node scripts/search.mjs "Solarvest Energy directors Malaysia"

# Manual PDF extraction
node scripts/pdf-contacts.mjs https://solarvest.com/wp-content/uploads/2026/07/1.-Annual-Report-2026.pdf

# LinkedIn (only if the channel is enabled)
node scripts/linkedin.mjs company   "Solarvest"
node scripts/linkedin.mjs search    "Solarvest" --location "Malaysia"
```

## 5. Queue worker integration

The parent `local-worker` repository exposes this Skill as two queue job types:

- `research.contact` — runs one complete report through Pi's JSON event mode.
- `research.probe` — checks the Skill, Pi, `pdftotext`, and gsearch bridge state.

The consumer adapter is `local-worker/research-contact.mjs`; it is deliberately
outside this portable package. Install the Skill normally first, then configure
the worker with:

```ini
WORKER_TYPES=research.contact,research.probe
# Optional overrides:
# RESEARCH_AGENT_BIN=pi
# RESEARCH_CONTACT_SKILL_DIR=C:\\Users\\you\\.pi\\agent\\skills\\research-contact
# RESEARCH_CONTACT_TIMEOUT_MS=900000
```

Install the bundled MCP bridge too with `node install-pi-extension.mjs` from the
`local-worker` root. Its Scrapling path is derived from the worker checkout;
set `SCRAPLING_MCP_BIN` and `OBSCURA_BIN` if those executables live elsewhere.
The complete new-PC procedure is in `FIRST_TIME_PI_WORKER_SETUP.md`.

Check the local prerequisites before queueing work:

```bash
node research-contact.mjs probe
```

The queue payload is a JSON object containing `name` or `company`, optionally
`domain`/`website`/`url`, `extraUrls` (at most 20 public HTTP(S) URLs),
`location`, `locale`, and `timeoutMs` (30 seconds to 30 minutes). Successful
jobs return `{cheat_sheet, decision_makers, phone_contacts, email_contacts}`.

This checkout only implements the queue **consumer**. The ee-auto broker's job
producer and allowlist are maintained separately; add `research.contact` there
before expecting cloud jobs to arrive.

## 6. Uninstall

```bash
rm -rf ~/.pi/agent/skills/research-contact
# optional, removes the LinkedIn session too:
uvx mcp-server-linkedin@latest --logout
```
