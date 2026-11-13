"""
tests/test_listing_early_end.py
-------------------------------
Acceptance coverage for the empty-page / failed-page distinction in
playwright_scraper.py.

The browser is stubbed: every navigation is served from a LOCAL HTML fixture
built here (each carrying a `__NEXT_DATA__` with the listing's own `total` and
`lotsPerPage`), so the whole real `scrape()` flow — fetch, classify, parse,
the page_flow recheck, the sequential and concurrent dispatch loops, the
sidecar and the exit code — runs without a network or a real Chromium.

Three negative/boundary shapes are driven, each through BOTH paths:

  1. page 2 empty on the first fetch, non-empty on the recheck  -> complete
  2. page 2 empty twice                                         -> partial,
     stop_reason listing_ended_early, exit 6, one recheck
  3. a requested page past the listing's declared page count    -> complete,
     no retry, no partial

The concurrent runs must produce the SAME stop reason and the SAME sku set
(after sku dedupe) as the sequential runs over the identical fixtures.
"""
import json
import os
import sys
import threading
from types import SimpleNamespace

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import page_flow
import playwright_scraper as eng
from product_parser import page_number_from_url

CATEGORY_URL = "https://www.catawiki.com/en/c/333-watches"
LOTS_PER_PAGE = 24


# ---------------------------------------------------------------------------
# HTML fixtures — a minimal but real Catawiki-shaped document. The parser and
# the state classifier read __NEXT_DATA__; the price/card markup is included
# too so a row carries its DOM price and the page classifies as "content".
# ---------------------------------------------------------------------------
def _lot(lot_id, page_num):
    return {
        "id": lot_id,
        "title": "Lot %d on page %d" % (lot_id, page_num),
        "subtitle": "Fixture lot",
        "thumbImageUrl": "https://assets.catawiki.nl/x/%d.jpg" % lot_id,
        "originalImageUrl": "https://assets.catawiki.nl/x/%d.jpg" % lot_id,
        "favoriteCount": 0,
        "url": ("https://www.catawiki.com/en/l/%d-lot-%d" % (lot_id, lot_id)),
        "auctionId": 1234,
        "reservePriceSet": False,
        "biddingStartTime": "2026-09-04T10:00:00+00:00",
        "buyNow": None,
        "hasFreeShipping": False,
    }


def _card(lot_id):
    return (
        '<article class="c-lot-card__container">'
        '<a class="c-lot-card" href="https://www.catawiki.com/en/l/%d-lot-%d">'
        '<p class="c-lot-card__title">Lot %d</p>'
        '<p class="c-lot-card__status-text">Current bid</p>'
        '<p class="c-lot-card__price">&euro;100</p>'
        '</a></article>' % (lot_id, lot_id, lot_id)
    )


def build_listing_html(page_num, lots, total, lots_per_page=LOTS_PER_PAGE):
    """A category listing page whose payload states `total`/`lotsPerPage`.

    `lots` is a list of lot ids (empty => the site's own row-less answer,
    which classifies as "empty" because the payload's `lots` list is `[]`).
    """
    payload = {
        "props": {
            "pageProps": {
                "lotsPerPage": lots_per_page,
                "currentPage": page_num,
                "_nextI18Next": {
                    "initialI18nStore": {
                        "en": {"translations": {
                            "lot_status_starting_bid": "Starting bid",
                            "lot_status_current_bid": "Current bid",
                            "lot_status_final_bid": "Final bid"}}}
                },
                "categoryLots": {
                    "lots": [_lot(lid, page_num) for lid in lots],
                    "total": total,
                    "meta": {"extended_search_result": False},
                },
            }
        },
        "page": "/c/[...slug]",
        "buildId": "fixture-build",
        "locale": "en",
    }
    cards = "".join(_card(lid) for lid in lots)
    return (
        '<html lang="en"><body>'
        '<img src="https://assets.catawiki.nl/assets/x.jpg"/>'
        '<link rel="preconnect" href="https://assets.catawiki.nl">'
        '<script id="__NEXT_DATA__" type="application/json">'
        + json.dumps(payload)
        + "</script>"
        + cards
        + "</body></html>"
    )


