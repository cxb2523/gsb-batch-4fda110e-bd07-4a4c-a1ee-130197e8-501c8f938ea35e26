"""Standalone local sample for the injection-route installation state API.

Serves a page from a local HTTP server and walks every acceptance path
without requiring pytest:

  1. first installation succeeds
  2. an installation error is queryable with its failure reason
  3. retry after a failure succeeds
  4. repeated calls after success do not add another route
  5. concurrent triggers mount the route only once

Run with a patched-and-installed patchright package, e.g.::

    PATCHRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome.exe python run_inject_route_demo.py
"""

import asyncio
import functools
import http.server
import os
import socketserver
import tempfile
import threading

from patchright.async_api import InjectRouteStatus, async_playwright


def start_http_server():
    www = tempfile.mkdtemp(prefix="patchright_demo_")
    with open(os.path.join(www, "index.html"), "w", encoding="utf-8") as f:
        f.write("<html><body><h1>hello patchright</h1></body></html>")

    class _QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

    handler = functools.partial(_QuietHandler, directory=www)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/index.html"


def launch_kwargs():
    kwargs = {"headless": True}
    executable = os.environ.get("PATCHRIGHT_CHROMIUM_EXECUTABLE")
    if executable:
        kwargs["executable_path"] = executable
    return kwargs


async def main():
    httpd, url = start_http_server()
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(**launch_kwargs())
            context = await browser.new_context()
            page = await context.new_page()

            # 1. first installation succeeds --------------------------------
            state = await context.get_inject_route_state()
            assert state.status == InjectRouteStatus.NOT_INSTALLED, state
            await context.install_inject_route()
            state = await context.get_inject_route_state()
            assert state.status == InjectRouteStatus.INSTALLED, state
            assert state.error is None
            response = await page.goto(url)
            assert response.status == 200
            print("1. first install ok; page loads:", response.status)

            # 4. repeated calls do not add another route --------------------
            await context.install_inject_route()
            await context.install_inject_route()
            assert len(context._impl_obj._routes) == 1
            print("4. repeated install stays at one route")

            # Page sees the context route and does not mount its own.
            await page.install_inject_route()
            assert (await page.get_inject_route_state()).status == InjectRouteStatus.INSTALLED
            assert page._impl_obj._routes == []
            print("   page reuses the context-level route")

            await browser.close()

            # Fresh context for failure / retry / concurrency paths.
            browser = await p.chromium.launch(**launch_kwargs())
            context = await browser.new_context()
            impl = context._impl_obj
            real_update = impl._update_interception_patterns
            attempts = {"n": 0}

            async def flaky_update():
                attempts["n"] += 1
                if attempts["n"] == 1:
                    raise RuntimeError("simulated interception failure")
                return await real_update()

            impl._update_interception_patterns = flaky_update

            # 2. failure reason is queryable --------------------------------
            try:
                await context.install_inject_route()
            except RuntimeError as exc:
                print("2. install raised as expected:", exc)
            state = await context.get_inject_route_state()
            assert state.status == InjectRouteStatus.FAILED, state
            assert "simulated interception failure" in state.error
            assert impl._routes == []  # no partial route left behind
            print("   failed state with reason:", state.error)

            # 3. retry after failure succeeds -------------------------------
            impl._update_interception_patterns = real_update
            await context.install_inject_route()
            state = await context.get_inject_route_state()
            assert state.status == InjectRouteStatus.INSTALLED, state
            assert state.error is None
            print("3. retry after failure ok")

            await browser.close()

            # 5. concurrent triggers mount only one route -------------------
            browser = await p.chromium.launch(**launch_kwargs())
            context = await browser.new_context()
            impl = context._impl_obj
            results = await asyncio.gather(
                impl.install_inject_route(),
                impl.install_inject_route(),
                impl.install_inject_route(),
                return_exceptions=True,
            )
            assert results == [None, None, None], results
            assert (await context.get_inject_route_state()).status == InjectRouteStatus.INSTALLED
            assert len(impl._routes) == 1
            print("5. three concurrent installs produced exactly one route")
            await browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
    print("ALL DEMO PATHS OK")


if __name__ == "__main__":
    asyncio.run(main())
