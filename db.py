# Database access for the scraper.
#
# All psycopg-specific code lives here. The orchestration code only depends
# on the small ``JobRepository`` interface, which tests replace with an
# in-memory fake so no production database is required.

import datetime

import psycopg
import psycopg.rows

DELETE_OLD_SEEN_QUERY = (
    "DELETE FROM seen WHERE \"date\"::date < CURRENT_DATE - INTERVAL '2 months'"
)
SEEN_QUERY = "SELECT company, title, link FROM seen"
GET_COMPANIES_QUERY = """
        SELECT c.company, c.link,
               e.jobs_element AS jobs_el,
               e.titles_element AS titles_el,
               e.links_element AS links_el
        FROM companies c
        JOIN elements e ON e.platform = c.platform
    """
INSERT_SEEN_QUERY = (
    "INSERT INTO seen (company, title, link, date) VALUES (%s, %s, %s, %s)"
)


class JobRepository:
    """Production PostgreSQL-backed repository."""

    def __init__(self, connection):
        self._con = connection
        self._cursor = connection.cursor()

    @classmethod
    def connect(cls, database_url: str) -> "JobRepository":
        connection = psycopg.connect(
            database_url,
            # dict_row is the documented factory for dict-shaped rows; the
            # stubs don't express its row-type variance.
            row_factory=psycopg.rows.dict_row,  # type: ignore[invalid-argument-type]
        )
        return cls(connection)

    def cleanup_old_seen(self) -> None:
        self._cursor.execute(DELETE_OLD_SEEN_QUERY)

    def fetch_seen_rows(self) -> list:
        self._cursor.execute(SEEN_QUERY)
        return self._cursor.fetchall()

    def fetch_companies(self) -> list:
        self._cursor.execute(GET_COMPANIES_QUERY)
        return self._cursor.fetchall()

    def insert_seen(self, new_jobs: list) -> None:
        today = datetime.date.today().isoformat()
        self._cursor.executemany(
            INSERT_SEEN_QUERY,
            [
                (job["company"], job["title"], job["link"], today)
                for job in new_jobs
            ],
        )
        self._con.commit()

    def close(self) -> None:
        self._con.close()
