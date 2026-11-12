"""Integration tests for scrapers.scraper against self-made local pages.

A real headless Chromium renders static HTML served by a local HTTP server.
No external site is contacted. Timeouts are shrunk via the scraper's
injectable timeout parameters so failure cases stay fast.
"""

import http.server
import socketserver
import threading

import pytest

from scrapers.scraper import (
    SELECTOR_MISSING,
    SUCCESS,
    TIMEOUT_SKIPPED,
    scrape,
)


async def _scrape(company, context, **kwargs):
    return await scrape(
        company["company"],
        company["link"],
        company["jobs_el"],
        company["titles_el"],
        company["links_el"],
        context,
        **kwargs,
    )


async def test_success_scrapes_normalizes_and_filters(make_company, browser_context):
    company = make_company(
        [
            ("  Junior Data Analyst ", "/jobs/1?utm_source=x"),
            ("Senior Manager of Things", "/jobs/2"),  # denied by keyword filter
            ("ML Engineer", "/jobs/3"),
        ]
    )

    result = await _scrape(company, browser_context)

    assert result.status == SUCCESS
    assert result.ok is True
    assert result.scraped_count == 3
    assert result.filtered_count == 2
    titles = {job["title"] for job in result.jobs}
    assert titles == {"junior data analyst", "ml engineer"}
    # Links are normalized: tracking param removed, relative URL resolved.
    analyst = next(j for j in result.jobs if j["title"] == "junior data analyst")
    assert analyst["link"].endswith("/jobs/1")
    assert "utm_source" not in analyst["link"]


async def test_duplicate_variants_on_one_page_collapse_via_pipeline(
    make_company, browser_context
):
    company = make_company(
        [
            ("Junior Data Analyst", "/jobs/42"),
            ("  junior data analyst  ", "/jobs/42/?utm_campaign=push"),
        ]
    )

    result = await _scrape(company, browser_context)
    assert result.status == SUCCESS
    assert result.scraped_count == 2

    from pipeline import deduplicate_new_jobs

    new_jobs, new_count, duplicates = deduplicate_new_jobs(result.jobs, set())
    assert new_count == 1
    assert duplicates == 1
    assert new_jobs[0]["link"].endswith("/jobs/42")


class _HangingHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # Never respond: page.goto must time out.
        threading.Event().wait(30)

    def log_message(self, *args):
        pass


@pytest.fixture
def hanging_server():
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _HangingHandler)
    server.allow_reuse_address = True
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    yield f"http://{host}:{port}/careers"
    server.shutdown()
    server.server_close()


async def test_navigation_timeout_is_reported_not_treated_as_empty(hanging_server, browser_context):
    company = {
        "company": "Slow Co",
        "link": hanging_server,
        "jobs_el": ".job",
        "titles_el": "h2",
        "links_el": "els => els.map(el => el.querySelector('a').href)",
    }

    result = await _scrape(
        company, browser_context, navigation_timeout=500, selector_timeout=500
    )

    assert result.status == TIMEOUT_SKIPPED
    assert result.jobs == []
    assert result.scraped_count == 0
    assert result.error is not None


async def test_missing_selector_is_a_distinct_failure(make_company, browser_context):
    company = make_company(missing_selector=True)

    result = await _scrape(
        company, browser_context, selector_timeout=300, navigation_timeout=5000
    )

    assert result.status == SELECTOR_MISSING
    assert result.jobs == []
    assert result.scraped_count == 0
    assert ".job" in result.error


async def test_failed_company_does_not_block_others(make_company, browser_context):
    good = make_company([("Data Analyst", "/jobs/9")])
    stale = make_company(missing_selector=True)

    good_result, stale_result = await _scrape(
        good, browser_context, selector_timeout=300
    ), await _scrape(stale, browser_context, selector_timeout=300)

    assert good_result.status == SUCCESS
    assert good_result.filtered_count == 1
    assert stale_result.status == SELECTOR_MISSING


async def test_all_companies_failing_still_produces_judgeable_report(
    make_company, browser_context
):
    stale_a = make_company(missing_selector=True)
    stale_b = make_company(missing_selector=True)

    results = [
        await _scrape(stale_a, browser_context, selector_timeout=300),
        await _scrape(stale_b, browser_context, selector_timeout=300),
    ]

    from pipeline import build_run_report

    report, new_jobs = build_run_report(results, seen_keys=set())
    assert report.all_companies_failed is True
    assert len(report.selector_missing_companies) == 2
    assert report.successful_companies == []
    assert report.new_count == 0
    assert new_jobs == []


async def test_gather_all_jobs_concurrent_mixed_outcomes(make_company):
    # Exercises main.gather_all_jobs (own browser, config semaphore) with a
    # mix of healthy and failing companies; failures must not abort others.
    import main

    companies = [
        make_company([("Junior Data Analyst", "/jobs/a")]),
        make_company([("ML Engineer", "/jobs/b")]),
        make_company(missing_selector=True),
    ]

    results = await main.gather_all_jobs(companies)

    assert len(results) == 3
    statuses = sorted(r.status for r in results)
    assert statuses == sorted([SUCCESS, SUCCESS, SELECTOR_MISSING])
    # Every company, including failures, yields a structured result.
    assert all(isinstance(r, type(results[0])) for r in results)
