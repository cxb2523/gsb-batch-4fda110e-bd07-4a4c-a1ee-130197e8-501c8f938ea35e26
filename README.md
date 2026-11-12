<p align = "center">
    <img src = "images/first-responder.jpg" alt = "Illustration of a guy on a laptop, made by Alghozy on Unsplash." height = "200px"/>
</p>

# First Responder 🚑

Get job listings **fast** before everyone else does.

First Responder is a lightweight job scraper that monitors company career pages and sends **filtered, relevant job postings** directly to your Discord server.

## Features

* Scrapes jobs from:

  * Workday
  * Ashby
  * Greenhouse
  * Hacker News
  * Custom career pages
* Keyword-based filtering (allow / deny lists)
* Normalized, duplicate-resistant dedup (whitespace/case-insensitive
  titles; trailing-slash and tracking-param-insensitive links)
* Auditable per-run report distinguishing successful, timeout-skipped and
  selector-missing companies, with scraped/filtered/new entry counts
* Fully automated with GitHub Actions
* Discord webhook integration

## Tech Stack

* Python
* Playwright (Web scraping)
* PostgreSQL (Neon)
* GitHub Actions (CI/CD)

---

## Quick Start

If you get stuck at all, check out the [docs](docs/) for more information.

### 1. Fork & Clone

Fork this repo, then clone your fork.

### 2. Rename Files

```bash
mv .env.example .env
mv docs/COMPANIES_TEMPLATE.md docs/COMPANIES.md
```

### 3. Setup Database ([Neon](https://neon.com))

Run the following SQL:

```sql
CREATE TABLE companies (
    id BIGSERIAL PRIMARY KEY,
    company TEXT NOT NULL,
    link TEXT NOT NULL,
    platform TEXT NOT NULL,
    UNIQUE(id, company, link, platform)
);

CREATE TABLE seen (
    id BIGSERIAL PRIMARY KEY,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    date TEXT NOT NULL,
    UNIQUE(id, company, title, link, date)
);

CREATE TABLE elements (
    id BIGSERIAL PRIMARY KEY,
    platform TEXT NOT NULL,
    jobs_element TEXT,
    titles_element TEXT,
    links_element TEXT,
    UNIQUE(id, platform, jobs_element, titles_element, links_element)
);
```

### 4. Setup Discord Webhook

* Create a channel (e.g. `first-responder`)
* Create a webhook

### 5. Add Environment Variables

Add the db connection string and webhook URL to the `.env` file:

```env
DISCORD_WEBHOOK = ""
DATABASE_URL = ""
```

Do the same for GitHub Action Secrets:

```env
DISCORD_WEBHOOK
DATABASE_URL
```

### 6. Run Locally To Test

```bash
uv sync
uv run playwright install
uv run main.py
```

---

## Run Results & Dedup

Every run prints a report that can be checked after the fact:

```text
[REPORT] Run summary:
  companies total      : 12
  succeeded            : 9 (Acme, Beta, ...)
  timeout skipped      : 2 (Slow Co, ...)
  selector missing     : 1 (Stale Co)
  other failures       : 0 (-)
  entries scraped      : 140
  entries after filter : 35
  duplicates dropped   : 6
  new entries          : 29
```

* A **timeout-skipped** or **selector-missing** company is a recorded
  failure, never an empty result, and one company failing does not stop the
  others.
* Dedup keys normalize titles (trim + lowercase) and links (strip trailing
  slash and common tracking parameters such as `utm_*`, `gclid`, `ref`), so
  the same posting appearing on different pages — or with cosmetic
  differences — is stored and pushed to Discord exactly once.
* Only the normalized, deduplicated new-job set is written to the database
  and sent to Discord.

## Tests

The test suite uses self-made local HTML pages and a headless browser; it
never contacts a real career site, Discord webhook or production database
(the database and HTTP layers are replaced by fakes):

```bash
uv sync
uv run playwright install chromium
uv run pytest
```

---

## Filtering Jobs

Edit:

```
filter/filters.py
```

* `allow`: job keywords you want
* `deny`: job keywords you don’t want

> Tip: include variations like `junior`, `jr`, `jr.`

## Adding Companies

Use `docs/companies.md` to track company career pages.

Quick ways to find them:

* Workday → `site:wd1.myworkdayjobs.com`
* Ashby → `site:jobs.ashbyhq.com`
* Greenhouse → `site:job-boards.greenhouse.io`

You can bulk insert using a generated SQL statement, or add them one by one in the Neon console.

> Tip: I suggest using this file to make a big list first, bulk insert into the Neon database, then use it to keep a local track of companies and add new ones directly in the Neon console.

---

## Future Plans

* Smarter filtering using an LLM (job description matching)
* Local-first mode (local LLM + database)
* Better configurability