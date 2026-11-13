"""Async acceptance tests for the injection-route installation state API.

Covers, on BrowserContext and Page:
  1. first installation succeeds
  2. installation error is reported with its reason
  3. retry after failure succeeds
  4. repeated calls after success do not add another route
  5. concurrent triggers mount the route only once
"""

import asyncio

import pytest

from patchright.async_api import InjectRouteStatus, async_playwright

pytestmark = pytest.mark.asyncio


async def _new_context_page(p, launch_kwargs):
    browser = await p.chromium.launch(**launch_kwargs)
    context = await browser.new_context()
    page = await context.new_page()
    return browser, context, page


# ---------------------------------------------------------------------------
# 1. first installation succeeds
# ---------------------------------------------------------------------------
async def test_context_first_install_succeeds(launch_kwargs, http_server):
    async with async_playwright() as p:
        browser, context, page = await _new_context_page(p, launch_kwargs)
        try:
            state = await context.get_inject_route_state()
            assert state.status == InjectRouteStatus.NOT_INSTALLED
            assert state.error is None

            # Public install entry point (also invoked internally by
            # add_init_script); call it directly for an explicit assertion.
            await context.install_inject_route()

            state = await context.get_inject_route_state()
            assert state.status == InjectRouteStatus.INSTALLED
            assert state.error is None
            assert len(context._impl_obj._routes) == 1

            response = await page.goto(http_server)
            assert response.status == 200
            assert "hello patchright" in await page.content()
        finally:
            await browser.close()


async def test_page_first_install_succeeds(launch_kwargs, http_server):
    async with async_playwright() as p:
        browser, context, page = await _new_context_page(p, launch_kwargs)
        try:
            state = await page.get_inject_route_state()
            assert state.status == InjectRouteStatus.NOT_INSTALLED

            await page.install_inject_route()

            state = await page.get_inject_route_state()
            assert state.status == InjectRouteStatus.INSTALLED
            assert state.error is None
            assert len(page._impl_obj._routes) == 1

            response = await page.goto(http_server)
            assert response.status == 200
        finally:
            await browser.close()


async def test_status_constants_are_stable_strings():
    assert InjectRouteStatus.NOT_INSTALLED == "not_installed"
    assert InjectRouteStatus.INSTALLING == "installing"
    assert InjectRouteStatus.INSTALLED == "installed"
    assert InjectRouteStatus.FAILED == "failed"


# ---------------------------------------------------------------------------
# 2. installation error keeps the failure reason
# ---------------------------------------------------------------------------
async def test_context_install_failure_reports_reason(launch_kwargs):
    async with async_playwright() as p:
        browser, context, _ = await _new_context_page(p, launch_kwargs)
        try:
            impl = context._impl_obj

            async def boom():
                raise RuntimeError("boom-interception")

            impl._update_interception_patterns = boom

            with pytest.raises(RuntimeError, match="boom-interception"):
                await impl.install_inject_route()

            state = await context.get_inject_route_state()
            assert state.status == InjectRouteStatus.FAILED
            assert "boom-interception" in state.error
            # Failed attempt left no partial route behind.
            assert impl._routes == []
        finally:
            await browser.close()


async def test_page_install_failure_reports_reason(launch_kwargs):
    async with async_playwright() as p:
        browser, _, page = await _new_context_page(p, launch_kwargs)
        try:
            impl = page._impl_obj

            async def boom():
                raise RuntimeError("page-boom")

            impl._update_interception_patterns = boom

            with pytest.raises(RuntimeError, match="page-boom"):
                await impl.install_inject_route()

            state = await page.get_inject_route_state()
            assert state.status == InjectRouteStatus.FAILED
            assert "page-boom" in state.error
            assert impl._routes == []
        finally:
            await browser.close()


# ---------------------------------------------------------------------------
# 3. retry after a failure succeeds
# ---------------------------------------------------------------------------
async def test_context_retry_after_failure_succeeds(launch_kwargs, http_server):
    async with async_playwright() as p:
        browser, context, page = await _new_context_page(p, launch_kwargs)
        try:
            impl = context._impl_obj
            calls = {"n": 0}
            real_update = impl._update_interception_patterns

            async def flaky():
                calls["n"] += 1
                if calls["n"] == 1:
                    raise RuntimeError("transient")
                return await real_update()

            impl._update_interception_patterns = flaky

            with pytest.raises(RuntimeError, match="transient"):
                await impl.install_inject_route()
            assert (await context.get_inject_route_state()).status == InjectRouteStatus.FAILED

            # Retry: FAILED state allows a fresh attempt.
            await impl.install_inject_route()
            state = await context.get_inject_route_state()
            assert state.status == InjectRouteStatus.INSTALLED
            assert state.error is None
            assert len(impl._routes) == 1

            response = await page.goto(http_server)
            assert response.status == 200
        finally:
            await browser.close()


async def test_page_retry_after_failure_succeeds(launch_kwargs):
    async with async_playwright() as p:
        browser, _, page = await _new_context_page(p, launch_kwargs)
        try:
            impl = page._impl_obj
            calls = {"n": 0}
            real_update = impl._update_interception_patterns

            async def flaky():
                calls["n"] += 1
                if calls["n"] == 1:
                    raise RuntimeError("page-transient")
                return await real_update()

            impl._update_interception_patterns = flaky

            with pytest.raises(RuntimeError, match="page-transient"):
                await impl.install_inject_route()
            assert (await page.get_inject_route_state()).status == InjectRouteStatus.FAILED

            await impl.install_inject_route()
            assert (await page.get_inject_route_state()).status == InjectRouteStatus.INSTALLED
            assert len(impl._routes) == 1
        finally:
            await browser.close()


