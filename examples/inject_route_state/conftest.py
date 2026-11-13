"""Local HTTP server + browser fixtures for the injection-route acceptance tests.

The tests drive a real Chromium via Patchright against pages served from a
local HTTP server (no external network access needed).

Set ``PATCHRIGHT_CHROMIUM_EXECUTABLE`` to an explicit Chromium/Chrome
executable when the Playwright browser registry is unavailable.
"""

import functools
import http.server
import os
import socketserver
import tempfile

import pytest


def _chromium_executable():
    explicit = os.environ.get("PATCHRIGHT_CHROMIUM_EXECUTABLE")
    if explicit and os.path.exists(explicit):
        return explicit
    candidates = [
        # ms-playwright registry layout (revision-independent fallback)
        os.path.expandvars(
            r"%LOCALAPPDATA%\ms-playwright\chromium-1187\chrome-win\chrome.exe"
        ),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    ]
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    return None


@pytest.fixture(scope="session")
def http_server():
    www = tempfile.mkdtemp(prefix="patchright_www_")
    with open(os.path.join(www, "index.html"), "w", encoding="utf-8") as f:
        f.write("<html><body><h1>hello patchright</h1></body></html>")

    class _QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, format, *args):  # silence request logging
            pass

    handler = functools.partial(_QuietHandler, directory=www)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    import threading

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{httpd.server_address[1]}/index.html"
    yield base_url
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture
def launch_kwargs():
    kwargs = {"headless": True}
    executable = _chromium_executable()
    if executable:
        kwargs["executable_path"] = executable
    return kwargs
