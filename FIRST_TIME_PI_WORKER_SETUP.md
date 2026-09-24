# First-time Pi research worker setup (another Windows PC)

This guide is for a fresh clone of `local-worker`. An AI assistant can follow the command steps, then ask the PC owner to complete account sign-ins and Chrome extension loading. The repository carries source code and configuration templates. It does not carry credentials, browser profiles, Python virtual environments, npm installations, or the Obscura binary.

## 1. Install prerequisites and clone

Install Git, Node.js 20 or newer, Python 3.10 or newer, and Google Chrome. Open PowerShell in the directory where the worker should live:

```powershell
git clone https://github.com/Zhihong0321/local-worker.git
Set-Location local-worker
node --version
python --version
npm test
```

Do not clone `scrapling-deep` separately. Its source, the research skill, the Pi MCP bridge, and the gsearch Chrome extension are vendored in this repository.

## 2. Configure the worker

```powershell
Copy-Item .env.example .env
notepad .env
```

Set `LAB_TOKEN` to the current worker token supplied by the ee-auto owner. Give this PC a unique `WORKER_NAME`. For a Pi-only machine use:

```ini
LAB_URL=https://ee-auto.up.railway.app
LAB_TOKEN=<obtain-from-owner>
WORKER_NAME=<unique-name-for-this-PC>
WORKER_TYPES=research.contact,research.probe
```

Do not commit `.env`. Leave `PG_PROXY_TOKEN` empty unless this PC also saves Maps scans through the Postgres proxy. The Pi contact job posts its result to the ee-auto job broker through `LAB_TOKEN`.

## 3. Install and sign in to Pi

```powershell
npm install -g @earendil-works/pi-coding-agent
pi --version
pi
```

Complete Pi's model-provider sign-in in the interactive session, then exit Pi. The model login is local to this PC and cannot be copied from the repository. If `pi` is outside `PATH`, set `RESEARCH_AGENT_BIN` in `.env` to its launcher or `cli.js` path.

Install the bundled skill and MCP bridge:

```powershell
node scrapling-deep/agent-skill/research-contact/install.mjs
node install-pi-extension.mjs
```

The second command copies the bridge to `~/.pi/agent/extensions/mcp-bridge` and installs its npm runtime dependency. If a bridge is already installed, inspect or back it up before using `node install-pi-extension.mjs --force` to replace it. Restart Pi after an extension change. The worker passes its repository path to Pi, so the bridge can locate this checkout on another drive.

## 4. Install the optional research tools

The core research skill runs with Pi and Node. These tools improve coverage; the setup checks identify any missing ones.

### Scrapling MCP

Build the virtual environment from the vendored source on this PC:

```powershell
Set-Location scrapling-deep
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e ".[all]"
.\.venv\Scripts\scrapling.exe install
Set-Location ..
```

The bridge defaults to `scrapling-deep/.venv/Scripts/scrapling-mcp.exe`. If it is installed elsewhere, set `SCRAPLING_MCP_BIN` in `.env` to its absolute path. Never copy `.venv` between PCs.

### Chrome gsearch extension

The PC owner should open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this clone's `scrapling-deep/gsearch-extension` directory. Keep that Chrome profile open. Once the worker starts, its log should say `gsearch extension connected`. The extension connects to the local bridge on `127.0.0.1:18787`.

### Obscura, PDF, and LinkedIn

- If Obscura is installed, set `OBSCURA_BIN` in `.env` to its executable path. The bridge also accepts `obscura` on `PATH`. Obscura is not bundled here.
- Install Poppler's `pdftotext` and put it on `PATH` for annual-report PDF extraction, or set `PDFTOTEXT_BIN`.
- For LinkedIn enrichment, follow [the skill install guide](scrapling-deep/agent-skill/research-contact/INSTALL.md#3-optional-enable-the-linkedin-channel). It requires `uvx`, `mcporter`, and a manual LinkedIn login on this PC. Do not copy session cookies from another PC.

Missing optional tools should be reported by the setup checks. They must not be treated as proof that Pi itself is unavailable.

## 5. Check locally, then start one worker instance

```powershell
node setup.mjs --checks
node setup.mjs --deep
node research-contact.mjs probe
```

Check that Pi and the research skill are ready. If Scrapling and Obscura were installed, the deep checks should complete their MCP handshakes. Start one worker instance:

```powershell
.\start-worker.bat
```

In another PowerShell window, verify the broker sees this PC and its `research.contact` lane:

```powershell
node check-status.mjs
```

The local dashboard is at `http://127.0.0.1:18788/setup`. Do not start several copies of `start-worker.bat` on the same PC; they would compete for the same research jobs and local gsearch port.

## 6. Verify a real job only when requested

A local `probe` checks dependencies but does not prove a full research result. A real proof requires one `research.contact` job to be created in ee-auto, claimed by this PC's research lane, completed with a Pi `agent_end` response, posted to `/api/jobs/:id/result`, and read back as `done` with the four result sections. Record its job ID, worker name, attempt count, and result. Do not submit duplicate jobs while one is running.

The job broker stores direct queue results separately from any lead-linked contact report. A `done` queue job proves Pi dispatch and result capture; it does not by itself update a lead card.