def lots_for_page(page_num, per_page=LOTS_PER_PAGE, start_id=1000):
    """Deterministic, page-unique lot ids, so sku overlap between pages is
    zero and dedupe never hides which page a row came from."""
    base = start_id + (page_num - 1) * per_page
    return [base + i for i in range(1, per_page + 1)]


# ---------------------------------------------------------------------------
# A scripted "server": maps a requested site page number to the HTML it
# returns, and optionally returns a different document on the Nth request for
# the same page (the empty-then-full / empty-twice shapes).
# ---------------------------------------------------------------------------
class ScriptedServer:
    def __init__(self, responses):
        # responses: dict[page_num] -> list of html strings, served in order;
        # the last entry is repeated for any further request.
        self._responses = responses
        self._hits = {}
        self._lock = threading.Lock()

    def html_for(self, url):
        page_num = page_number_from_url(url)
        with self._lock:
            index = self._hits.get(page_num, 0)
            self._hits[page_num] = index + 1
        seq = self._responses[page_num]
        return seq[min(index, len(seq) - 1)]

    def request_count(self, page_num):
        return self._hits.get(page_num, 0)


class FakePage:
    """The slice of Playwright's Page API _fetch_one_page touches."""

    def __init__(self, server):
        self._server = server
        self.url = CATEGORY_URL
        self._html = ""

    def goto(self, url, wait_until=None, timeout=None):
        self.url = url
        self._html = self._server.html_for(url)

    def content(self):
        return self._html

    def wait_for_timeout(self, _ms):
        return None

    def query_selector_all(self, selector):
        # The readiness/card selectors only need a non-zero count on a content
        # page and zero on an empty one. Count lot cards from the payload.
        if "c-lot-card" in selector or "/l/" in selector:
            count = self._html.count('class="c-lot-card__container"')
            return [object() for _ in range(count)]
        return []

    def evaluate(self, _js):
        # No reCAPTCHA in any fixture; raising is the documented "nothing
        # found" path and the detector swallows it.
        raise RuntimeError("no runtime detection in fixtures")

    def screenshot(self, path=None, full_page=False):
        return None


class FakeSession:
    """Stands in for _BrowserSession; one fake page serves every navigation."""

    def __init__(self, server, pool=None):
        self._server = server
        self.pool = pool
        self.page = FakePage(server)

    def open(self):
        return self

    def close(self):
        return None

    def relaunch(self):
        return None


class FakePlaywright:
    def __init__(self, server):
        self._server = server

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    # _launch_local / _connect_remote are bypassed: the engine builds the
    # session through _BrowserSession, which is stubbed below.


def _make_args(tmp_path, pages, concurrency):
    return SimpleNamespace(
        url=CATEGORY_URL,
        mode="listing",
        category=None,
        pages=pages,
        delay=0,
        concurrency=concurrency,
        retries=1,
        retry_delay=0,
        format="json",
        out=str(tmp_path / "run"),
        locale="nl-NL",
        proxy=None,
        proxy_file=None,
        proxy_rotate="per-run",
        proxy_block_retries=0,
        twocaptcha_key=None,
        allow_empty=True,
        fingerprint=False,
        fp_tags="Windows",
        fp_country=None,
        captcha_api="v2",
        solve_captcha="when-blocked",
        min_score=0.7,
        cdp_endpoint=None,
        dump_html=None,
        headless=True,
        pages_requested=pages,
        pages_capped_by_site=False,
    )


