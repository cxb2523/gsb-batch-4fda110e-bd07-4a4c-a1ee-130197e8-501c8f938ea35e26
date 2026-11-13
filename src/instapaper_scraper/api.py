import logging
import os
import re
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any

import requests

from .constants import (
    INSTAPAPER_BOOKMARKS_URL,
    INSTAPAPER_USER_SESSION_URL,
    KEY_ARTICLE_PREVIEW,
    KEY_AUTHOR,
    KEY_DESCRIPTION,
    KEY_ID,
    KEY_IS_ARCHIVED,
    KEY_LIKED,
    KEY_NOTES,
    KEY_SITE_NAME,
    KEY_TAGS,
    KEY_TIME,
    KEY_TITLE,
    KEY_URL,
    SECTION_FOLDER,
    SECTION_HOME,
    SORT_NEWEST,
    SPECIAL_SECTIONS,
    XHR_HEADERS,
)
from .exceptions import ApiParseError, InstapaperAPIError


class StopReason(str, Enum):
    """Why a tolerant (partial-result) scrape run ended.

    Kept separate from exceptions so the CLI can report a readable summary
    and still persist everything collected before the stop.
    """

    COMPLETED = "completed"  # has_more was false: all pages were fetched
    PAGE_LIMIT = "page_limit"  # the caller's page limit was reached
    PAGE_FAILED = "page_failed"  # a page kept failing until retries ran out
    INVALID_DATA = "invalid_data"  # response lacked the bookmarks field


MSG_STOP_COMPLETED = (
    "Scrape completed normally: reached the last page (has_more was false). "
    "Collected {count} article(s) from {pages} page(s)."
)
MSG_STOP_PAGE_LIMIT = (
    "Scrape stopped at the page limit of {limit} page(s). "
    "Collected {count} article(s) from {pages} page(s)."
)
MSG_STOP_PAGE_FAILED = (
    "Scrape stopped at page {page}: that page could not be fetched "
    "(last error: {error}). Collected {count} article(s) from {pages} page(s); "
    "no request was made after page {page}."
)
MSG_STOP_INVALID_DATA = (
    "Scrape stopped at page {page}: invalid API response ({reason}). "
    "Collected {count} article(s) from {pages} page(s); "
    "no request was made after page {page}."
)
MSG_STOP_NO_ARTICLES = "No articles were collected, so no output file was written."
MSG_MISSING_BOOKMARKS_FIELD = "missing the 'bookmarks' field"


@dataclass
class ScrapeResult:
    """Articles collected by a tolerant scrape plus the reason it ended."""

    articles: list[dict[str, Any]]
    stop_reason: StopReason
    pages_scraped: int = 0
    failed_page: int | None = None
    error_detail: str | None = None
    page_limit: int | None = None

    def is_partial(self) -> bool:
        """True when the run stopped before fetching every page."""
        return self.stop_reason in (
            StopReason.PAGE_FAILED,
            StopReason.INVALID_DATA,
        )

    def describe(self) -> str:
        """Returns a human-readable explanation of why the scrape stopped."""
        if self.stop_reason is StopReason.COMPLETED:
            summary = MSG_STOP_COMPLETED.format(
                count=len(self.articles), pages=self.pages_scraped
            )
        elif self.stop_reason is StopReason.PAGE_LIMIT:
            summary = MSG_STOP_PAGE_LIMIT.format(
                limit=self.page_limit,
                count=len(self.articles),
                pages=self.pages_scraped,
            )
        elif self.stop_reason is StopReason.PAGE_FAILED:
            summary = MSG_STOP_PAGE_FAILED.format(
                page=self.failed_page,
                error=self.error_detail,
                count=len(self.articles),
                pages=self.pages_scraped,
            )
        else:  # StopReason.INVALID_DATA
            summary = MSG_STOP_INVALID_DATA.format(
                page=self.failed_page,
                reason=self.error_detail,
                count=len(self.articles),
                pages=self.pages_scraped,
            )

        if not self.articles:
            summary = f"{summary} {MSG_STOP_NO_ARTICLES}"
        return summary


