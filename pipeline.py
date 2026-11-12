# Run-level orchestration: gather per-company scrape results, deduplicate
# against the database using normalized keys, and produce a report that can
# be audited after every run.
#
# The functions here are side-effect free (they only rearrange data) so the
# dedup and reporting logic can be unit tested without a browser, database
# or Discord webhook.

from dataclasses import dataclass, field

from scrapers.normalize import dedup_key, normalize_link, normalize_title
from scrapers.scraper import (
    SELECTOR_MISSING,
    SUCCESS,
    TIMEOUT_SKIPPED,
)


@dataclass
class RunReport:
    total_companies: int = 0
    successful_companies: list = field(default_factory=list)
    timeout_companies: list = field(default_factory=list)
    selector_missing_companies: list = field(default_factory=list)
    failed_companies: list = field(default_factory=list)
    company_results: list = field(default_factory=list)
    scraped_count: int = 0
    filtered_count: int = 0
    new_count: int = 0
    duplicate_count: int = 0

    @property
    def all_companies_failed(self) -> bool:
        return (
            self.total_companies > 0
            and len(self.successful_companies) == 0
        )


def normalize_seen_keys(seen_rows) -> set:
    """Turn raw ``seen`` rows into normalized dedup keys.

    Rows may come from the production database (``company/title/link``
    columns) or from test fakes; normalization is applied here as well so
    historical rows with messy whitespace or tracking params still match.
    """
    return {
        (
            row["company"],
            normalize_title(row["title"]),
            normalize_link(row["link"]),
        )
        for row in seen_rows
    }


def deduplicate_new_jobs(jobs: list, seen_keys: set) -> tuple:
    """Return ``(new_jobs, new_count, duplicate_count)``.

    Both cross-page duplicates inside the run and rows already present in
    ``seen_keys`` collapse on the normalized ``(company, title, link)``
    key. Only members of the returned, deduplicated new set may be written
    to the database or pushed to Discord.
    """
    new_jobs = []
    seen_in_run = set(seen_keys)

    for job in jobs:
        key = dedup_key(job)
        if key in seen_in_run:
            continue
        seen_in_run.add(key)
        # The stored/pushed record carries normalized values only.
        new_jobs.append(
            {
                "company": key[0],
                "title": key[1],
                "link": key[2],
            }
        )

    duplicate_count = len(jobs) - len(new_jobs)
    return new_jobs, len(new_jobs), duplicate_count


def build_run_report(company_results: list, seen_keys: set) -> tuple:
    """Aggregate per-company results into a report and the new-job set."""
    report = RunReport(total_companies=len(company_results), company_results=list(company_results))

    all_jobs = []
    for result in company_results:
        if result.status == SUCCESS:
            report.successful_companies.append(result.company)
        elif result.status == TIMEOUT_SKIPPED:
            report.timeout_companies.append(result.company)
        elif result.status == SELECTOR_MISSING:
            report.selector_missing_companies.append(result.company)
        else:
            report.failed_companies.append(result.company)

        report.scraped_count += result.scraped_count
        report.filtered_count += result.filtered_count
        all_jobs.extend(result.jobs)

    new_jobs, new_count, duplicate_count = deduplicate_new_jobs(all_jobs, seen_keys)
    report.new_count = new_count
    report.duplicate_count = duplicate_count
    return report, new_jobs


def format_run_report(report: RunReport) -> str:
    """Human-readable summary printed at the end of a run."""
    lines = [
        "[REPORT] Run summary:",
        f"  companies total      : {report.total_companies}",
        f"  succeeded            : {len(report.successful_companies)}"
        f" ({', '.join(report.successful_companies) or '-'})",
        f"  timeout skipped      : {len(report.timeout_companies)}"
        f" ({', '.join(report.timeout_companies) or '-'})",
        f"  selector missing     : {len(report.selector_missing_companies)}"
        f" ({', '.join(report.selector_missing_companies) or '-'})",
        f"  other failures       : {len(report.failed_companies)}"
        f" ({', '.join(report.failed_companies) or '-'})",
        f"  entries scraped      : {report.scraped_count}",
        f"  entries after filter : {report.filtered_count}",
        f"  duplicates dropped   : {report.duplicate_count}",
        f"  new entries          : {report.new_count}",
    ]
    if report.all_companies_failed:
        lines.append("  WARNING: every company failed; no company produced a result.")
    return "\n".join(lines)
