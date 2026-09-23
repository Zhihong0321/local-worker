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
   - Jobs (Google Maps scanning, Antigravity contact research, ChatGPT audits) queue on Railway.
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

---

## 3. Windows Setup Guide

### Step 1: Install Prerequisites
1. **Node.js**: Install Node.js **v20 or higher** (LTS recommended) from [nodejs.org](https://nodejs.org/).
2. **Google Chrome**: Install standard [Google Chrome](https://www.google.com/chrome/). (Worker auto-detects `C:\Program Files\Google\Chrome\Application\chrome.exe`).
3. *(Optional)* **Antigravity CLI**: If running `agy.ask` jobs, ensure `agy` is installed and logged in.

### Step 2: Clone & Configure
Open **Command Prompt** or **PowerShell**:

```cmd
git clone https://github.com/Zhihong0321/local-worker.git
cd local-worker
copy .env.example .env
```

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

---

## 5. Verification

After the hub and worker updates are deployed, run `npm run health`. The hub probes its own `DATABASE_URL` and scan-table write grants, then sends a targeted `worker.health` job to every registered online lane. A Maps lane also verifies that its local recovery directory is writable. `pending` means a busy lane has not run its check yet; `unsupported` means that lane still runs an older worker version. Use the printed job ID with `GET /api/jobs/:id` to inspect a pending check later. This check does not run a Maps scrape or insert a company.

The hub saves each scan through its `DATABASE_URL`; the worker does not need a database proxy token. For each report scan, the worker keeps a local copy in `~/.gmap-worker/unsaved-scans/` (or `WORKER_RECOVERY_DIR`). If hub persistence fails, run `node replay-scan.mjs PATH_TO_RECOVERY_JSON` after the hub recovers to save the harvested companies into the original report without reopening Google Maps. Keep the JSON until the report appears in the map, then remove old copies as part of routine disk maintenance.

### Hub-triggered updates

After this version is installed once on each machine, the hub can send a targeted `worker.update` job to one lane per worker process. The worker finishes active jobs, fetches the approved `local-worker` `main` branch, checks the pinned commit, fast-forwards a clean checkout, reports the result, then exits. The Windows launchers and PM2 restart it. A Mac launchd service must have `KeepAlive` enabled for the same handoff. The hub's response includes a job ID for each update, and `GET /api/jobs/:id` shows its result.

Set a separate `WORKER_OTA_ADMIN_TOKEN` (at least 32 random characters) **only on the hub and the operator machine**. Do not put it in a worker `.env` file. To trigger every online update coordinator from an operator shell after merging a worker release to `main`:

```sh
curl -X POST https://ee-auto.up.railway.app/api/jobs/update-workers \
  -H "Authorization: Bearer $LAB_TOKEN" \
  -H "X-Worker-Update-Token: $WORKER_OTA_ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{}'
```

In PowerShell, use `Invoke-RestMethod -Method Post -Uri https://ee-auto.up.railway.app/api/jobs/update-workers -Headers @{ Authorization = "Bearer $env:LAB_TOKEN"; 'X-Worker-Update-Token' = $env:WORKER_OTA_ADMIN_TOKEN } -ContentType 'application/json' -Body '{}'`.

The hub pins one GitHub `main` commit for the whole run. It does not accept arbitrary commands, URLs, or branches. A worker refuses to overwrite tracked local edits or divergent history. Check `git status --short` on any machine reported as failed, review those edits, then rerun the hub update. Existing workers that do not yet advertise `worker.update` appear as unsupported and need one manual update and restart to gain OTA support. A worker started directly with `node worker.mjs`, without a restarting supervisor, will exit after updating and must be started again manually.

For a Mac mini, clone this repository and copy `launchd/com.eternalgy.local-worker.plist.example` to `~/Library/LaunchAgents/com.eternalgy.local-worker.plist`. Replace the absolute Node, repository, env-file, and existing log-directory placeholders, then run `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.eternalgy.local-worker.plist`. Check `launchctl print gui/$(id -u)/com.eternalgy.local-worker` and the configured logs. `RunAtLoad` and `KeepAlive` restart the worker after an OTA handoff. If running multiple worker processes, give each a distinct launchd label, worker name, and Git checkout so an update to one process cannot replace files used by another active process.

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

### Test 3: Central Cloud Verification
Check active workers registered on Railway:
```cmd
curl -s -H "Authorization: Bearer YOUR_LAB_TOKEN" https://ee-auto.up.railway.app/api/jobs
```
You will see your Windows worker listed in the `workers` array with its last seen timestamp and public IP.
