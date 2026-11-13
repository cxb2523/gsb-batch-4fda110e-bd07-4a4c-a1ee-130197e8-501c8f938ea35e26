"""Sync acceptance tests for the injection-route installation state API.

Mirrors the async suite through the synchronous ``sync_playwright`` API,
proving the sync side reads the same state and uses the same retry rules.
"""

import pytest

from patchright.sync_api import InjectRouteStatus, sync_playwright


def _new_context_page(p, launch_kwargs):
    browser = p.chromium.launch(**launch_kwargs)
    context = browser.new_context()
    page = context.new_page()
    return browser, context, page


def test_sync_context_full_lifecycle(launch_kwargs, http_server):
    with sync_playwright() as p:
        browser, context, page = _new_context_page(p, launch_kwargs)
        try:
            state = context.get_inject_route_state()
            assert state.status == InjectRouteStatus.NOT_INSTALLED
            assert state.error is None

            context.install_inject_route()

            state = context.get_inject_route_state()
            assert state.status == InjectRouteStatus.INSTALLED
            assert state.error is None
            assert len(context._impl_obj._routes) == 1

            # Idempotent: no extra route.
            context.install_inject_route()
            context.install_inject_route()
            assert len(context._impl_obj._routes) == 1

            response = page.goto(http_server)
            assert response.status == 200
            assert "hello patchright" in page.content()
        finally:
            browser.close()


def test_sync_page_full_lifecycle(launch_kwargs, http_server):
    with sync_playwright() as p:
        browser, context, page = _new_context_page(p, launch_kwargs)
        try:
            assert page.get_inject_route_state().status == InjectRouteStatus.NOT_INSTALLED

            page.install_inject_route()
            assert page.get_inject_route_state().status == InjectRouteStatus.INSTALLED
            assert len(page._impl_obj._routes) == 1

            page.install_inject_route()
            assert len(page._impl_obj._routes) == 1

            response = page.goto(http_server)
            assert response.status == 200
        finally:
            browser.close()


def test_sync_failure_reason_then_retry(launch_kwargs):
    with sync_playwright() as p:
        browser, context, _ = _new_context_page(p, launch_kwargs)
        try:
            impl = context._impl_obj
            calls = {"n": 0}
            real_update = impl._update_interception_patterns

            async def flaky():
                calls["n"] += 1
                if calls["n"] == 1:
                    raise RuntimeError("sync-boom")
                return await real_update()

            impl._update_interception_patterns = flaky

            with pytest.raises(RuntimeError, match="sync-boom"):
                context.install_inject_route()

            state = context.get_inject_route_state()
            assert state.status == InjectRouteStatus.FAILED
            assert "sync-boom" in state.error
            assert impl._routes == []

            impl._update_interception_patterns = real_update
            context.install_inject_route()
            state = context.get_inject_route_state()
            assert state.status == InjectRouteStatus.INSTALLED
            assert state.error is None
            assert len(impl._routes) == 1
        finally:
            browser.close()


def test_sync_page_failure_reason_then_retry(launch_kwargs):
    with sync_playwright() as p:
        browser, _, page = _new_context_page(p, launch_kwargs)
        try:
            impl = page._impl_obj
            calls = {"n": 0}
            real_update = impl._update_interception_patterns

            async def flaky():
                calls["n"] += 1
                if calls["n"] == 1:
                    raise RuntimeError("sync-page-boom")
                return await real_update()

            impl._update_interception_patterns = flaky

            with pytest.raises(RuntimeError, match="sync-page-boom"):
                page.install_inject_route()
            assert page.get_inject_route_state().status == InjectRouteStatus.FAILED
            assert "sync-page-boom" in page.get_inject_route_state().error

            impl._update_interception_patterns = real_update
            page.install_inject_route()
            assert page.get_inject_route_state().status == InjectRouteStatus.INSTALLED
            assert len(impl._routes) == 1
        finally:
            browser.close()


def test_sync_idempotent_under_repeated_calls(launch_kwargs):
    # The sync API is single-threaded (greenlet driven), so true concurrency
    # is exercised in the async suite. Here we assert the sync install entry
    # keeps exactly one route even under a burst of sequential calls.
    with sync_playwright() as p:
        browser, context, _ = _new_context_page(p, launch_kwargs)
        try:
            impl = context._impl_obj
            for _ in range(5):
                context.install_inject_route()
            assert context.get_inject_route_state().status == InjectRouteStatus.INSTALLED
            assert len(impl._routes) == 1
        finally:
            browser.close()


def test_sync_and_async_status_constants_match():
    from patchright.async_api import InjectRouteStatus as AsyncStatus

    assert InjectRouteStatus.NOT_INSTALLED == AsyncStatus.NOT_INSTALLED
    assert InjectRouteStatus.INSTALLING == AsyncStatus.INSTALLING
    assert InjectRouteStatus.INSTALLED == AsyncStatus.INSTALLED
    assert InjectRouteStatus.FAILED == AsyncStatus.FAILED
