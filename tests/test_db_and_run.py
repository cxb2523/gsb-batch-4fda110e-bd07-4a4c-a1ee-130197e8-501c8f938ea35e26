"""Tests for database persistence and the end-to-end run orchestration.

A fake repository stands in for PostgreSQL, so no production database is
required. These tests prove that only the normalized new set is persisted
and handed to Discord, and that failed companies never abort the run.
"""

import pytest

from db import INSERT_SEEN_QUERY
from pipeline import normalize_seen_keys
from scrapers.scraper import SELECTOR_MISSING, SUCCESS, CompanyResult


class FakeCursor:
    def __init__(self, repo):
        self._repo = repo

    def execute(self, query, params=None):
        self._repo.executed.append((query, params))

    def executemany(self, query, seq):
        self._repo.executed.append((query, list(seq)))

    def fetchall(self):
        return list(self._repo.seen_rows)


class FakeRepository:
    """In-memory stand-in for db.JobRepository."""

    def __init__(self, seen_rows=None, companies=None):
        self.seen_rows = seen_rows or []
        self.companies = companies or []
        self.inserted = []
        self.executed = []
        self.closed = False

    def cleanup_old_seen(self):
        self.executed.append(("cleanup", None))

    def fetch_seen_rows(self):
        return list(self.seen_rows)

    def fetch_companies(self):
        return list(self.companies)

    def insert_seen(self, new_jobs):
        self.inserted.extend(new_jobs)

    def close(self):
        self.closed = True


def test_normalized_seen_keys_match_messy_historical_rows():
    seen = normalize_seen_keys(
        [
            {
                "company": "Acme",
                "title": " Junior Data Analyst ",
                "link": "https://acme.test/jobs/1/?utm_source=old",
            }
        ]
    )
    assert ("Acme", "junior data analyst", "https://acme.test/jobs/1") in seen


def _ok(company, jobs):
    return CompanyResult(
        company=company,
        status=SUCCESS,
        jobs=jobs,
        scraped_count=len(jobs),
        filtered_count=len(jobs),
    )


@pytest.mark.asyncio
async def test_run_persists_and_pushes_only_normalized_new_set(monkeypatch):
    import main

    seen_rows = [
        {
            "company": "Acme",
            "title": "existing role",
            "link": "https://acme.test/jobs/0",
        }
    ]
    repository = FakeRepository(seen_rows=seen_rows)

    # Two variants of the same job + one genuinely new job.
    results = [
        _ok(
            "Acme",
            [
                {
                    "company": "Acme",
                    "title": "Junior Data Analyst",
                    "link": "https://acme.test/jobs/42",
                },
                {
                    "company": "Acme",
                    "title": "  junior data analyst ",
                    "link": "https://acme.test/jobs/42/?utm_source=x",
                },
                {
                    "company": "Acme",
                    "title": "ml engineer",
                    "link": "https://acme.test/jobs/7",
                },
            ],
        ),
        CompanyResult(company="Stale Co", status=SELECTOR_MISSING, error="x"),
    ]

    pushed = []

    async def fake_gather(companies):
        return results

    monkeypatch.setattr(main, "gather_all_jobs", fake_gather)
    monkeypatch.setattr(
        main, "notify", lambda jobs: pushed.extend(jobs) or len(jobs)
    )

    await main.run(repository)

    # Exactly the two distinct normalized new jobs, no duplicates.
    assert len(repository.inserted) == 2
    persisted_links = {j["link"] for j in repository.inserted}
    assert persisted_links == {"https://acme.test/jobs/42", "https://acme.test/jobs/7"}
    assert all(j["title"] == j["title"].lower() for j in repository.inserted)

    # Discord receives the exact same set as the database.
    assert pushed == repository.inserted
    assert repository.closed is False  # run() leaves closing to the caller


@pytest.mark.asyncio
async def test_run_with_only_failures_writes_and_pushes_nothing_but_reports(
    monkeypatch,
):
    import main

    repository = FakeRepository()
    results = [
        CompanyResult(company="A", status=SELECTOR_MISSING, error="x"),
        CompanyResult(company="B", status=SELECTOR_MISSING, error="y"),
    ]

    pushed = []
    monkeypatch.setattr(main, "gather_all_jobs", lambda companies: _gather(results))
    monkeypatch.setattr(
        main, "notify", lambda jobs: pushed.extend(jobs) or len(jobs)
    )

    await main.run(repository)

    assert repository.inserted == []
    assert pushed == []
    assert repository.executed[0] == ("cleanup", None)


async def _gather(value):
    return value


def test_insert_query_shape_matches_repository_contract():
    # Guards the SQL string used by the real repository.
    assert "INSERT INTO seen" in INSERT_SEEN_QUERY
    assert "%s, %s, %s, %s" in INSERT_SEEN_QUERY