class InstapaperClient:
    """
    A client for interacting with the Instapaper JSON API to fetch articles.
    """

    # Environment variable names
    ENV_MAX_RETRIES = "MAX_RETRIES"
    ENV_BACKOFF_FACTOR = "BACKOFF_FACTOR"
    ENV_USER_AGENT = "INSTAPAPER_USER_AGENT"

    # Default values
    DEFAULT_MAX_RETRIES = 3
    DEFAULT_BACKOFF_FACTOR = 1.0
    DEFAULT_REQUEST_TIMEOUT = 30
    DEFAULT_PAGE_START = 1

    # URL validation
    URL_SAFE_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")

    # HTTP status codes
    HTTP_TOO_MANY_REQUESTS = 429
    HTTP_SERVER_ERROR_START = 500
    HTTP_SERVER_ERROR_END = 600

    # Request headers
    HEADERS = {
        "accept": "*/*",
        "content-type": "application/json",
        "x-requested-with": "XMLHttpRequest",
    }

    # A browser-like User-Agent; the default python-requests UA can be
    # rejected by anti-bot layers on the /data/* endpoints. Chrome on
    # Windows is used as a neutral, statistically common fingerprint.
    # Override via the INSTAPAPER_USER_AGENT env var or the user_agent
    # constructor argument.
    #
    # MAINTENANCE: Chrome/152 was current stable as of 2026-08 (verified
    # via https://endoflife.date/api/chrome.json). Chrome ships a new
    # major version roughly every 4 weeks. If this string becomes more
    # than ~6 months old, check the latest stable major at that URL and
    # bump the version here. A stale-but-plausible (older) version is
    # acceptable; a *future*-dated one is a strong bot signal and must
    # never be used.
    DEFAULT_USER_AGENT = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
    )

    # Maps folder ids to special section types (liked, archive, etc.)
    SPECIAL_SECTIONS = SPECIAL_SECTIONS

    # Logging and error messages
    MSG_SCRAPING_PAGE = "Scraping page {page}..."
    MSG_BOOKMARK_ID_NOT_FOUND = "Bookmark {bookmark_id} missing {field}."
    MSG_BOOKMARK_MISSING_ID = "Bookmark missing id, skipping."
    MSG_API_ERROR = "API error: {reason}"
    MSG_RATE_LIMITED_RETRY = (
        "Rate limited ({status_code}). Retrying after {wait_time} seconds."
    )
    MSG_RATE_LIMITED_REASON = "Rate limited ({status_code})"
    MSG_REQUEST_FAILED_STATUS_REASON = "Request failed with status {status_code}"
    MSG_REQUEST_FAILED_UNRECOVERABLE = (
        "Request failed with unrecoverable status code {status_code}."
    )
    MSG_NETWORK_ERROR_REASON = "Network error ({error_type})"
    MSG_API_RESPONSE_ERROR = "API response error: {e}"
    MSG_ALL_RETRIES_FAILED = "All {max_retries} retries failed."
    MSG_SCRAPING_FAILED_UNKNOWN = (
        "Scraping failed after multiple retries for an unknown reason."
    )
    MSG_RETRY_ATTEMPT = "{reason} (attempt {attempt_num}/{max_retries}). Retrying in {sleep_time:.2f} seconds."
    MSG_INVALID_JSON = "Invalid JSON response from Instapaper API."
    MSG_SESSION_FETCH_FAILED = "Failed to fetch user session: {e}"
    MSG_SESSION_FETCH_NON_OK = "User session request failed with status {status_code}."
    MSG_PARSE_FAILED = "Could not parse bookmark {id}: {e}"
    MSG_STOP_INVALID_RESPONSE_LOGGED = (
        "Stopping at page {page}: invalid API response ({reason})."
    )
    MSG_STOP_PAGE_FAILED_LOGGED = (
        "Stopping at page {page}: page could not be fetched (last error: {error})."
    )

    def __init__(
        self,
        session: requests.Session,
        form_key: str | None = None,
        user_agent: str | None = None,
    ):
        """
        Initializes the client with a requests Session.
        Args:
            session: A requests.Session object, presumably authenticated.
            form_key: A pre-fetched x-form-key (e.g. captured by the
                authenticator during session verification). If omitted, the
                client fetches one from /data/user_session on first use.
            user_agent: User-Agent header to send with API requests. Falls
                back to the INSTAPAPER_USER_AGENT environment variable, then
                to DEFAULT_USER_AGENT. Override this if the default is
                blocked or you prefer a different fingerprint. An empty or
                whitespace-only value is rejected with a warning (an empty
                User-Agent header guarantees blocking), falling back to the
                default.
        """
        self.session = session
        self._form_key: str | None = form_key
        # None means "auto-resolve"; an empty/whitespace-only explicit value
        # is a caller mistake (an empty User-Agent header guarantees
        # blocking), so it is rejected with a warning instead of being sent.
        if user_agent is None:
            # A plain `or` chain keeps the type `str` for mypy (os.getenv's
            # stubs return `str | None` even with an explicit default).
            user_agent = os.getenv(self.ENV_USER_AGENT) or self.DEFAULT_USER_AGENT
        elif not user_agent.strip():
            logging.warning(
                "Empty user_agent provided; using the default User-Agent instead."
            )
            user_agent = self.DEFAULT_USER_AGENT
        self.user_agent = user_agent
        logging.debug("Using Instapaper API User-Agent: %s", self.user_agent)

        try:
            self.max_retries = int(
                os.getenv(self.ENV_MAX_RETRIES, str(self.DEFAULT_MAX_RETRIES))
            )
        except ValueError:
            logging.warning(
                f"Invalid value for {self.ENV_MAX_RETRIES}, using default {self.DEFAULT_MAX_RETRIES}"
            )
            self.max_retries = self.DEFAULT_MAX_RETRIES

        try:
            self.backoff_factor = float(
                os.getenv(self.ENV_BACKOFF_FACTOR, str(self.DEFAULT_BACKOFF_FACTOR))
            )
        except ValueError:
            logging.warning(
                f"Invalid value for {self.ENV_BACKOFF_FACTOR}, using default {self.DEFAULT_BACKOFF_FACTOR}"
            )
            self.backoff_factor = self.DEFAULT_BACKOFF_FACTOR

    def _get_headers(self) -> dict[str, str]:
        """Builds the headers dict for API requests, including x-form-key."""
        headers = dict(self.HEADERS)
        headers["User-Agent"] = self.user_agent
        if self._form_key:
            headers["x-form-key"] = self._form_key
        return headers

    def _fetch_form_key(self) -> None:
        """Fetches the form_key from /data/user_session if not already cached."""
        if self._form_key:
            return

        # Shared XHR headers (see constants.XHR_HEADERS) guarantee parity
        # with the authenticator's verification call to this endpoint;
        # the session cookies provide auth.
        headers = dict(XHR_HEADERS)
        headers["User-Agent"] = self.user_agent

        try:
            response = self.session.get(
                INSTAPAPER_USER_SESSION_URL,
                headers=headers,
                timeout=self.DEFAULT_REQUEST_TIMEOUT,
            )
            if response.ok:
                try:
                    data = response.json()
                    form_key = data.get("user", {}).get("form_key")
                    if form_key:
                        self._form_key = form_key
                except ValueError:
                    logging.warning(self.MSG_INVALID_JSON)
            else:
                logging.warning(
                    self.MSG_SESSION_FETCH_NON_OK.format(
                        status_code=response.status_code
                    )
                )
        except requests.RequestException as e:
            logging.warning(self.MSG_SESSION_FETCH_FAILED.format(e=e))

    def get_articles(
        self,
        page: int = DEFAULT_PAGE_START,
        folder_info: dict[str, str] | None = None,
        add_article_preview: bool = False,
    ) -> tuple[list[dict[str, str]], bool]:
        """
        Fetches a single page of articles via the JSON API.
        Args:
            page: The page number to fetch.
            folder_info: A dictionary containing 'id' and 'slug' of the folder to fetch articles from.
            add_article_preview: Whether to include the article preview (maps to JSON 'description').
        Returns:
            A tuple containing:
            - A list of article data (dictionaries with id, title, url, and optional fields).
            - A boolean indicating if there is a next page.
        """
        params = self._build_request_params(page, folder_info)
        last_exception: Exception | None = None

        for attempt in range(self.max_retries):
            try:
                if not self._form_key:
                    self._fetch_form_key()

                headers = self._get_headers()
                response = self.session.get(
                    INSTAPAPER_BOOKMARKS_URL,
                    params=params,
                    headers=headers,
                    timeout=self.DEFAULT_REQUEST_TIMEOUT,
                )
                response.raise_for_status()

                data = response.json()
                if "bookmarks" not in data:
                    raise InstapaperAPIError(self.MSG_INVALID_JSON)

                bookmarks = data.get("bookmarks", [])
                has_more = data.get("has_more", False)

                articles = self._parse_bookmarks(bookmarks, add_article_preview)
                return articles, has_more

            except requests.exceptions.HTTPError as e:
                last_exception = e
                if self._handle_http_error(e, attempt):
                    continue  # Retry if the handler decided to wait
                else:
                    raise e  # Re-raise if the error is unrecoverable

            except (
                requests.exceptions.ConnectionError,
                requests.exceptions.Timeout,
            ) as e:
                last_exception = e
                self._wait_for_retry(
                    attempt,
                    self.MSG_NETWORK_ERROR_REASON.format(error_type=type(e).__name__),
                )

            except InstapaperAPIError as e:
                logging.error(self.MSG_API_RESPONSE_ERROR.format(e=e))
                raise
            except ValueError as e:
                logging.error(self.MSG_API_RESPONSE_ERROR.format(e=e))
                raise ApiParseError(self.MSG_API_RESPONSE_ERROR.format(e=e))
            except Exception as e:
                last_exception = e
                self._wait_for_retry(
                    attempt,
                    self.MSG_SCRAPING_FAILED_UNKNOWN,
                )

        logging.error(self.MSG_ALL_RETRIES_FAILED.format(max_retries=self.max_retries))
        if last_exception:
            raise last_exception
        raise Exception(self.MSG_SCRAPING_FAILED_UNKNOWN)

    def _build_request_params(
        self, page: int, folder_info: dict[str, str] | None
    ) -> dict[str, Any]:
        """Builds query parameters for the bookmarks API request."""
        folder_id = (folder_info or {}).get("id")
        section_type = (
            self.SPECIAL_SECTIONS.get(folder_id)
            if folder_id in self.SPECIAL_SECTIONS
            else (SECTION_FOLDER if folder_id else SECTION_HOME)
        )

        params: dict[str, Any] = {
            "section_type": section_type,
            "page": page,
            "sort": SORT_NEWEST,
        }
        if section_type == SECTION_FOLDER and folder_id:
            params["folder_id"] = folder_id
        return params

    def _parse_bookmarks(
        self, bookmarks: list[dict[str, Any]], add_article_preview: bool
    ) -> list[dict[str, Any]]:
        """Parses JSON bookmark objects into the standard article dict format."""
        articles: list[dict[str, Any]] = []
        for bm in bookmarks:
            bookmark_id = bm.get("id")
            if not bookmark_id:
                logging.warning(self.MSG_BOOKMARK_MISSING_ID)
                continue

            try:
                article: dict[str, Any] = {KEY_ID: str(bookmark_id)}

                title = bm.get("title")
                if not title:
                    logging.warning(
                        self.MSG_BOOKMARK_ID_NOT_FOUND.format(
                            bookmark_id=article[KEY_ID], field="title"
                        )
                    )
                    article[KEY_TITLE] = ""
                else:
                    article[KEY_TITLE] = title

                url = bm.get("url")
                if not url:
                    logging.warning(
                        self.MSG_BOOKMARK_ID_NOT_FOUND.format(
                            bookmark_id=article[KEY_ID], field="url"
                        )
                    )
                    article[KEY_URL] = ""
                else:
                    article[KEY_URL] = url

                if add_article_preview:
                    article[KEY_ARTICLE_PREVIEW] = bm.get(KEY_DESCRIPTION, "")

                for key, json_key in [
                    (KEY_AUTHOR, "author"),
                    (KEY_TIME, "time"),
                    (KEY_SITE_NAME, "site_name"),
                    (KEY_LIKED, "liked"),
                    (KEY_IS_ARCHIVED, "is_archived"),
                    (KEY_TAGS, "tags"),
                    (KEY_NOTES, "notes"),
                ]:
                    if json_key in bm:
                        article[key] = bm[json_key]

                articles.append(article)
            except (KeyError, TypeError, ValueError) as e:
                logging.warning(self.MSG_PARSE_FAILED.format(id=article[KEY_ID], e=e))
                continue
        return articles

    def get_all_articles(
        self,
        limit: int | None = None,
        folder_info: dict[str, str] | None = None,
        add_article_preview: bool = False,
    ) -> list[dict[str, str]]:
        """
        Iterates through pages and fetches articles up to a specified limit.
        Args:
            limit: The maximum number of pages to scrape. If None, scrapes all pages.
            folder_info: A dictionary containing 'id' and 'slug' of the folder to fetch articles from.
            add_article_preview: Whether to include the article preview.
        """
        all_articles = []
        page = self.DEFAULT_PAGE_START
        has_more = True
        while has_more:
            if limit is not None and page > limit:
                logging.info(f"Reached page limit of {limit}.")
                break

            logging.info(self.MSG_SCRAPING_PAGE.format(page=page))
            data, has_more = self.get_articles(
                page=page,
                folder_info=folder_info,
                add_article_preview=add_article_preview,
            )
            if data:
                all_articles.extend(data)
            page += 1
        return all_articles

    def get_all_articles_tolerant(
        self,
        limit: int | None = None,
        folder_info: dict[str, str] | None = None,
        add_article_preview: bool = False,
    ) -> ScrapeResult:
        """Fetches pages like :meth:`get_all_articles` but never raises for a
        page that fails after its retries are exhausted.

        Instead it stops at the failing page (no request is issued for any
        later page), returns everything collected so far, and reports why it
        stopped via :class:`ScrapeResult`.

        Only the outcome of fetching one page is converted into a stop
        reason. Every other piece of information (HTTP status, exception
        type and message, the page number) is preserved in
        :attr:`ScrapeResult.error_detail` and logged, so the tolerant path
        never hides why a page failed.

        Retry behaviour is inherited from :meth:`get_articles`: retryable
        errors (5xx, 429 with/without Retry-After, network errors) use the
        existing backoff, and unrecoverable statuses such as 404 are not
        retried at all. Whatever the page ultimately failed with is recorded
        as the stop reason's error detail.
        """
        all_articles: list[dict[str, str]] = []
        page = self.DEFAULT_PAGE_START
        has_more = True
        pages_scraped = 0

        while has_more:
            if limit is not None and page > limit:
                logging.info(f"Reached page limit of {limit}.")
                return ScrapeResult(
                    articles=all_articles,
                    stop_reason=StopReason.PAGE_LIMIT,
                    pages_scraped=pages_scraped,
                    page_limit=limit,
                )

            logging.info(self.MSG_SCRAPING_PAGE.format(page=page))
            try:
                data, has_more = self.get_articles(
                    page=page,
                    folder_info=folder_info,
                    add_article_preview=add_article_preview,
                )
            except InstapaperAPIError as e:
                # A 200 response whose payload shape is unusable (most
                # commonly no "bookmarks" field, or a body that isn't JSON).
                # Retrying cannot fix it, so record and stop.
                if isinstance(e, ApiParseError):
                    reason = f"invalid JSON response ({e})"
                else:
                    reason = MSG_MISSING_BOOKMARKS_FIELD
                logging.error(
                    self.MSG_STOP_INVALID_RESPONSE_LOGGED.format(
                        page=page, reason=reason
                    )
                )
                return ScrapeResult(
                    articles=all_articles,
                    stop_reason=StopReason.INVALID_DATA,
                    pages_scraped=pages_scraped,
                    failed_page=page,
                    error_detail=reason,
                )
            except Exception as e:
                # get_articles() applied the retry policy and re-raised the
                # last error, so this is a page-level failure: a
                # retry-exhausted 5xx/network error, an unrecoverable
                # status (e.g. 404), or an unexpected error it retried.
                # Stop here: never request a page after the failed one.
                # The status/exception type/message is preserved in the
                # summary rather than swallowed.
                detail = self._describe_page_failure(e)
                logging.error(
                    self.MSG_STOP_PAGE_FAILED_LOGGED.format(page=page, error=detail)
                )
                return ScrapeResult(
                    articles=all_articles,
                    stop_reason=StopReason.PAGE_FAILED,
                    pages_scraped=pages_scraped,
                    failed_page=page,
                    error_detail=detail,
                )

            pages_scraped += 1
            if data:
                all_articles.extend(data)
            page += 1

        return ScrapeResult(
            articles=all_articles,
            stop_reason=StopReason.COMPLETED,
            pages_scraped=pages_scraped,
        )

    def _describe_page_failure(self, error: Exception) -> str:
        """Builds a concise, human-readable description of a page failure.

        Includes the HTTP status code when the failure came from a response,
        otherwise the exception type (e.g. ``ConnectionError``).
        """
        if (
            isinstance(error, requests.exceptions.HTTPError)
            and error.response is not None
        ):
            status_code = error.response.status_code
            reason = error.response.reason
            if reason and str(reason) != str(status_code):
                return f"HTTP {status_code} {reason}"
            return f"HTTP {status_code}"
        if isinstance(
            error, (requests.exceptions.ConnectionError, requests.exceptions.Timeout)
        ):
            return type(error).__name__
        message = str(error)
        return f"{type(error).__name__}: {message}" if message else type(error).__name__

    def _handle_http_error(
        self, e: requests.exceptions.HTTPError, attempt: int
    ) -> bool:
        """Handles HTTP errors, returns True if a retry should be attempted."""
        status_code = e.response.status_code
        if status_code == self.HTTP_TOO_MANY_REQUESTS:
            wait_time_str = e.response.headers.get("Retry-After")
            try:
                wait_time = int(wait_time_str) if wait_time_str else 0
                if wait_time > 0:
                    logging.warning(
                        self.MSG_RATE_LIMITED_RETRY.format(
                            status_code=status_code, wait_time=wait_time
                        )
                    )
                    time.sleep(wait_time)
                    return True
            except (ValueError, TypeError):
                pass

            self._wait_for_retry(
                attempt,
                self.MSG_RATE_LIMITED_REASON.format(status_code=status_code),
            )
            return True
        elif self.HTTP_SERVER_ERROR_START <= status_code < self.HTTP_SERVER_ERROR_END:
            self._wait_for_retry(
                attempt,
                self.MSG_REQUEST_FAILED_STATUS_REASON.format(status_code=status_code),
            )
            return True
        elif status_code == 404:
            logging.error(
                f"Error 404: Not Found. This might indicate an invalid folder ID or slug. URL: {e.response.url}"
            )
            return False
        else:
            logging.error(
                self.MSG_REQUEST_FAILED_UNRECOVERABLE.format(status_code=status_code)
            )
            return False

    def _wait_for_retry(self, attempt: int, reason: str) -> None:
        """Calculates and waits for an exponential backoff period."""
        sleep_time = self.backoff_factor * (2**attempt)
        logging.warning(
            self.MSG_RETRY_ATTEMPT.format(
                reason=reason,
                attempt_num=attempt + 1,
                max_retries=self.max_retries,
                sleep_time=sleep_time,
            )
        )
        time.sleep(sleep_time)
