import asyncio
import time

import yaml
from playwright.async_api import async_playwright

from db import JobRepository
from notifications.discord import notify
from pipeline import build_run_report, format_run_report, normalize_seen_keys
from scrapers.scraper import CompanyResult, scrape

with open("config/config.yaml", "r") as f:
    config = yaml.safe_load(f)

# Concurrency limit is unchanged: read from the existing config structure.
SEMAPHORE = asyncio.Semaphore(config["semaphore"])


async def run_scraper(company, context):
    async with SEMAPHORE:
        return await scrape(
            company["company"],
            company["link"],
            company["jobs_el"],
            company["titles_el"],
            company["links_el"],
            context,
        )


async def gather_all_jobs(companies) -> list[CompanyResult]:
    """Scrape every company concurrently.

    A failed company returns a failed ``CompanyResult`` instead of raising,
    so it can never interrupt the other companies or be mistaken for an
    empty result.
    """
    if not companies:
        return []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()

        try:
            tasks = [asyncio.create_task(run_scraper(c, context)) for c in companies]
            results = await asyncio.gather(*tasks)
            return list(results)
        finally:
            try:
                await context.close()
            except Exception:  # noqa: BLE001 - cleanup is best effort
                pass
            try:
                await browser.close()
            except Exception:  # noqa: BLE001 - cleanup is best effort
                pass


async def run(repository: JobRepository) -> None:
    repository.cleanup_old_seen()
    seen_keys = normalize_seen_keys(repository.fetch_seen_rows())
    companies = repository.fetch_companies()

    company_results = await gather_all_jobs(companies)

    # Only the normalized, deduplicated new set reaches the database and
    # Discord; failed companies are reported separately, not treated as
    # empty results.
    report, new_jobs = build_run_report(company_results, seen_keys)

    if new_jobs:
        repository.insert_seen(new_jobs)

    print(format_run_report(report))
    notify(new_jobs)


async def main():
    database_url = _get_database_url()
    if not database_url:
        print("[ERROR] DATABASE_URL is not configured.")
        exit(1)

    try:
        repository = JobRepository.connect(database_url)
    except Exception as e:  # noqa: BLE001 - startup failure is fatal
        print(f"[ERROR] Failed to connect to database: {e}")
        exit(1)

    try:
        await run(repository)
    finally:
        repository.close()


def _get_database_url() -> str | None:
    import os

    from dotenv import load_dotenv

    load_dotenv()
    return os.getenv("DATABASE_URL")


if __name__ == "__main__":
    print("[START] Beginning scraper.")
    start = time.perf_counter()
    asyncio.run(main())
    print(f"[TIME] Ran in {time.perf_counter() - start:.2f} seconds.")
    print("[DONE] Ending scraper.")
