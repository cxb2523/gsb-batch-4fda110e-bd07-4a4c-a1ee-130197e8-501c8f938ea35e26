# General scraper

from playwright.async_api import TimeoutError, BrowserContext
from filter.filters import filter_title


async def scrape(
    company: str,
    link: str,
    jobs_el: str,
    titles_el: str,
    links_el: str,
    context: BrowserContext,
) -> list:

    print(f"[INFO] Scraping {company}.")

    try:
        page = await context.new_page()
        await page.goto(link, wait_until="domcontentloaded")

        try:
            await page.wait_for_selector(jobs_el, timeout=4000)
        except:
            await page.reload(
                wait_until="domcontentloaded"
            )  # Reloading page if it doesn't load properly
            await page.wait_for_selector(jobs_el, timeout=4000)

        jobs_locator = page.locator(jobs_el)

        if titles_el:
            titles = await jobs_locator.locator(titles_el).all_inner_texts()
        else:
            titles = await jobs_locator.all_inner_texts()

        links = await jobs_locator.evaluate_all(links_el)

        jobs = [
            {"title": t, "company": company, "link": l}
            for t, l in zip(titles, links)
            if filter_title(t)
        ]

    except TimeoutError:
        print(f"[SKIP] {company} timed out — skipping.")
        jobs = []

    await page.close()

    return jobs
