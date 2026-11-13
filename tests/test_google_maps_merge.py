"""The single-business merge chain and the run's collection checklist.

The production scraper merges two sources for every business — the feed card
and the place detail page — and must keep going, with an honest record of
what is missing and where, when one of them fails.  These tests drive the
real :class:`GoogleMapsScraper` merge logic against a *fake* browser: the
DOM is a dict of stand-in elements and navigation never leaves the process,
so nothing here touches a network or needs Chrome installed.

Four behaviours are pinned:

1. a fully rendered detail page wins every field and is logged ``detail``;
2. a detail page that never renders a title, even after the retries, is
   rescued from the feed card and logged ``card`` (never ``detail``);
3. fields the card itself does not carry are stamped ``missing``, and a
   plus code computed from the URL coordinates is stamped ``computed``;
4. one business that has neither card nor detail page is recorded as
   ``failed`` with a reason and does not stop the businesses behind it.
"""

from __future__ import annotations

import csv

import pytest
from selenium.common.exceptions import (
    NoSuchElementException,
    TimeoutException,
)

from google_maps_scraper import (
    FIELD_SOURCE_FIELDS,
    SOURCE_CARD,
    SOURCE_COMPUTED,
    SOURCE_DETAIL,
    SOURCE_MISSING,
    STATUS_CARD,
    STATUS_DETAIL,
    STATUS_FAILED,
    GoogleMapsScraper,
)


# ------------------------------------------------------------------- the fakes

class FakeElement:
    """One node of a stand-in Maps detail panel or feed card."""

    def __init__(self, text="", attrs=None, children=None, parent=None):
        self.text = text
        self._attrs = attrs or {}
        self._children = children or {}
        self._parent = parent

    def get_attribute(self, name):
        return self._attrs.get(name)

    def find_element(self, by, selector):
        if selector == "./..":
            if self._parent is None:
                raise NoSuchElementException(selector)
            return self._parent
        found = self._children.get(selector)
        if isinstance(found, list):
            found = found[0] if found else None
        if found is None:
            raise NoSuchElementException(selector)
        return found

    def find_elements(self, by, selector):
        found = self._children.get(selector, [])
        return found if isinstance(found, list) else [found]

    def click(self):
        return None


class FakeWait:
    """Stands in for Selenium's ``WebDriverWait``.

    ``timed_out_urls`` names the place pages whose title never renders: the
    wait on those pages raises :class:`TimeoutException` on every attempt,
    exactly like a half-hydrated Maps panel.
    """

    def __init__(self, timed_out_urls=()):
        self.timed_out_urls = set(timed_out_urls)
        self.waited = []

    def until(self, _condition):
        # The driver tells the wait which URL it is currently on.
        url = getattr(self, "current_url", "")
        self.waited.append(url)
        if url in self.timed_out_urls:
            raise TimeoutException(f"timed out waiting for h1 on {url}")
        return True


class FakeDriver:
    """A browser with no browser: ``get`` swaps in the page's node table."""

    def __init__(self, pages, timed_out_urls=()):
        # URL -> dict(selector -> FakeElement | [FakeElement])
        self.pages = pages
        self.current_url = ""
        self._wait = FakeWait(timed_out_urls)
        self.navigations = 0

    def get(self, url):
        self.current_url = url
        self.navigations += 1
        # The wait reads the same current URL the driver does.
        self._wait.current_url = url

    @property
    def wait(self):
        return self._wait

    def _nodes(self):
        return self.pages.get(self.current_url, {})

    def find_element(self, by, selector):
        found = self._nodes().get(selector)
        if isinstance(found, list):
            found = found[0] if found else None
        if found is None:
            raise NoSuchElementException(selector)
        return found

    def find_elements(self, by, selector):
        found = self._nodes().get(selector, [])
        return found if isinstance(found, list) else [found]

    def execute_script(self, *_args, **_kwargs):
        return None

    def quit(self):
        return None


def _scraper(driver, monkeypatch, search_term="Roofers", location="Zanesville, OH"):
    """A real GoogleMapsScraper wired to the fake browser, no Chrome launched."""
    monkeypatch.setattr("google_maps_scraper.time.sleep", lambda *_a, **_k: None)
    scraper = GoogleMapsScraper.__new__(GoogleMapsScraper)
    scraper.driver = driver
    scraper.wait = driver.wait
    scraper.businesses = []
    scraper.audit = []
    scraper._cards = {}
    scraper.search_term = search_term
    scraper.location = location
    return scraper


