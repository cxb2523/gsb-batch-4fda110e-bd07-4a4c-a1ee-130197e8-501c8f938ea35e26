import os
import asyncio
import datetime
import time
import psycopg
from dotenv import load_dotenv
from scrapers.scraper import scrape
from notifications.discord import notify
from playwright.async_api import async_playwright
import yaml

load_dotenv()

with open("config/config.yaml", "r") as f:
    config = yaml.safe_load(f)

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


async def gather_all_jobs(companies):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()

        try:
            tasks = [asyncio.create_task(run_scraper(c, context)) for c in companies]

            if not tasks:
                return []

            found = []

            for res in await asyncio.gather(*tasks, return_exceptions=True):
                if isinstance(res, Exception):
                    print(f"[ERROR] Scraper failed: {res}")
                elif isinstance(res, list):
                    found.extend(res)
                else:
                    print(f"[WARN] Unexpected scraper return type: {type(res)}")
            return found

        finally:
            try:
                await context.close()
            except Exception:
                pass
            try:
                await browser.close()
            except Exception:
                pass


async def main():
    DATABASE_URL = os.getenv("DATABASE_URL")

    # Queries
    delete_seen_from_date_query = (
        "DELETE FROM seen WHERE \"date\"::date < CURRENT_DATE - INTERVAL '2 months'"
    )
    seen_query = "SELECT company, title, link FROM seen"
    get_data_query = """
            SELECT c.company, c.link,
                   e.jobs_element AS jobs_el,
                   e.titles_element AS titles_el,
                   e.links_element AS links_el
            FROM companies c
            JOIN elements e ON e.platform = c.platform
        """

    try:
        con = psycopg.connect(DATABASE_URL, row_factory=psycopg.rows.dict_row)
        cursor = con.cursor()
        cursor.execute(delete_seen_from_date_query)
        cursor.execute(seen_query)
        seen_keys = {(r["company"], r["title"], r["link"]) for r in cursor.fetchall()}
        cursor.execute(get_data_query)
        companies = cursor.fetchall()

    except Exception as e:
        print(f"[ERROR] Failed to connect to database: {e}")
        exit(1)

    found_jobs = await gather_all_jobs(companies)

    new_jobs = [
        job
        for job in found_jobs
        if (job["company"], job["title"], job["link"]) not in seen_keys
    ]

    if new_jobs:
        today = datetime.date.today().isoformat()
        cursor.executemany(
            "INSERT INTO seen (company, title, link, date) VALUES (%s, %s, %s, %s)",
            [(j["company"], j["title"], j["link"], today) for j in new_jobs],
        )
        con.commit()

    con.close()
    notify(new_jobs)


if __name__ == "__main__":
    print("[START] Beginning scraper.")
    start = time.perf_counter()
    asyncio.run(main())
    print(f"[TIME] Ran in {time.perf_counter() - start:.2f} seconds.")
    print("[DONE] Ending scraper.")