def run_scrape(tmp_path, server, pages, concurrency, monkeypatch):
    """Drive the real scrape() with the browser layer stubbed to the server."""
    # The engine writes zero-row debug dumps beside `--out`, so the folder the
    # prefix points at must exist (the real CLI checks this up front).
    tmp_path.mkdir(parents=True, exist_ok=True)
    args = _make_args(tmp_path, pages, concurrency)

    def fake_playwright():
        return FakePlaywright(server)

    def fake_session(pw, args_, pool, remote=False):
        return FakeSession(server, pool).open()

    monkeypatch.setattr(eng, "sync_playwright", fake_playwright)
    monkeypatch.setattr(eng, "_BrowserSession", fake_session)
    # No proxy pool and no captcha work in these fixtures.
    monkeypatch.setattr(eng, "proxy_pool_from_args", lambda args_: None)
    monkeypatch.setattr(eng, "handle_captcha_if_present",
                        lambda page, args_, budget: False)

    rc = eng.scrape(args)
    meta_path = args.out + ".meta.json"
    with open(meta_path, encoding="utf-8") as fh:
        meta = json.load(fh)
    with open(args.out + ".json", encoding="utf-8") as fh:
        rows = json.load(fh)
    return rc, meta, rows


def _skus(rows):
    return sorted(r["sku"] for r in rows)


# A 5-page listing (5 * 24 = 120 lots), used by every scenario.
TOTAL = 5 * LOTS_PER_PAGE
DECLARED_PAGES = 5


def _full_page(page_num):
    return build_listing_html(page_num, lots_for_page(page_num), TOTAL)


def _empty_page(page_num):
    return build_listing_html(page_num, [], TOTAL)


# ---------------------------------------------------------------------------
# Scenario 1: page 2 empty on the FIRST fetch, full on the recheck.
# ---------------------------------------------------------------------------
def test_page2_empty_then_full_recovers_sequential(tmp_path, monkeypatch):
    server = ScriptedServer({
        1: [_full_page(1)],
        2: [_empty_page(2), _full_page(2)],
        3: [_full_page(3)],
        4: [_full_page(4)],
        5: [_full_page(5)],
    })
    rc, meta, rows = run_scrape(tmp_path, server, 5, 1, monkeypatch)

    assert rc == 0
    assert meta["status"] == "complete"
    assert meta["stop_reason"] == "completed"
    assert meta["pages_failed"] == []
    # Exactly one re-fetch of page 2, and it recovered.
    assert server.request_count(2) == 2
    assert meta.get("empty_page_rechecks", 0) == 1
    assert meta.get("pages_early_empty") in (None, [])
    # Every lot of the five-page listing is present, deduped by sku.
    expected = sorted(str(s) for p in range(1, 6) for s in lots_for_page(p))
    assert _skus(rows) == expected


def test_page2_empty_then_full_concurrent_matches_sequential(tmp_path, monkeypatch):
    responses = {
        1: [_full_page(1)],
        2: [_empty_page(2), _full_page(2)],
        3: [_full_page(3)],
        4: [_full_page(4)],
        5: [_full_page(5)],
    }
    seq_rc, seq_meta, seq_rows = run_scrape(
        tmp_path / "seq", ScriptedServer(responses), 5, 1, monkeypatch)
    con_rc, con_meta, con_rows = run_scrape(
        tmp_path / "con", ScriptedServer(responses), 5, 3, monkeypatch)

    assert con_rc == seq_rc == 0
    assert con_meta["stop_reason"] == seq_meta["stop_reason"] == "completed"
    assert con_meta["status"] == "complete"
    assert _skus(con_rows) == _skus(seq_rows)
    assert con_meta["pages_failed"] == []
    assert con_meta.get("pages_unattempted") in (None, [])


# ---------------------------------------------------------------------------
# Scenario 2: page 2 empty TWICE -> listing_ended_early, partial, exit 6.
# ---------------------------------------------------------------------------
def test_page2_empty_twice_is_partial_sequential(tmp_path, monkeypatch):
    server = ScriptedServer({
        1: [_full_page(1)],
        2: [_empty_page(2), _empty_page(2)],
        3: [_full_page(3)],
        4: [_full_page(4)],
        5: [_full_page(5)],
    })
    rc, meta, rows = run_scrape(tmp_path, server, 5, 1, monkeypatch)

    assert rc == 6
    assert meta["status"] == "partial"
    assert meta["stop_reason"] == "listing_ended_early"
    assert meta["pages_failed"] == []
    assert meta["pages_early_empty"] == [2]
    # One retry: two fetches total for page 2 (first answer + one recheck).
    assert server.request_count(2) == 2
    assert meta["empty_page_rechecks"] == 1
    # Pages 3-5 were never reached in the sequential path.
    assert server.request_count(3) == 0
    # Only page 1's rows survive; they are still written.
    assert _skus(rows) == sorted(str(s) for s in lots_for_page(1))