# ---------------------------------------------------------------------------
# 4. repeated calls after success do not mount another route
# ---------------------------------------------------------------------------
async def test_context_repeated_install_is_idempotent(launch_kwargs):
    async with async_playwright() as p:
        browser, context, _ = await _new_context_page(p, launch_kwargs)
        try:
            impl = context._impl_obj
            await impl.install_inject_route()
            assert len(impl._routes) == 1

            await impl.install_inject_route()
            await impl.install_inject_route()
            state = await context.get_inject_route_state()
            assert state.status == InjectRouteStatus.INSTALLED
            assert len(impl._routes) == 1
        finally:
            await browser.close()


async def test_page_repeated_install_is_idempotent(launch_kwargs):
    async with async_playwright() as p:
        browser, _, page = await _new_context_page(p, launch_kwargs)
        try:
            impl = page._impl_obj
            await impl.install_inject_route()
            assert len(impl._routes) == 1

            await impl.install_inject_route()
            await impl.install_inject_route()
            assert (await page.get_inject_route_state()).status == InjectRouteStatus.INSTALLED
            assert len(impl._routes) == 1
        finally:
            await browser.close()


async def test_page_skips_when_context_already_installed(launch_kwargs):
    async with async_playwright() as p:
        browser, context, page = await _new_context_page(p, launch_kwargs)
        try:
            await context.install_inject_route()
            # Page must detect the context-level route and not add its own.
            await page.install_inject_route()
            assert (await page.get_inject_route_state()).status == InjectRouteStatus.INSTALLED
            assert page._impl_obj._routes == []
            assert len(context._impl_obj._routes) == 1
        finally:
            await browser.close()


# ---------------------------------------------------------------------------
# 5. concurrent triggers mount only one route
# ---------------------------------------------------------------------------
async def test_context_concurrent_install_mounts_once(launch_kwargs):
    async with async_playwright() as p:
        browser, context, _ = await _new_context_page(p, launch_kwargs)
        try:
            impl = context._impl_obj
            seen_installing = asyncio.Event()

            real_update = impl._update_interception_patterns

            async def observe():
                # While the first attempt runs, the state must be INSTALLING
                # and the in-flight future must dedupe concurrent callers.
                if impl._inject_route_status == InjectRouteStatus.INSTALLING:
                    seen_installing.set()
                return await real_update()

            impl._update_interception_patterns = observe

            results = await asyncio.gather(
                impl.install_inject_route(),
                impl.install_inject_route(),
                impl.install_inject_route(),
                return_exceptions=True,
            )
            assert results == [None, None, None]
            assert seen_installing.is_set()
            assert (await context.get_inject_route_state()).status == InjectRouteStatus.INSTALLED
            assert len(impl._routes) == 1
        finally:
            await browser.close()


async def test_page_concurrent_install_mounts_once(launch_kwargs):
    async with async_playwright() as p:
        browser, _, page = await _new_context_page(p, launch_kwargs)
        try:
            impl = page._impl_obj
            results = await asyncio.gather(
                impl.install_inject_route(),
                impl.install_inject_route(),
                return_exceptions=True,
            )
            assert results == [None, None]
            assert (await page.get_inject_route_state()).status == InjectRouteStatus.INSTALLED
            assert len(impl._routes) == 1
        finally:
            await browser.close()


async def test_page_waits_for_in_flight_context_install(launch_kwargs):
    async with async_playwright() as p:
        browser, context, page = await _new_context_page(p, launch_kwargs)
        try:
            ctx_impl = context._impl_obj
            real_update = ctx_impl._update_interception_patterns
            entered = asyncio.Event()
            release = asyncio.Event()

            async def blocked_update():
                entered.set()
                await release.wait()
                return await real_update()

            ctx_impl._update_interception_patterns = blocked_update

            context_task = asyncio.create_task(context.install_inject_route())
            await entered.wait()
            assert ctx_impl._inject_route_status == InjectRouteStatus.INSTALLING

            # While the context attempt is in flight, the page must wait for
            # it and reuse the context route rather than mount its own.
            page_task = asyncio.create_task(page.install_inject_route())
            await asyncio.sleep(0)  # let the page task start awaiting
            release.set()
            await asyncio.gather(context_task, page_task)

            assert (await page.get_inject_route_state()).status == InjectRouteStatus.INSTALLED
            assert page._impl_obj._routes == []
            assert len(ctx_impl._routes) == 1
        finally:
            await browser.close()


async def test_concurrent_failure_propagates_to_all_callers(launch_kwargs):
    async with async_playwright() as p:
        browser, context, _ = await _new_context_page(p, launch_kwargs)
        try:
            impl = context._impl_obj

            async def boom():
                raise RuntimeError("all-fail")

            impl._update_interception_patterns = boom

            results = await asyncio.gather(
                impl.install_inject_route(),
                impl.install_inject_route(),
                return_exceptions=True,
            )
            assert len(results) == 2
            assert all(isinstance(r, RuntimeError) for r in results)
            state = await context.get_inject_route_state()
            assert state.status == InjectRouteStatus.FAILED
            assert "all-fail" in state.error
            assert impl._routes == []
        finally:
            await browser.close()
