# Offline collector for the obfuscated `index.html` "Load" page

`collector.py` restores the real page from a **saved copy** of `index.html`
(pure text in, JSON out). It never uses a DOM, never executes the page's
script, and never touches the network. `index.html` itself is unmodified, so
its in-browser rendering behaviour stays exactly the same.

## How the page hides its body

`index.html` contains nine `<template id="_jXhml5N">` fragments (N = 0…8). The
inline script concatenates them in id order, Base64-decodes the result, XORs
each byte with a constant key (itself Base64 in `atob('...')`), decodes the
bytes as UTF-8, and `document.write`s the result. The collector re-implements
that pipeline in Python, reading the key, the fragment prefix and the fragment
count straight out of the saved script text.

## API

```python
import collector

result = collector.collect_page(html_text)     # str or UTF-8 bytes
result = collector.collect_file("saved.html")  # reads bytes from disk
```

Result fields:

| key | meaning |
| --- | --- |
| `ok` / `success` | `True` only if the page was fully restored |
| `html` | restored HTML text on success, `None` on failure |
| `reason` | `""` on success; otherwise `missing_fragment`, `payload_corrupted`, or `script_error` |
| `detail` | human-readable explanation |
| `missing_fragment_ids` | every absent template id, e.g. `["_jXhml53"]` |
| `payload_error` | `invalid_base64` / `invalid_utf8` / `empty_fragment` when `reason` is `payload_corrupted` |
| `fragment_prefix`, `fragments_expected`, `fragments_found` | layout diagnostics |

Reason classes:

- **`missing_fragment`** — a `<template id="_jXhml5N">` is absent. The expected
  id list comes from the script's `for (i = 0; i < 9; i++)` loop header, so a
  missing *last* fragment is caught too. `missing_fragment_ids` names each one.
- **`payload_corrupted`** — all fragments present but the data cannot be
  restored: Base64 illegal (bad alphabet or length not a multiple of 4), or the
  XOR result is not valid UTF-8.
- **`script_error`** — the decoding script could not be interpreted (missing
  `atob('...')` key, invalid key Base64, no fragments/loop at all) or an
  unexpected internal error occurred.

## CLI

```bash
python collector.py saved.html                 # JSON to stdout, exit 0/1
python collector.py saved.html -o result.json  # also write UTF-8 JSON
python collector.py saved.html --compact --ascii
```

Exit codes: `0` restored, `1` not restored (inspect `reason`), `2` unreadable
input/output file. On legacy Windows code pages the stdout JSON automatically
falls back to `\uXXXX` escapes (`--ascii` forces that).

## Samples and tests

`python -I samples/build_samples.py` regenerates the sample pages:

| sample | expected result |
| --- | --- |
| `sample_ok.html` | success |
| `sample_missing_fragment.html` | `missing_fragment`, `["_jXhml53"]` |
| `sample_missing_last_fragment.html` | `missing_fragment`, `["_jXhml58"]` |
| `sample_bad_base64.html` | `payload_corrupted` / `invalid_base64` |
| `sample_bad_utf8.html` | `payload_corrupted` / `invalid_utf8` |

Run the tests (20 cases, including a real-`index.html` round-trip):

```bash
python -I -m pytest tests/test_collector.py -q
```