def test_page2_empty_twice_concurrent_matches_sequential(tmp_path, monkeypatch):
    responses = {
        1: [_full_page(1)],
        2: [_empty_page(2), _empty_page(2)],
        3: [_full_page(3)],
        4: [_full_page(4)],
        5: [_full_page(5)],
    }
    seq_rc, seq_meta, seq_rows = run_scrape(
        tmp_path / "seq", ScriptedServer(responses), 5, 1, monkeypatch)
    con_rc, con_meta, con_rows = run_scrape(
        tmp_path / "con", ScriptedServer(responses), 5, 4, monkeypatch)

    # Same stop reason, status, exit code and row set as the sequential path.
    assert con_rc == seq_rc == 6
    assert con_meta["status"] == "partial"
    assert con_meta["stop_reason"] == seq_meta["stop_reason"] == "listing_ended_early"
    assert _skus(con_rows) == _skus(seq_rows)
    assert con_meta["pages_early_empty"] == [2]
    assert con_meta["empty_page_rechecks"] == 1
    # The pages beyond the early end are recorded separately (the ones still
    # queued plus any fetched in flight and discarded for parity) and are NOT
    # counted as failed.
    assert con_meta["pages_failed"] == []
    unattempted = con_meta.get("pages_unattempted", [])
    # Every page past the twice-empty page 2 is accounted for: none can vanish,
    # and none may be reported as a failure.
    assert set(unattempted) == {3, 4, 5}
    # Pages that DID run past the early end must not leak rows into the output;
    # the concurrent output equals the sequential one (page 1 only), asserted
    # above via the sku comparison.


# ---------------------------------------------------------------------------
# Scenario 3: a requested page past the DECLARED page count. Zero rows there
# is the normal end: no retry, no partial, status complete.
# ---------------------------------------------------------------------------
def test_page_beyond_declared_count_is_normal_end_sequential(tmp_path, monkeypatch):
    # The listing declares 5 pages; the run asks for 7. Page 6 is past the end.
    server = ScriptedServer({
        n: [_full_page(n)] for n in range(1, 6)
    } | {
        6: [_empty_page(6)],
        7: [_empty_page(7)],
    })
    rc, meta, rows = run_scrape(tmp_path, server, 7, 1, monkeypatch)

    assert rc == 0
    assert meta["status"] == "complete"
    assert meta["stop_reason"] == "no_new_products"
    assert meta["pages_failed"] == []
    # The past-end empty page is NOT retried.
    assert server.request_count(6) == 1
    assert meta.get("empty_page_rechecks", 0) == 0
    assert meta.get("pages_early_empty") in (None, [])
    assert meta["pages_normal_empty"] == [6]
    # Only the five real pages' lots are present.
    expected = sorted(str(s) for p in range(1, 6) for s in lots_for_page(p))
    assert _skus(rows) == expected


def test_page_beyond_declared_count_concurrent_matches_sequential(tmp_path, monkeypatch):
    responses = {n: [_full_page(n)] for n in range(1, 6)}
    responses[6] = [_empty_page(6)]
    responses[7] = [_empty_page(7)]

    seq_rc, seq_meta, seq_rows = run_scrape(
        tmp_path / "seq", ScriptedServer(responses), 7, 1, monkeypatch)
    con_rc, con_meta, con_rows = run_scrape(
        tmp_path / "con", ScriptedServer(responses), 7, 3, monkeypatch)

    assert con_rc == seq_rc == 0
    assert con_meta["status"] == "complete"
    assert con_meta["stop_reason"] == seq_meta["stop_reason"] == "no_new_products"
    assert _skus(con_rows) == _skus(seq_rows)
    assert con_meta["pages_failed"] == []
    assert con_meta.get("pages_early_empty") in (None, [])
    # The past-end empty page was fetched exactly once (no recheck).
    # Which page lands first under threads is nondeterministic, but every
    # normal-empty page has a single request against the scripted server.
    assert 6 in con_meta.get("pages_normal_empty", [])


