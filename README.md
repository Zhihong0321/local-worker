# Local Worker (`local-worker`)

Cross-platform background worker designed to run on local machines (**Windows**, **macOS**, **Linux**) and execute automation jobs dispatched by **[ee-auto.up.railway.app](https://ee-auto.up.railway.app)**.

---

## 1. How It Works (Multi-Device Architecture)

```
                       ┌─────────────────────────────────────────┐
                       │     ee-auto.up.railway.app (Cloud)      │
                       │   Central Job Broker & FIFO Queue       │
                       └────▲─────────────────▲────────────────▲─┘
                            │                 │                │
            Outbound Poll   │   Outbound Poll │  Outbound Poll │
          (No Inbound Port) │ (No Inbound Port│(No Inbound Port│
                            │                 │                │
              ┌─────────────┴──┐       ┌──────┴─────────┐   ┌──┴─────────────┐
              │ Mac Mini Worker│       │Windows PC #1   │   │Windows PC #2   │
              │ (Residential)  │       │(Residential)   │   │(Residential)   │
              └────────────────┘       └────────────────┘   └────────────────┘
```

1. **Outbound Only (Zero Inbound Ports)**:
   - Workers poll `GET /api/jobs/next` over HTTPS.
   - You do **not** need a static IP, DDNS, or router port-forwarding. It works behind any home NAT, office Wi-Fi, or mobile hotspot.
2. **Work Stealing & Dynamic Load Balancing**:
   - Jobs (Google Maps scanning, Antigravity contact research, ChatGPT audits, and research-contact runs) queue on Railway.
   - Any idle worker across any machine immediately claims the next job.
   - If one machine is busy running a long 4-minute deep research, other machines instantly pick up remaining jobs.
3. **Automatic Failover & Heartbeats**:
   - Workers send heartbeats every 30s. If a PC goes to sleep or loses internet, Railway automatically reclaims the job and hands it to a healthy worker.
4. **Independent Identity**:
   - Each machine has its own `WORKER_NAME` (e.g. `macmini-ask`, `windows-office`, `windows-laptop`).
   - Monitor all active machines live at `GET /api/jobs`.

---

## 2. Supported Job Types

Configure which jobs a worker accepts via `WORKER_TYPES` in `.env`:

| Job Type | Description | Requirements |
| :--- | :--- | :--- |
| `ping` | Verifies worker connectivity and reports residential public IP | Node.js |
| `gmap.scan` | High-speed Google Maps business scanner (CDP-based) | Google Chrome |
| `agy.ask` | High-speed AI contact & telemarketing research | Antigravity CLI (`agy`) |
| `agy.probe` | Antigravity session health check | Antigravity CLI (`agy`) |
| `chatgpt.ask` | ChatGPT web research runner | Signed-in browser profile |
| `research.contact` | Agent-backed research-contact company/contact report | Pi CLI + installed research-contact skill; optional Chrome/gsearch and LinkedIn sessions improve coverage |
| `research.probe` | Research-contact worker dependency and session health check | Node.js; reports optional dependency state |

---

## 3. Windows Setup Guide

### Step 1: Install Prerequisites
1. **Node.js**: Install Node.js **v20 or higher** (LTS recommended) from [nodejs.org](https://nodejs.org/).
2. **Google Chrome**: Install standard [Google Chrome](https://www.google.com/chrome/). (Worker auto-detects `C:\Program Files\Google\Chrome\Application\chrome.exe`).
3. *(Optional)* **Antigravity CLI**: If running `agy.ask` jobs, ensure `agy` is installed and logged in.
4. *(Optional)* **Pi CLI + research-contact Skill**: If running `research.contact`, install the Skill from `scrapling-deep/agent-skill/research-contact` and make sure `pi` is available on PATH. The Skill can use the local gsearch Chrome extension, `pdftotext`, and the LinkedIn channel when those are configured.

### Step 2: Clone & Configure
Open **Command Prompt** or **PowerShell**:

```cmd
git clone https://github.com/Zhihong0321/local-worker.git
cd local-worker
copy .env.example .env
```

For a new PC that will run Pi contact research, follow [FIRST_TIME_PI_WORKER_SETUP.md](FIRST_TIME_PI_WORKER_SETUP.md). It covers the bundled skill, MCP bridge, Scrapling environment, Chrome extension, and local checks.

### Step 3: Edit `.env`
Open `.env` in Notepad:
```cmd
notepad .env
```

Set your configuration:
```ini
LAB_URL=https://ee-auto.up.railway.app
LAB_TOKEN=replace-with-your-worker-token

# Give this Windows machine a unique name:
WORKER_NAME=windows-pc-1

# Define what work this PC should take:
# For Maps scans only:
# WORKER_TYPES=ping,gmap.scan
# For both Maps scans and Antigravity research:
WORKER_TYPES=ping,gmap.scan,agy.ask,agy.probe
# To add the Agent-backed research-contact lane:
# WORKER_TYPES=ping,gmap.scan,agy.ask,agy.probe,research.contact,research.probe
```

---

## 4. Running the Worker on Windows

### Method 1: Double-Click Launcher (Easiest)
Simply double-click **`start-worker.bat`** in File Explorer.
- It will verify Node.js is installed.
- Launches the worker in a persistent loop.
- If the worker ever exits due to a network blip, it automatically restarts after 5 seconds.

### Method 2: Command Line
```cmd
node worker.mjs
```

### Method 3: Run as a Background Service with PM2 (Recommended for 24/7 Servers)
To make the worker automatically run in the background and restart on Windows boot:

```cmd
npm install -g pm2
npm install -g pm2-windows-startup
pm2-startup install
pm2 start ecosystem.config.cjs
pm2 save
```

Useful PM2 commands:
- `pm2 status` — View worker status.
- `pm2 logs local-worker` — View real-time logs.
- `pm2 restart local-worker` — Restart worker.

### Local operations dashboard

The normal worker process also serves a read-only dashboard on the local machine:

```text
http://127.0.0.1:18788/
```

It shows process uptime and memory, cloud queue counts, every configured lane and
its current job, completed/failed job timing, Google Search extension status,
cloud worker presence, and recent sanitized activity. It refreshes automatically
every three seconds and does not expose job payloads, results, or credentials.
When AGY reports an individual quota limit, its shared lanes show **QUOTA
COOLDOWN**, the reset time, and a countdown. They stop claiming AGY jobs until
the deadline, while other worker lanes continue normally.

The dashboard is loopback-only by default. Configure `WORKER_DASHBOARD_PORT` or
`WORKER_DASHBOARD_HOST` in `.env`, or set `WORKER_DASHBOARD_DISABLE=1` to turn it
off. Binding it to a LAN/public interface exposes operational data; if you do
that, put it behind access control and a trusted network boundary yourself.

### Device setup & health checklist

On a new device, open **`http://127.0.0.1:18788/setup`** (or click *Setup &
health* in the dashboard header). It answers one question: *is this device
installed and healthy for the job types it claims?*

- **Fast layer** (file/PATH/in-process checks, refreshed every 5s): Node, `.env`
  and broker config, Chrome, the gsearch extension, Pi, the research-contact
  skill, `pdftotext`, the LinkedIn toolchain, the Scrapling venv, Obscura, and —
  only when their job types are claimed — agy, ego-browser and the gmap-recon
  binaries.
- **Deep layer** (button-activated, TTL-cached): broker reachability, a real
  `pi --version` spawn, Scrapling/Obscura MCP handshakes, and a LinkedIn session
  validity probe. These start real child processes and can take minutes, so they
  never run on the periodic refresh.
- Every check carries a severity derived from this device's `WORKER_TYPES`:
  `REQUIRED` failures make the banner **Setup incomplete**; relevant optional
  gaps show as warnings; tools for unclaimed job types are marked `NOT NEEDED`
  and never block. The Obscura 0.2.2 built-in MCP `tools/list` defect is
  reported as the known defect it is, not as an unknown failure.

The CLI mirror of the same checklist (plus `.env` bootstrap and the manual
install steps it cannot automate) is:

```cmd
npm run setup
node setup.mjs --checks
node setup.mjs --deep
```

A note on "just bundle everything into a dist": the pieces that break a new
device — Chrome and its logins, the gsearch extension (manual Load unpacked),
CLIs with their own credentials, the Python venv, LinkedIn cookies — are runtime
state, not code, and cannot be shipped. `setup.mjs` automates the automatable
(`.env`, `--install-skill`), prints the exact manual steps, and the checklist
verifies the rest.

---

## 5. Verification

### Test 1: Proof of Connection (Ping)
When started, the console will print:
```text
[2026-09-21 15:30:00] worker "windows-pc-1" -> https://ee-auto.up.railway.app
[2026-09-21 15:30:00] lane "windows-pc-1" -> https://ee-auto.up.railway.app (ping, gmap.scan, agy.ask)
```

### Test 2: Local Maps Scan Test
Test your local Chrome driver standalone:
```cmd
node gmap.mjs "cafe" "nilai" 5
```

### Test 3: Research-Contact Handler Test
Check the new lane's dependencies without starting a research run:
```cmd
node research-contact.mjs probe
```
It reports whether the Skill, Pi, `pdftotext`, and the local gsearch bridge are available. Run one report locally with:
```cmd
node research-contact.mjs contact "{\"name\":\"Example Energy\",\"domain\":\"example.com\"}"
```

### Test 4: Central Cloud Verification
Check active workers registered on Railway:
```cmd
node check-status.mjs
```
You will see your Windows worker listed in the `workers` array with its last seen timestamp and public IP.

---

## 6. Research-Contact Job Contract

`research.contact` runs the Agent Skill in `scrapling-deep/agent-skill/research-contact` non-interactively and returns that Skill's final report object. Contact research has no duration deadline. The adapter reads Pi's `agent_end` JSON event, then gives extension cleanup a separate five-second window. A completed answer is accepted even if MCP teardown leaves the Pi process open. The worker saves each answer to a local outbox before posting it to the report service and retries delivery after outages or restarts.

Queue payload (extra keys are ignored):

| Field | Required | Meaning |
| :--- | :--- | :--- |
| `name` / `company` | one of name or domain | Company or organisation name used for search and LinkedIn queries |
| `domain` / `website` / `url` | one of name or domain | Public site used for the deterministic recon step |
| `extraUrls` | no | Up to 20 public HTTP(S) URLs to add to recon (team, leadership, contact pages) |
| `location` / `city` / `country` | no | Locale hint for search queries |
| `locale` / `language` | no | Search interface language, e.g. `en`, `ms` |
| `timeoutMs` | no | Ignored for contact research; retained in older queued jobs for compatibility. |

Result on success: `{ cheat_sheet, decision_makers, phone_contacts, email_contacts }`, matching the Skill's existing output shape. Evidence URLs are expected inside each entry.

Failure codes reported to the broker: `bad_request` (invalid payload), `not_installed` (Pi or the Skill is missing), `timeout`, `needs_human` (CAPTCHA, expired LinkedIn session, or a closed Chrome/gsearch extension), and `engine_error` (the agent failed or returned something that is not the required JSON object).

> **Note:** this repository is the worker consumer only. The cloud broker that creates and allows job types lives in the ee-auto service, so `research.contact` must also be allowed there before it can be queued end-to-end.
