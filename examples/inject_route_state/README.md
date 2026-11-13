# Injection-Route Installation State — Local Samples

These samples verify the observable installation state of Patchright's
injection route on `BrowserContext` and `Page` (async and sync APIs). They
drive a real Chromium against a page served by a **local HTTP server**, so
no external network access is required.

## Files

- `conftest.py` — local HTTP-server fixture and browser launch options.
- `test_inject_route_async.py` — async acceptance paths (14 cases).
- `test_inject_route_sync.py` — sync acceptance paths (6 cases).
- `run_inject_route_demo.py` — single self-contained script walking every
  path without pytest.

## Covered paths

1. First installation succeeds (`not_installed` → `installed`).
2. An installation error leaves the object in `failed` with the reason in
   `state.error`.
3. Retrying after a failure succeeds and clears the error.
4. Repeated calls after success never mount a second route (idempotent).
5. Concurrent triggers on the same object mount exactly one route; a page
   reuses an already-installed / in-flight context-level route.

## Running

The samples import an installed, patched `patchright` package. Point them at
an available Chromium/Chrome executable via the environment variable:

```bash
export PATCHRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome.exe

# pytest suites
pytest examples/inject_route_state/ -o asyncio_mode=auto

# standalone demo
python examples/inject_route_state/run_inject_route_demo.py
```

Without the environment variable, the fixtures fall back to the
ms-playwright browser registry and a system Chrome install.