# ---------------------------------------------------------------------------
# Boundary: a listing whose payload says it has exactly ONE page. An empty
# page 2 (if one is requested) is the normal end, never an early end.
# ---------------------------------------------------------------------------
def test_single_page_listing_empty_page2_is_normal(tmp_path, monkeypatch):
    one_total = LOTS_PER_PAGE  # one full page
    server = ScriptedServer({
        1: [build_listing_html(1, lots_for_page(1), one_total)],
        2: [build_listing_html(2, [], one_total)],
        3: [build_listing_html(3, [], one_total)],
    })
    rc, meta, rows = run_scrape(tmp_path, server, 3, 1, monkeypatch)

    assert rc == 0
    assert meta["status"] == "complete"
    assert meta["stop_reason"] == "no_new_products"
    assert meta.get("pages_early_empty") in (None, [])
    assert server.request_count(2) == 1  # not retried
    assert _skus(rows) == sorted(str(s) for s in lots_for_page(1))


# ---------------------------------------------------------------------------
# Negative: a FAILED page (load failure) must stay distinct from an empty one.
# It is reported in pages_failed, never as an early/normal empty, and the run
# is partial (not complete) with exit 6 since page 1's rows were gathered.
# ---------------------------------------------------------------------------
def test_failed_page_is_distinct_from_empty(tmp_path, monkeypatch):
    server = ScriptedServer({
        1: [_full_page(1)],
        2: [_full_page(2)],
        3: [_full_page(3)],
    })
    original_fetch = eng._fetch_one_page

    def fetch_with_failure(session, args_, pool, page_num, url):
        if page_num == 3:
            outcome = eng.PageOutcome(page_num=page_num, url=url)
            outcome.load_failed = True
            return outcome
        return original_fetch(session, args_, pool, page_num, url)

    monkeypatch.setattr(eng, "sync_playwright",
                        lambda: FakePlaywright(server))
    monkeypatch.setattr(eng, "_BrowserSession",
                        lambda pw, args_, pool, remote=False:
                        FakeSession(server, pool).open())
    monkeypatch.setattr(eng, "proxy_pool_from_args", lambda args_: None)
    monkeypatch.setattr(eng, "handle_captcha_if_present",
                        lambda page, args_, budget: False)
    monkeypatch.setattr(eng, "_fetch_one_page", fetch_with_failure)

    args = _make_args(tmp_path, 4, 1)
    rc = eng.scrape(args)
    with open(args.out + ".meta.json", encoding="utf-8") as fh:
        meta = json.load(fh)

    assert rc == 6
    assert meta["status"] == "partial"
    assert meta["stop_reason"] == "page_load_timeout"
    assert meta["pages_failed"] == [3]
    assert meta.get("pages_early_empty") in (None, [])
    assert meta.get("pages_normal_empty") in (None, [])


def test_early_empty_whose_refetch_fails_is_a_failure_not_an_early_end(
        tmp_path, monkeypatch):
    # Page 2 is empty on the first fetch (so a recheck is warranted), but the
    # re-fetch dies. A failed second answer is a FAILED page, not "empty twice":
    # the stop must be the load failure, pages_early_empty stays empty and the
    # page lands in pages_failed.
    server = ScriptedServer({
        1: [_full_page(1)],
        2: [_empty_page(2)],
        3: [_full_page(3)],
    })
    original_fetch = eng._fetch_one_page
    page2_calls = {"n": 0}

    def fetch_with_second_attempt_failure(session, args_, pool, page_num, url):
        outcome = original_fetch(session, args_, pool, page_num, url)
        if page_num == 2:
            page2_calls["n"] += 1
            # The first answer is a genuine empty page; the re-fetch dies.
            if page2_calls["n"] >= 2:
                outcome.load_failed = True
                outcome.products = []
        return outcome

    monkeypatch.setattr(eng, "sync_playwright",
                        lambda: FakePlaywright(server))
    monkeypatch.setattr(eng, "_BrowserSession",
                        lambda pw, args_, pool, remote=False:
                        FakeSession(server, pool).open())
    monkeypatch.setattr(eng, "proxy_pool_from_args", lambda args_: None)
    monkeypatch.setattr(eng, "handle_captcha_if_present",
                        lambda page, args_, budget: False)
    monkeypatch.setattr(eng, "_fetch_one_page", fetch_with_second_attempt_failure)

    args = _make_args(tmp_path, 3, 1)
    rc = eng.scrape(args)
    with open(args.out + ".meta.json", encoding="utf-8") as fh:
        meta = json.load(fh)

    assert rc == 6
    assert meta["status"] == "partial"
    assert meta["stop_reason"] == "page_load_timeout"
    assert meta["pages_failed"] == [2]
    assert meta.get("pages_early_empty") in (None, [])


