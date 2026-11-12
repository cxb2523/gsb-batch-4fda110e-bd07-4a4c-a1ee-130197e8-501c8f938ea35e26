# General scraper.
#
# Every company produces a structured ``CompanyResult`` instead of a bare
# list so that a run can distinguish a company that genuinely had no
# matching jobs from a company whose page timed out or whose selectors did
# not match anything. A failure for one company is reported, never raised,
# so the remaining companies keep scraping.

from dataclasses import dataclass, field

from playwright.async_api import BrowserContext, TimeoutError

from filter.filters import filter_title
from scrapers.normalize import normalize_link, normalize_title

# Outcome labels carried on every CompanyResult.
SUCCESS = "success"
TIMEOUT_SKIPPED = "timeout_skipped"
SELECTOR_MISSING = "selector_missing"
ERROR = "error"


@dataclass
class CompanyResult:
    company: str
    status: str
    jobs: list = field(default_factory=list)
    scraped_count: int = 0
    filtered_count: int = 0
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == SUCCESS


async def scrape(
    company: str,
    link: str,
    jobs_el: str,
    titles_el: str,
    links_el: str,
    context: BrowserContext,
    selector_timeout: float = 4000,
    navigation_timeout: float = 30000,
) -> CompanyResult:
    print(f"[INFO] Scraping {company}.")

    result = CompanyResult(company=company, status=SUCCESS)
    page = None

    try:
        page = await context.new_page()
        page.set_default_navigation_timeout(navigation_timeout)

        try:
            await page.goto(link, wait_until="domcontentloaded")
        except TimeoutError as exc:
            # The page itself never loaded: skip the company rather than
            # pretending it has no jobs.
            result.status = TIMEOUT_SKIPPED
            result.error = str(exc)
            print(f"[SKIP] {company} timed out — skipping.")
            return result

        # The page loaded but the jobs container never appeared (even after
        # one reload retry): the selectors are wrong/stale, which is a
        # distinct failure from a navigation timeout.
        try:
            await page.wait_for_selector(jobs_el, timeout=selector_timeout)
        except TimeoutError:
            try:
                await page.reload(wait_until="domcontentloaded")
                await page.wait_for_selector(jobs_el, timeout=selector_timeout)
            except TimeoutError as exc:
                result.status = SELECTOR_MISSING
                result.error = f"selector {jobs_el!r} not found before timeout: {exc}"
                print(f"[FAIL] {company} selector missing — {result.error}.")
                return result

        jobs_locator = page.locator(jobs_el)

        if titles_el:
            titles = await jobs_locator.locator(titles_el).all_inner_texts()
        else:
            titles = await jobs_locator.all_inner_texts()

        links = await jobs_locator.evaluate_all(links_el)
        raw_jobs = [
            {"title": title, "company": company, "link": link}
            for title, link in zip(titles, links)
        ]
        result.scraped_count = len(raw_jobs)

        # Keyword filtering rule is unchanged; titles/links are normalized
        # on the surviving jobs so downstream dedup is stable.
        jobs = [
            {
                "title": normalize_title(job["title"]),
                "company": company,
                "link": normalize_link(job["link"]),
            }
            for job in raw_jobs
            if filter_title(job["title"])
        ]
        result.jobs = jobs
        result.filtered_count = len(jobs)

    except Exception as exc:  # noqa: BLE001 - report, never kill the run
        result.status = ERROR
        result.error = f"{type(exc).__name__}: {exc}"
        print(f"[ERROR] {company} failed — {result.error}.")

    finally:
        if page is not None:
            try:
                await page.close()
            except Exception:  # noqa: BLE001 - cleanup is best effort
                pass

    return result