def full_panel_nodes(url):
    """The node table of a detail page that rendered every row."""
    rating_row = FakeElement()
    rating = FakeElement(
        text="4.8",
        children={'span[aria-hidden="true"]': FakeElement("4.8")},
        parent=rating_row,
    )
    rating_row._children = {"span": [FakeElement("4.8"), FakeElement("(127)")]}

    return {
        "h1.DUwDvf": FakeElement("Bright Spark Electric"),
        "div.F7nice": rating,
        "button.DkEaL": FakeElement("Electrician"),
        'button[data-item-id="address"]': FakeElement(
            attrs={"aria-label": "Address: 123 Main St, Zanesville, OH 43701"}),
        'button[data-item-id^="phone"]': FakeElement(
            attrs={"data-item-id": "phone:tel:+16145550142"}),
        'a[data-item-id="authority"]': FakeElement(
            attrs={"href": "https://brightspark.example/"}),
        'button[data-item-id="oloc"]': FakeElement(
            attrs={"aria-label": "Plus code: 2222+22 Zurich, Switzerland"}),
        '[aria-label*="Copy open hours" i]': [
            FakeElement(attrs={"aria-label":
                               "Monday, 8 AM to 5 PM, Copy open hours"}),
        ],
    }


# A pin-carrying place URL, so the computed-plus-code fallback has something
# to work with when the panel never renders the oloc row.
PIN_URL = ("https://www.google.com/maps/place/Acme/@39.1,-82.1,17z/"
           "data=!4m6!3m5!1s0x0!8m2!3d47.0000625!4d8.0000625")
# A URL without coordinates: even the computed plus code has to give up.
NO_COORDS_URL = "https://www.google.com/maps/place/Acme/data=!1s0x0"


def full_card(url=PIN_URL):
    """A feed card carrying the fields the panel might miss."""
    return {
        "name": "Bright Spark Electric",
        "rating": "4.8",
        "reviews_count": "127",
        "category": "Electrician",
        "address": "123 Main St (from card)",
        "phone": "(614) 555-0142",
        "phone_e164": "+16145550142",
        "website": "https://brightspark.example/card",
        "url": url,
    }


def sparse_card(url=PIN_URL):
    """A card with only name and phone — every other field must read missing."""
    return {
        "name": "Sparse Card Shop",
        "phone": "(740) 453-3649",
        "phone_e164": "+17404533649",
        "url": url,
    }


# ------------------------------------------------------------- 1. detail wins

class TestDetailPageWins:
    def test_a_rendered_panel_fills_and_stamps_every_field(self, monkeypatch):
        driver = FakeDriver({PIN_URL: full_panel_nodes(PIN_URL)})
        scraper = _scraper(driver, monkeypatch)

        data = scraper._scrape_one(PIN_URL, full_card())

        # The detail values, not the card's, are what the record keeps.
        assert data["name"] == "Bright Spark Electric"
        assert data["phone"] == "(614) 555-0142"
        assert data["address"] == "123 Main St, Zanesville, OH 43701"
        assert data["website"] == "https://brightspark.example/"
        assert data["rating"] == "4.8"
        assert data["reviews_count"] == "127"
        assert data["category"] == "Electrician"
        assert data["hours"] == "Monday: 8 AM to 5 PM"
        assert data["plus_code"] == "2222+22 Zurich, Switzerland"

        assert data["_record_status"] == STATUS_DETAIL
        sources = data["_field_sources"]
        # Every key field is accounted for and only the four legal values
        # ever appear in a provenance map.
        assert set(sources) == set(FIELD_SOURCE_FIELDS)
        assert set(sources.values()) <= {
            SOURCE_DETAIL, SOURCE_CARD, SOURCE_COMPUTED, SOURCE_MISSING}
        # The rendered panel is the authority for all nine fields here.
        assert all(source == SOURCE_DETAIL for source in sources.values())

        # One audit entry, and it is a detail success rather than a fallback.
        assert len(scraper.audit) == 1
        assert scraper.audit[0]["status"] == STATUS_DETAIL
        assert scraper.audit[0]["name"] == "Bright Spark Electric"
        assert scraper.audit[0]["sources"] == sources

    def test_a_half_rendered_panel_takes_gaps_from_the_card(self, monkeypatch):
        # Panel renders its title but is missing website, address and hours.
        nodes = full_panel_nodes(PIN_URL)
        for selector in ('a[data-item-id="authority"]',
                         'button[data-item-id="address"]',
                         '[aria-label*="Copy open hours" i]'):
            nodes.pop(selector)
        driver = FakeDriver({PIN_URL: nodes})
        scraper = _scraper(driver, monkeypatch)

        data = scraper._scrape_one(PIN_URL, full_card())

        assert data["_record_status"] == STATUS_DETAIL
        sources = data["_field_sources"]
        assert sources["name"] == SOURCE_DETAIL
        assert sources["phone"] == SOURCE_DETAIL
        # The card rescued exactly the rows the panel did not render.
        assert sources["website"] == SOURCE_CARD
        assert data["website"] == "https://brightspark.example/card"
        assert sources["address"] == SOURCE_CARD
        assert data["address"] == "123 Main St (from card)"
        assert sources["hours"] == SOURCE_MISSING
        assert data["hours"] == ""