def test_concurrent_failed_refetch_is_a_failure_not_an_early_end(
        tmp_path, monkeypatch):
    # Same shape as the sequential case, through the threaded path: page 2's
    # re-fetch fails. It must surface in pages_failed with the load-timeout
    # reason, never as listing_ended_early or a complete run.
    server = ScriptedServer({
        1: [_full_page(1)],
        2: [_empty_page(2)],
        3: [_full_page(3)],
        4: [_full_page(4)],
    })
    original_fetch = eng._fetch_one_page
    page2_calls = {"n": 0}

    def fetch_with_second_attempt_failure(session, args_, pool, page_num, url):
        outcome = original_fetch(session, args_, pool, page_num, url)
        if page_num == 2:
            page2_calls["n"] += 1
            if page2_calls["n"] >= 2:
                outcome.load_failed = True
                outcome.products = []
        return outcome

    monkeypatch.setattr(eng, "sync_playwright",
                        lambda: FakePlaywright(server))
    monkeypatch.setattr(eng, "_BrowserSession",
                        lambda pw, args_, pool, remote=False:
                        FakeSession(server, pool).open())
    monkeypatch.setattr(eng, "proxy_pool_from_args", lambda args_: None)
    monkeypatch.setattr(eng, "handle_captcha_if_present",
                        lambda page, args_, budget: False)
    monkeypatch.setattr(eng, "_fetch_one_page", fetch_with_second_attempt_failure)

    args = _make_args(tmp_path, 4, 3)
    rc = eng.scrape(args)
    with open(args.out + ".meta.json", encoding="utf-8") as fh:
        meta = json.load(fh)

    assert rc == 6
    assert meta["status"] == "partial"
    assert meta["stop_reason"] == "page_load_timeout"
    assert 2 in meta["pages_failed"]
    assert meta.get("pages_early_empty") in (None, [])


# ---------------------------------------------------------------------------
# The shared predicate underpinning the recheck decision.
# ---------------------------------------------------------------------------
def test_empty_page_is_early_predicate():
    assert page_flow.empty_page_is_early(5, 2) is True
    assert page_flow.empty_page_is_early(5, 5) is True
    assert page_flow.empty_page_is_early(5, 6) is False
    assert page_flow.empty_page_is_early(None, 2) is False
    assert page_flow.empty_page_is_early(1, 1) is False
    assert page_flow.empty_page_is_early(1, 2) is False


def test_would_recheck_uses_run_ordinal_vs_site_page():
    # A run starting on site page 4 names its 2nd fetched page as site page 5.
    class _O:
        ok = True
        products = []

    class _A:
        url = CATEGORY_URL + "?page=4"

    # site page 5 of a 5-page listing is inside the stated size -> recheck.
    assert page_flow.would_recheck_early_empty(_A(), 2, _O(), 5) is True
    # ...site page 6 is past it -> no recheck.
    assert page_flow.would_recheck_early_empty(_A(), 3, _O(), 5) is False
    # A page with rows never rechecks.
    _O.products = ["row"]
    assert page_flow.would_recheck_early_empty(_A(), 2, _O(), 5) is False


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
