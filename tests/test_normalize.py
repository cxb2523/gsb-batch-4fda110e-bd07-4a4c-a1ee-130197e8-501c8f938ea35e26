"""Unit tests for title/link normalization and dedup keys."""

from scrapers.normalize import dedup_key, normalize_link, normalize_title


def test_normalize_title_trims_and_lowercases():
    assert normalize_title("  Junior Data Analyst  ") == "junior data analyst"
    assert normalize_title("JR DATA ANALYST") == "jr data analyst"


def test_normalize_link_strips_trailing_slash_and_tracking_params():
    raw = (
        "https://Jobs.Example.com/careers/data-analyst/"
        "?utm_source=linkedin&id=42&utm_campaign=push#section"
    )
    assert normalize_link(raw) == (
        "https://jobs.example.com/careers/data-analyst?id=42"
    )


def test_normalize_link_keeps_root_slash_and_non_tracking_params():
    assert normalize_link("https://example.com/?ref=spam") == "https://example.com/"
    assert (
        normalize_link("http://example.com/path?a=1&gclid=xyz&b=2")
        == "http://example.com/path?a=1&b=2"
    )


def test_dedup_key_collapses_whitespace_case_slash_and_tracking_variants():
    base = {
        "company": "Acme",
        "title": "Junior Data Analyst",
        "link": "https://acme.test/jobs/42",
    }
    variant = {
        "company": "Acme",
        "title": "  junior data analyst  ",
        "link": "https://acme.test/jobs/42/?utm_source=discord",
    }
    assert dedup_key(base) == dedup_key(variant)


def test_dedup_key_distinguishes_different_jobs_and_companies():
    job_a = {"company": "Acme", "title": "Data Analyst", "link": "https://a.test/1"}
    job_b = {"company": "Acme", "title": "Data Analyst", "link": "https://a.test/2"}
    job_c = {"company": "Other", "title": "Data Analyst", "link": "https://a.test/1"}
    assert dedup_key(job_a) != dedup_key(job_b)
    assert dedup_key(job_a) != dedup_key(job_c)