# ---------------------------------------------------- 2. timeout -> card rescue

class TestDetailTimeoutFallsBackToCard:
    def test_retries_then_builds_a_card_record(self, monkeypatch):
        # The panel never renders its h1, on either attempt.
        driver = FakeDriver({PIN_URL: {}}, timed_out_urls={PIN_URL})
        scraper = _scraper(driver, monkeypatch)

        data = scraper._scrape_one(PIN_URL, full_card(), attempts=2)

        # Two real navigation attempts were made before giving up.
        assert driver.navigations == 2
        assert data is not None
        assert data["name"] == "Bright Spark Electric"
        assert data["phone"] == "(614) 555-0142"
        assert data["phone_e164"] == "+16145550142"
        assert data["url"] == PIN_URL

        # A rescued record is card provenance, never a detail success.
        assert data["_record_status"] == STATUS_CARD
        sources = data["_field_sources"]
        for field in ("name", "phone", "address", "website", "rating",
                      "reviews_count", "category"):
            assert sources[field] == SOURCE_CARD
        # The card has no hours row and no plus code: hours is missing,
        # while the plus code is computed from the URL's own pin.
        assert sources["hours"] == SOURCE_MISSING
        assert sources["plus_code"] == SOURCE_COMPUTED
        assert data["plus_code"] == "8FVC2222+22"

        entry = scraper.audit[-1]
        assert entry["status"] == STATUS_CARD
        assert "title" in entry["reason"] or "timed out" in entry["reason"]

    def test_card_fallback_is_never_counted_as_a_detail_success(self, monkeypatch):
        driver = FakeDriver({PIN_URL: {}}, timed_out_urls={PIN_URL})
        scraper = _scraper(driver, monkeypatch)
        scraper._scrape_one(PIN_URL, full_card())

        summary = scraper.checklist_summary()
        assert summary == {STATUS_DETAIL: 0, STATUS_CARD: 1, STATUS_FAILED: 0}


# --------------------------------------------- 3. sparse card -> missing/computed

class TestSparseCardMarksMissingFields:
    def test_card_gaps_are_missing_and_the_pin_is_computed(self, monkeypatch):
        driver = FakeDriver({PIN_URL: {}}, timed_out_urls={PIN_URL})
        scraper = _scraper(driver, monkeypatch)

        data = scraper._scrape_one(PIN_URL, sparse_card())

        assert data["_record_status"] == STATUS_CARD
        sources = data["_field_sources"]
        assert sources["name"] == SOURCE_CARD
        assert sources["phone"] == SOURCE_CARD
        for field in ("address", "website", "rating", "reviews_count",
                      "category", "hours"):
            assert sources[field] == SOURCE_MISSING
            assert data[field] == ""
        # Coordinates in the URL keep the plus-code column alive on their own.
        assert sources["plus_code"] == SOURCE_COMPUTED
        assert data["plus_code"] == "8FVC2222+22"

    def test_no_coordinates_means_the_plus_code_is_missing_too(self, monkeypatch):
        driver = FakeDriver({NO_COORDS_URL: {}},
                            timed_out_urls={NO_COORDS_URL})
        scraper = _scraper(driver, monkeypatch)

        data = scraper._scrape_one(NO_COORDS_URL, sparse_card(NO_COORDS_URL))

        assert data["plus_code"] == ""
        assert data["_field_sources"]["plus_code"] == SOURCE_MISSING
        # The name/phone the card did carry still survive.
        assert data["name"] == "Sparse Card Shop"
        assert data["phone"] == "(740) 453-3649"


# ------------------------------------------- 4. one failure never stops the run

