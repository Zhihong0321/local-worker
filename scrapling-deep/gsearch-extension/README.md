# gsearch bridge

Google search for the AI agent, run inside your real Chrome so Google sees a person rather than a bot.
There's no separate server: the bridge runs inside `worker.mjs` (see `gsearch.mjs` at the repo root).

```
agent ──POST /search──► worker.mjs (127.0.0.1:18787) ◄──WebSocket── this extension ──► background Google tab
```

## Setup

1. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick this folder.
2. Start the worker as usual (`start-worker.bat`). The log shows `[gsearch] listening on http://127.0.0.1:18787`,
   then `extension connected` within about 30s.
3. The extension badge shows `off` while it isn't connected. The popup shows status and lets you change the port.

## Use

```bash
curl -s -X POST http://127.0.0.1:18787/search -H "content-type: application/json" -d "{\"query\":\"solar installer kuala lumpur\"}"
```

Body: `query` (required), `pages` (1–5, 10 results each), `hl`, `gl`, `tbs` (for example `qdr:d` = past day), `captchaWaitMs`.

Response:

```json
{ "query": "...", "url": "...", "stats": "...",
  "results": [{ "position": 1, "title": "...", "url": "https://...", "snippet": "..." }],
  "featured": null, "knowledge": null, "peopleAlsoAsk": [], "related": [], "tookMs": 2100 }
```

`GET /status` reports whether the extension is connected. From the lab, queue the job type `gsearch.search` with the
same payload (lane `-gs`).

Errors: `503 extension_offline`, `429 captcha` (not solved in time), `504 timeout`.

## Behaviour

- Queries run one at a time, with a random 3–6s gap between them (`GSEARCH_GAP_MIN_MS` / `GSEARCH_GAP_MAX_MS`).
  Bursts get CAPTCHA'd even in a real browser.
- If Google shows a CAPTCHA, the tab comes to the front and waits up to 3 min for you to solve it. The query then continues.
- One reused background tab, closed after 2 min idle.
- Worker env: `GSEARCH_PORT` (18787), `GSEARCH_TOKEN` (optional bearer for `/search`), `GSEARCH_DISABLE=1`.
