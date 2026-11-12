"""Shared test fixtures.

All company pages are self-made static HTML served by a local HTTP server:
no real career site, Discord webhook or production database is ever used.
"""

import functools
import http.server
import socketserver
import threading
from pathlib import Path

import pytest

JOBS_EL = ".job"
TITLES_EL = "h2"
# evaluate_all expression matching scrapers/scraper.py usage: receives the
# matched job elements and returns their href values.
LINKS_EXPR = "els => els.map(el => el.querySelector('a').href)"


def write_page(directory: Path, name: str, body: str) -> str:
    path = directory / name
    path.write_text(body, encoding="utf-8")
    return f"/{name}"


def jobs_page(jobs: list[tuple[str, str]]) -> str:
    """Build a sample career page from (title, href) pairs."""
    items = "\n".join(
        f'<div class="job"><h2>{title}</h2><a href="{href}">view</a></div>'
        for title, href in jobs
    )
    return f"<html><body><main>{items}</main></body></html>"


@pytest.fixture(scope="session")
def web_server(tmp_path_factory):
    web_root = tmp_path_factory.mktemp("www")
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(web_root)
    )

    class QuietServer(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    server = QuietServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    host, port = server.server_address
    base_url = f"http://127.0.0.1:{port}"
    yield base_url, web_root

    server.shutdown()
    server.server_close()


@pytest.fixture
def make_company(web_server):
    base_url, web_root = web_server
    counter = {"n": 0}

    def _make(jobs: list[tuple[str, str]] | None = None, *, missing_selector=False):
        counter["n"] += 1
        name = f"page-{counter['n']}.html"
        if missing_selector:
            body = "<html><body><p>no jobs container here</p></body></html>"
        else:
            body = jobs_page(jobs or [])
        path = write_page(web_root, name, body)
        return {
            "company": f"Company {counter['n']}",
            "link": f"{base_url}{path}",
            "jobs_el": JOBS_EL,
            "titles_el": TITLES_EL,
            "links_el": LINKS_EXPR,
        }

    return _make


@pytest.fixture
async def browser_context():
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        yield context
        await context.close()
        await browser.close()
