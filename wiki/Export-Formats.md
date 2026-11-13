# 📦 Export Formats

You can export the same capture in four formats. Pick the one that matches your downstream tool.

## ⬇ ZIP — full archive (recommended)
The **richest** export. One archive contains everything you could ever want:

```
network_capture_<timestamp>.zip
├─ index.html                   ← clickable browsable summary
├─ summary.json                 ← capture metadata
├─ manifest.json                ← machine-readable session checklist
├─ all_requests.json            ← every request in one big file
├─ capture.har                  ← HAR 1.2 — open in DevTools/Postman
├─ capture.csv                  ← spreadsheet-friendly summary
├─ counter_and_time.txt         ← human-readable counter + timings
├─ requests/<NNNNN>_<host>_<METHOD>.json   ← per-request detail JSON
├─ bodies/<NNNNN>_<host>.<ext>             ← raw response bodies
├─ post_data/<NNNNN>_<host>.txt            ← raw POST/PUT bodies
└─ cookies/{request,response}_cookies.json ← every cookie, parsed
```

**Best for:** bug reports, archives, sharing with teammates.

### `manifest.json` — the checklist to verify against

Everything in the archive falls in capture order, and `manifest.json` is the index you
can check without opening every file:

```json
{
  "generatedAt": "2026-04-28T14:02:33.512Z",
  "capture": {
    "startedAt": "2026-04-28T14:02:33.000Z",
    "endedAt": "2026-04-28T14:02:43.000Z",
    "tabUrl": "https://example.com/",
    "pausedMs": 0,
    "pauseWindows": []
  },
  "totalRequests": 3,
  "succeededCount": 2,
  "failedCount": 1,
  "bodyMissingCount": 2,
  "missingResponseBody": ["00001", "00002"],
  "requests": [
    {
      "index": 1,
      "fileIndex": "00001",
      "method": "GET",
      "url": "https://a.example.com/broken",
      "status": null,
      "failed": true,
      "error": "net::ERR_CONNECTION_REFUSED",
      "bodyError": null,
      "hasResponseBody": false,
      "detailFile": "requests/00001_a.example.com_GET.json",
      "bodyFile": null
    }
  ]
}
```

- `fileIndex` is the exact five-digit prefix used by the `requests/` and `bodies/`
  file names, so you can cross-reference by eye.
- `missingResponseBody` lists every request that produced no `bodies/` file —
  including ones whose `Network.getResponseBody` failed (see `bodyError`).
- `capture.pauseWindows` records each paused interval. While paused, CDP events are
  ignored, so requests in those windows are simply not in the archive — the manifest
  says so instead of leaving you to guess.
- Requests recorded while paused are never in the set; and once an export runs,
  new requests (e.g. after resuming) do not appear in that already-built manifest.

If nothing has been captured yet, the ZIP button is rejected with a readable error
instead of producing an empty archive.

## ⬇ JSON
A single `.json` file with `{ meta, requests: [...] }`. Identical structure to `all_requests.json` inside the ZIP, but flat.

**Best for:** scripts (`jq`, Python `json.load`, Node), AI tooling, custom dashboards.

## ⬇ HAR
A **standard HTTP Archive 1.2** file. Drop it into:

- Chrome DevTools → Network → 🔼 *Import HAR*
- Firefox DevTools → Network → 📁 *Import*
- **Postman** → File → Import → choose the .har → instant collection
- **Charles Proxy** / **Insomnia** / **Fiddler** / **Paw**
- Online HAR viewers like [HAR Analyzer](https://toolbox.googleapps.com/apps/har_analyzer/)

Includes response bodies (text + base64 for binary).

**Best for:** team handoff, replay in DevTools-class tools, perf analysis.

## ⬇ CSV
A flat row-per-request summary:

```
#,time,method,status,type,host,path,duration_ms,bytes,mime,remote,request_cookies,response_set_cookies,url
1,2026-04-28T14:02:33.000Z,GET,200,Document,example.com,/,123,4521,text/html,93.184.216.34:443,sid=abc; theme=dark,session_id=…,https://example.com/
```

**Best for:** Excel, Google Sheets, quick stats, pivot tables.

---

## Comparison cheat-sheet

| Need | Use |
|---|---|
| Send to a teammate, capture-as-evidence | **ZIP** |
| Replay in DevTools, Postman, Charles | **HAR** |
| Pipe through `jq` / Python / AI | **JSON** |
| Spreadsheet, charts, KPIs | **CSV** |
| All of the above | **ZIP** (it includes HAR + CSV + JSON inside) |

## File naming
All exports use ISO-8601 timestamps so they sort lexicographically:

```
network_capture_2026-04-28T14-02-33-512Z.zip
network_capture_2026-04-28T14-02-33-512Z.har
…
```

You can change the destination folder in `chrome://settings/downloads`.
