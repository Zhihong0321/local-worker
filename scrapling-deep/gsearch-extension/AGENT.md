# gsearch — Google search tool (for AI agents)

Search Google from this machine and get structured JSON results back. Each search runs in the user's real
Chrome, so Google treats it as a normal person searching (no CAPTCHA walls like headless browsers get).

## Endpoint

```
POST http://127.0.0.1:18787/search
Content-Type: application/json
```

Local machine only. Nothing to install: it's served by the running `local-worker` (`worker.mjs`).

### Request body

| field | type | default | meaning |
|---|---|---|---|
| `query` | string | **required** | The search, exactly as you'd type it into Google. Operators work: `site:`, `"exact phrase"`, `-exclude`, `OR`, `filetype:pdf`, `intitle:`, `after:2026-01-01` |
| `pages` | int 1–5 | 1 | Google result pages to fetch. About 10 results per page, so `3` gives about 30 |
| `hl` | string | Chrome's language | Interface language, e.g. `en`, `ms`, `zh-CN` |
| `gl` | string | user's location | Country to search from, e.g. `my`, `sg`, `us` |
| `tbs` | string | – | Time filter: `qdr:h` past hour, `qdr:d` day, `qdr:w` week, `qdr:m` month, `qdr:y` year |
| `captchaWaitMs` | int | 180000 | How long to wait for the human to solve a CAPTCHA if one appears |

### Response (HTTP 200)

```json
{
  "query": "solar installer kuala lumpur",
  "url": "https://www.google.com/search?q=...",
  "stats": "About 948,000 results (0.35s)",
  "results": [
    { "position": 1, "title": "Solar Panel Installation in Kuala Lumpur",
      "url": "https://trexon.my/locations/kuala-lumpur",
      "snippet": "Trexon Energy is KL's top-rated solar installer with 450+ ..." }
  ],
  "featured": null,
  "knowledge": null,
  "peopleAlsoAsk": ["How much does it cost to install a solar system in Malaysia?"],
  "related": ["Solar installer kuala lumpur price", "Top 10 solar companies in Malaysia"],
  "tookMs": 3200
}
```

- `results`: organic results only (no ads), in Google's order, deduplicated by URL.
- `featured`: Google's featured-snippet or answer-box text, when shown.
- `knowledge`: `{title, description}` from the knowledge panel, when shown.
- `peopleAlsoAsk` / `related`: useful for follow-up queries.
- Any of `featured`, `knowledge`, `stats` can be `null`, and the lists can be empty.

### Errors

| HTTP | `code` | what to do |
|---|---|---|
| 400 | `bad_request` | `query` missing, so fix the request |
| 503 | `extension_offline` | Chrome is closed or the extension is disabled. Tell the user; retrying won't help |
| 429 | `captcha` | Google asked for a CAPTCHA and nobody solved it. Stop searching and tell the user |
| 504 | `timeout` | Retry once, then give up |

Error body: `{ "error": "message", "code": "..." }`

## Examples

```bash
curl -s -X POST http://127.0.0.1:18787/search -H "content-type: application/json" \
  -d '{"query":"solar installer kuala lumpur"}'

# ~30 results, Malaysia, past month
curl -s -X POST http://127.0.0.1:18787/search -H "content-type: application/json" \
  -d '{"query":"solar installer kuala lumpur","pages":3,"gl":"my","tbs":"qdr:m"}'
```

```js
const r = await fetch('http://127.0.0.1:18787/search', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'site:linkedin.com "solar" "kuala lumpur" manager', pages: 2 }),
});
const data = await r.json();
if (!r.ok) throw new Error(data.code + ': ' + data.error);
for (const x of data.results) console.log(x.position, x.title, x.url);
```

```python
import requests
data = requests.post("http://127.0.0.1:18787/search",
                     json={"query": "deepseek api pricing"}, timeout=300).json()
```

Health check: `GET http://127.0.0.1:18787/status`. `extension.connected` must be `true`.

## Rules for using it well

1. **It is slow on purpose.** Searches run one at a time with a 3–6s gap between them, so expect 3–10s per search
   and about 5s more per extra page. Set your HTTP timeout to **300s**, because a CAPTCHA can hold a search for minutes.
2. **Don't fire searches in parallel.** They queue anyway, and bursts are what trigger CAPTCHAs.
3. **Prefer better queries over more pages.** Use `site:`, quotes and `-exclude` to narrow the search. Page 1 of a
   precise query beats 5 pages of a vague one.
4. **Budget:** keep to about 20–30 searches in one task. Past that, Google gets suspicious even of a real browser.
5. **Snippets aren't the page.** To read a result, fetch its `url` with your normal page-fetching tool.
6. **On `captcha` or `extension_offline`, stop and report to the user.** Both need a human.
7. `pages` is capped at 5 (about 50 results). If you need more, use different queries rather than deeper pages.
8. Google only ever serves about 10 results per page. The old `num=30`/`num=100` URL trick no longer works, so use `pages`.

## Via the lab (optional)

The same search is also a worker job type. Queue `gsearch.search` on ee-auto with the same payload as above.
`gsearch.probe` returns the connection status.
