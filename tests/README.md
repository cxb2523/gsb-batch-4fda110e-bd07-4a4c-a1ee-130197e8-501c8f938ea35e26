# Boot loader tests

Tests for the self-decoding boot loader in `index.html` /
`public/index.html`. Everything runs locally: no external network access, no
credentials, and all payload shards are self-made minimal samples.

## What is verified

The boot loader publishes an observable result object on the fixed window
field `window.__DECODE_RESULT__`:

| Field | Meaning |
| --- | --- |
| `status` | `'success'` or `'failure'` |
| `reason` | `null` on success; otherwise one of `missing_shards`, `invalid_key`, `invalid_payload`, `invalid_html` |
| `reasonMessage` | Human-readable English description of the failure reason |
| `shardsPresent` | Number of shard elements actually found and joined |
| `expectedShards` | Always `6` (`I8lRE4RIeb0` … `I8lRE4RIeb5`) |
| `missingShardIds` | IDs of the missing shard elements (`[]` on success) |
| `decodedBytes` | Byte count after Base64 decode + XOR restore (`0` if never reached) |
| `scriptsExecuted` | Number of payload scripts re-inserted and executed |

The object is frozen (`Object.isFrozen(...) === true`) before the boot
loader returns, on both success and failure paths.

Failure safety guarantee: no validation failure can replace
`document.body` or execute scripts from a bad payload. All five validation
stages (shards present → key non-empty → Base64 legal/non-empty → strict
UTF-8 → restored text is HTML) run before any DOM mutation.

## Option 1 — automated headless test (recommended)

```sh
node tests/run_tests.js
```

Zero npm dependencies (Node 18+). The script:

1. Extracts the real boot `<script>` and the XOR key from `index.html`.
2. Generates six synthetic fixtures under `tests/fixtures/` (git-ignored):
   - `01-success` — all six shards present; asserts success, restored title,
     copied `<meta>`, body replacement, and both payload scripts executed
     (`scriptsExecuted === 2`).
   - `02-missing-shard` — shard `I8lRE4RIeb3` deleted; asserts
     `missing_shards`, `shardsPresent === 5`, `decodedBytes === 0`,
     `scriptsExecuted === 0`, and the original body marker still present.
   - `03-bad-base64` — shard 2 rewritten with illegal Base64 characters;
     asserts `invalid_payload` and an untouched body.
   - `04-empty-key` — the in-script `atob(...)` key constant replaced with
     `atob('')`; asserts `invalid_key` (no divide-by-zero / loop), untouched
     body and title.
   - `05-invalid-html` — legal Base64/UTF-8 but the restored bytes are plain
     text without a `<body>`; asserts `invalid_html`.
   - `06-empty-payload` — all shard elements present but empty; asserts
     `invalid_payload`.
3. Plus `07-real-page-smoke`: the actual production `index.html` (with its
   real 23,725-byte payload) loaded end-to-end, asserting success,
   `scriptsExecuted === 1`, title restore and body replacement.

The browser is located automatically (`CHROME_BIN` / `EDGE_BIN` overrides
supported; Chrome and Edge on standard Windows paths are detected). Each
fixture runs with `--headless=new --dump-dom` over `file://` and networking
disabled via `--disable-background-networking`.

Expected output ends with:

```
Passed: 52  Failed: 0
ALL TESTS PASSED
```

## Option 2 — manual in-browser test page

Serve the repository root over any static server, then open
`tests/manual_test.html` and click **Run all cases**:

```sh
python -m http.server 8000
# open http://127.0.0.1:8000/tests/manual_test.html
```

The page fetches the real boot script from `../index.html`, builds the same
six minimal fixtures in-page (XOR + Base64), runs each inside a hidden
`srcdoc` iframe, and prints PASS/FAIL lines including the full
`window.__DECODE_RESULT__` report for any failure. A static server is needed
only because Chromium blocks `fetch()` of sibling files from `file://` pages;
the automated option above has no such requirement.

## Failure reason categories

| Reason | Trigger condition |
| --- | --- |
| `missing_shards` | Any of `I8lRE4RIeb0` … `I8lRE4RIeb5` is absent from the DOM; restore stops immediately |
| `invalid_key` | The key `atob` constant throws, or decodes to a zero-length string |
| `invalid_payload` | `atob` on the joined shards throws, or the decoded string is empty |
| `invalid_html` | Strict UTF-8 decoding throws, or restored text contains no `<body>` tag |
