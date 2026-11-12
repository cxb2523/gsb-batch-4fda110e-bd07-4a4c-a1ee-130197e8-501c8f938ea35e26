"""Unit tests for run-level dedup and RunReport aggregation.

These exercise the pure orchestration logic with hand-built
``CompanyResult`` objects, so no browser, database or Discord is needed.
"""

from pipeline import (
    build_run_report,
    deduplicate_new_jobs,
    format_run_report,
    normalize_seen_keys,
)
from scrapers.scraper import (
    ERROR,
    SELECTOR_MISSING,
    SUCCESS,
    TIMEOUT_SKIPPED,
    CompanyResult,
)


def _ok(company, jobs, scraped=None):
    return CompanyResult(
        company=company,
        status=SUCCESS,
        jobs=jobs,
        scraped_count=len(jobs) if scraped is None else scraped,
        filtered_count=len(jobs),
    )


def test_normal_new_jobs_are_returned_and_counted():
    results = [
        _ok(
            "Acme",
            [
                {
                    "company": "Acme",
                    "title": "junior data analyst",
                    "link": "https://acme.test/jobs/1",
                }
            ],
            scraped=3,
        )
    ]
    report, new_jobs = build_run_report(results, seen_keys=set())

    assert report.new_count == 1
    assert report.scraped_count == 3
    assert report.filtered_count == 1
    assert report.duplicate_count == 0
    assert len(new_jobs) == 1
    assert new_jobs[0]["title"] == "junior data analyst"


def test_title_and_link_variants_dedup_to_one_new_entry():
    # Same posting seen on two pages with whitespace/case and trailing
    # slash/tracking-param differences.
    first = {
        "company": "Acme",
        "title": "Junior Data Analyst",
        "link": "https://acme.test/jobs/42",
    }
    second = {
        "company": "Acme",
        "title": "  junior data analyst ",
        "link": "https://acme.test/jobs/42/?utm_source=linkedin",
    }
    new_jobs, new_count, duplicate_count = deduplicate_new_jobs(
        [first, second], seen_keys=set()
    )

    assert new_count == 1
    assert duplicate_count == 1
    # Only normalized values survive into the new set.
    assert new_jobs[0]["title"] == "junior data analyst"
    assert new_jobs[0]["link"] == "https://acme.test/jobs/42"


def test_jobs_already_in_seen_are_not_new():
    seen = normalize_seen_keys(
        [
            {
                "company": "Acme",
                "title": "  Junior Data Analyst ",
                "link": "https://acme.test/jobs/42/?utm_source=x",
            }
        ]
    )
    job = {
        "company": "Acme",
        "title": "junior data analyst",
        "link": "https://acme.test/jobs/42",
    }
    new_jobs, new_count, duplicate_count = deduplicate_new_jobs([job], seen)

    assert new_jobs == []
    assert new_count == 0
    assert duplicate_count == 1


def test_report_classifies_company_outcomes_and_counts():
    results = [
        _ok(
            "Good Co",
            [
                {
                    "company": "Good Co",
                    "title": "data analyst",
                    "link": "https://good.test/1",
                }
            ],
        ),
        CompanyResult(company="Slow Co", status=TIMEOUT_SKIPPED),
        CompanyResult(company="Stale Co", status=SELECTOR_MISSING),
        CompanyResult(company="Boom Co", status=ERROR, error="boom"),
    ]
    report, _ = build_run_report(results, seen_keys=set())

    assert report.total_companies == 4
    assert report.successful_companies == ["Good Co"]
    assert report.timeout_companies == ["Slow Co"]
    assert report.selector_missing_companies == ["Stale Co"]
    assert report.failed_companies == ["Boom Co"]
    assert report.all_companies_failed is False
    assert report.new_count == 1

    rendered = format_run_report(report)
    assert "timeout skipped      : 1" in rendered
    assert "selector missing     : 1" in rendered
    assert "Slow Co" in rendered and "Stale Co" in rendered


def test_report_when_all_companies_fail_is_still_judgeable():
    results = [
        CompanyResult(company="Slow Co", status=TIMEOUT_SKIPPED, error="t"),
        CompanyResult(company="Stale Co", status=SELECTOR_MISSING, error="s"),
        CompanyResult(company="Boom Co", status=ERROR, error="b"),
    ]
    report, new_jobs = build_run_report(results, seen_keys=set())

    assert report.all_companies_failed is True
    assert report.successful_companies == []
    # Failures must not look like a successful-but-empty run.
    assert report.scraped_count == 0
    assert report.new_count == 0
    assert new_jobs == []
    rendered = format_run_report(report)
    assert "WARNING" in rendered
    assert "Slow Co" in rendered and "Stale Co" in rendered and "Boom Co" in rendered


def test_successful_company_with_no_matching_jobs_counts_as_success():
    results = [_ok("Empty Co", jobs=[], scraped=5)]
    report, new_jobs = build_run_report(results, seen_keys=set())

    assert report.successful_companies == ["Empty Co"]
    assert report.all_companies_failed is False
    assert report.scraped_count == 5
    assert report.filtered_count == 0
    assert new_jobs == []