class TestOneFailureDoesNotStopTheRun:
    def _feed(self):
        good_url = PIN_URL
        bad_url = NO_COORDS_URL
        pages = {good_url: full_panel_nodes(good_url), bad_url: {}}
        # The middle listing's panel never renders and it has no card either.
        driver = FakeDriver(pages, timed_out_urls={bad_url})
        cards = {good_url: full_card(good_url)}  # note: no entry for bad_url
        return driver, cards, good_url, bad_url

    def test_failed_business_is_logged_and_the_rest_are_processed(
            self, monkeypatch):
        driver, cards, good_url, bad_url = self._feed()
        scraper = _scraper(driver, monkeypatch)
        monkeypatch.setattr(scraper, "_collect_all_business_urls",
                            lambda: [good_url, bad_url, good_url])
        monkeypatch.setattr(scraper, "_harvest_cards", lambda: cards)

        scraper.scrape_listings()

        # Two good records reached the CSV-bound list; the bad URL produced
        # no record at all rather than an empty row.
        assert len(scraper.businesses) == 2
        assert all(b["url"] == good_url for b in scraper.businesses)

        # All three attempts still have a checklist entry, in run order.
        statuses = [entry["status"] for entry in scraper.audit]
        assert statuses == [STATUS_DETAIL, STATUS_FAILED, STATUS_DETAIL]

        failed = scraper.audit[1]
        assert failed["url"] == bad_url
        assert failed["status"] == STATUS_FAILED
        assert failed["reason"]  # a short reason is retained
        assert all(source == SOURCE_MISSING
                   for source in failed["sources"].values())

        summary = scraper.checklist_summary()
        assert summary == {STATUS_DETAIL: 2, STATUS_CARD: 0, STATUS_FAILED: 1}

    def test_an_unexpected_exception_is_a_failed_entry_not_a_crash(
            self, monkeypatch):
        good_url = PIN_URL
        driver = FakeDriver({good_url: full_panel_nodes(good_url)})
        scraper = _scraper(driver, monkeypatch)

        def boom(_url, _card):
            raise RuntimeError("stale element reference")

        monkeypatch.setattr(scraper, "_collect_all_business_urls",
                            lambda: [good_url, good_url])
        monkeypatch.setattr(scraper, "_harvest_cards", lambda: {})
        # First listing blows up unexpectedly; the second must still run.
        calls = {"n": 0}
        real_one = scraper._scrape_one

        def flaky(url, card):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("stale element reference")
            return real_one(url, card)

        monkeypatch.setattr(scraper, "_scrape_one", flaky)
        scraper.scrape_listings()

        assert len(scraper.businesses) == 1
        statuses = [entry["status"] for entry in scraper.audit]
        assert statuses == [STATUS_FAILED, STATUS_DETAIL]
        assert "stale element reference" in scraper.audit[0]["reason"]


# ------------------------------------------------------- the checklist artefact

class TestChecklistExport:
    def test_checklist_csv_lists_status_provenance_and_reason(
            self, monkeypatch, tmp_path):
        good_url = PIN_URL
        bad_url = NO_COORDS_URL
        another_bad = "https://www.google.com/maps/place/Nothing"
        driver = FakeDriver(
            {good_url: full_panel_nodes(good_url), bad_url: {},
             another_bad: {}},
            timed_out_urls={bad_url, another_bad})
        scraper = _scraper(driver, monkeypatch)

        # One detail success, one card rescue, one total failure.
        scraper._scrape_one(good_url, full_card(good_url))
        scraper._scrape_one(bad_url, sparse_card(bad_url))
        scraper._scrape_one(another_bad, {})

        out = tmp_path / "checklist.csv"
        returned = scraper.save_checklist(out)
        assert returned == out

        with open(out, newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))

        assert len(rows) == 3
        header = set(rows[0])
        assert {"name", "status", "reason", "url"} <= header
        for field in FIELD_SOURCE_FIELDS:
            assert f"source_{field}" in header

        by_status = {row["status"]: row for row in rows}
        assert set(by_status) == {STATUS_DETAIL, STATUS_CARD, STATUS_FAILED}

        detail_row = by_status[STATUS_DETAIL]
        assert detail_row["source_name"] == SOURCE_DETAIL
        assert detail_row["source_plus_code"] == SOURCE_DETAIL
        assert detail_row["reason"] == ""

        card_row = by_status[STATUS_CARD]
        assert card_row["source_name"] == SOURCE_CARD
        assert card_row["source_address"] == SOURCE_MISSING
        # No coordinates in this URL, so the sparse card's plus code is
        # missing rather than computed.
        assert card_row["source_plus_code"] == SOURCE_MISSING

        failed_row = by_status[STATUS_FAILED]
        assert failed_row["reason"]
        assert all(failed_row[f"source_{field}"] == SOURCE_MISSING
                   for field in FIELD_SOURCE_FIELDS)

    def test_provenance_keys_do_not_leak_into_the_listings_csv(
            self, monkeypatch, tmp_path):
        import data_store

        driver = FakeDriver({PIN_URL: full_panel_nodes(PIN_URL)})
        scraper = _scraper(driver, monkeypatch)
        scraper.businesses = [scraper._scrape_one(PIN_URL, full_card())]

        path = scraper.save_to_csv(str(tmp_path / "listings.csv"))
        with open(path, newline="", encoding="utf-8") as handle:
            header = next(csv.reader(handle))
        assert "_field_sources" not in header
        assert "_record_status" not in header
        assert header == list(data_store.LISTING_FIELDS)

    def test_checklist_with_no_attempts_is_a_noop(self, monkeypatch, tmp_path):
        driver = FakeDriver({})
        scraper = _scraper(driver, monkeypatch)
        assert scraper.save_checklist(tmp_path / "empty.csv") is None
        assert not (tmp_path / "empty.csv").exists()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
