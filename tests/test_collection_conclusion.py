"""Acceptance tests for resumable collection and collection conclusions.

These tests use a fully local fake client (no real Meta network access) and a
persistent SQLite :class:`DeduplicationTracker` to cover:

* the happy path -- full pagination yields a "completed" conclusion and records
  the last collection time in the dedup database;
* the ``max_results`` cut-off -- the conclusion reports the limit reason and
  the last collection time is *not* advanced;
* resumption -- a second run with the same query skips already-seen ads and
  counts them in ``duplicates_skipped``;
* abnormal endings -- repeated cursors and >25 consecutive empty pages raise
  :class:`MetaAdsError` with distinguishable end reasons;
* request errors -- a failing client yields the request-error reason.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from meta_ads_collector import (
    END_REASON_COMPLETED,
    END_REASON_DUPLICATE_CURSOR,
    END_REASON_EMPTY_PAGES_LIMIT,
    END_REASON_MAX_RESULTS,
    END_REASON_REQUEST_ERROR,
    CollectionConclusion,
    DeduplicationTracker,
    MetaAdsError,
)
from meta_ads_collector.async_collector import AsyncMetaAdsCollector
from meta_ads_collector.collector import MetaAdsCollector
from meta_ads_collector.events import EventEmitter

# ---------------------------------------------------------------------------
# Local fakes -- never touch the network
# ---------------------------------------------------------------------------

def _page(ad_ids: list[str] | None = None, cursor: str | None = None) -> tuple[dict, str | None]:
    """Build a fake ``(response, next_cursor)`` pair for ``search_ads``."""
    ads = [{"ad_archive_id": ad_id} for ad_id in (ad_ids or [])]
    return {"ads": ads, "page_info": {}}, cursor


def _sync_collector(responses: list[tuple[dict, str | None]]) -> MetaAdsCollector:
    collector = MetaAdsCollector.__new__(MetaAdsCollector)
    collector.client = MagicMock()
    collector.client.search_ads.side_effect = list(responses)
    collector.rate_limit_delay = 0
    collector.jitter = 0
    collector.event_emitter = EventEmitter()
    collector.stats = {
        "requests_made": 0,
        "ads_collected": 0,
        "duplicates_skipped": 0,
        "filtered_out": 0,
        "pages_fetched": 0,
        "errors": 0,
        "start_time": None,
        "end_time": None,
    }
    collector.collection_conclusion = None
    return collector


class _AsyncFake:
    """Async stand-in for ``AsyncMetaAdsClient.search_ads``."""

    def __init__(self, responses: list[tuple[dict, str | None]]) -> None:
        self._responses = list(responses)
        self.calls = 0

    async def __call__(self, **kwargs: Any) -> tuple[dict, str | None]:
        index = min(self.calls, len(self._responses) - 1)
        self.calls += 1
        return self._responses[index]


def _async_collector(responses: list[tuple[dict, str | None]]) -> AsyncMetaAdsCollector:
    collector = AsyncMetaAdsCollector.__new__(AsyncMetaAdsCollector)
    collector.client = MagicMock()
    collector.client.search_ads = _AsyncFake(responses)
    collector.rate_limit_delay = 0
    collector.jitter = 0
    collector.event_emitter = EventEmitter()
    collector.stats = {
        "requests_made": 0,
        "ads_collected": 0,
        "duplicates_skipped": 0,
        "filtered_out": 0,
        "pages_fetched": 0,
        "errors": 0,
        "start_time": None,
        "end_time": None,
    }
    collector.collection_conclusion = None
    return collector


def _drain_sync(collector: MetaAdsCollector, **kwargs: Any):
    return list(collector.search(**kwargs))


async def _drain_async(collector: AsyncMetaAdsCollector, **kwargs: Any):
    return [ad async for ad in collector.search(**kwargs)]


async def _drain(collector: Any, async_mode: bool, **kwargs: Any):
    if async_mode:
        return await _drain_async(collector, **kwargs)
    return _drain_sync(collector, **kwargs)


# Two-page response sequence: page 1 -> cursor "c1", page 2 -> terminal.
TWO_PAGES = [
    _page(["ad-1", "ad-2"], cursor="c1"),
    _page(["ad-3", "ad-4"], cursor=None),
]


# ---------------------------------------------------------------------------
# Happy path: full pagination
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("async_mode", [False, True], ids=["sync", "async"])
async def test_full_pagination_completes_and_records_run_time(
    async_mode: bool, tmp_path
) -> None:
    db_path = str(tmp_path / "state.db")
    tracker = DeduplicationTracker(mode="persistent", db_path=db_path)

    collector = _async_collector(TWO_PAGES) if async_mode else _sync_collector(TWO_PAGES)

    ads = await _drain(collector, async_mode, query="same-query", dedup_tracker=tracker)

    assert [ad.id for ad in ads] == ["ad-1", "ad-2", "ad-3", "ad-4"]

    conclusion = collector.get_collection_conclusion()
    assert isinstance(conclusion, CollectionConclusion)
    assert conclusion.ads_collected == 4
    assert conclusion.duplicates_skipped == 0
    assert conclusion.filtered_out == 0
    assert conclusion.pages_fetched == 2
    assert conclusion.completed is True
    assert conclusion.end_reason == END_REASON_COMPLETED
    assert conclusion.end_reason_label == "完整结束"
    assert conclusion.is_abnormal is False

    # The completed run must advance the last collection time in SQLite.
    tracker.save()
    assert tracker.get_last_collection_time() is not None
    assert tracker.count() == 4
    tracker.close()

    # Reopening the database must show the same persisted state.
    reopened = DeduplicationTracker(mode="persistent", db_path=db_path)
    assert reopened.count() == 4
    assert reopened.get_last_collection_time() is not None
    reopened.close()


# ---------------------------------------------------------------------------
# max_results cut-off: not a complete run
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("async_mode", [False, True], ids=["sync", "async"])
async def test_max_results_cutoff_does_not_advance_run_time(
    async_mode: bool, tmp_path
) -> None:
    db_path = str(tmp_path / "state.db")
    tracker = DeduplicationTracker(mode="persistent", db_path=db_path)

    # Three pages remain available; we stop after 2 ads while a cursor exists.
    responses = [
        _page(["ad-1", "ad-2"], cursor="c1"),
        _page(["ad-3"], cursor="c2"),
        _page(["ad-4"], cursor=None),
    ]
    collector = _async_collector(responses) if async_mode else _sync_collector(responses)

    ads = await _drain(
        collector, async_mode, query="same-query", max_results=2,
        dedup_tracker=tracker,
    )

    assert [ad.id for ad in ads] == ["ad-1", "ad-2"]

    conclusion = collector.get_collection_conclusion()
    assert conclusion.ads_collected == 2
    assert conclusion.completed is False
    assert conclusion.end_reason == END_REASON_MAX_RESULTS
    assert conclusion.end_reason_label == "达到上限"

    # A truncated run must not be recorded as a complete collection.
    tracker.save()
    assert tracker.get_last_collection_time() is None
    # Seen ads are still persisted, enabling a later resume.
    assert tracker.count() == 2
    tracker.close()

    reopened = DeduplicationTracker(mode="persistent", db_path=db_path)
    assert reopened.get_last_collection_time() is None
    reopened.close()


# ---------------------------------------------------------------------------
# Resumption: second run with the same query skips seen ads
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("async_mode", [False, True], ids=["sync", "async"])
async def test_second_run_skips_persisted_duplicates(
    async_mode: bool, tmp_path
) -> None:
    db_path = str(tmp_path / "state.db")

    # First run: full pagination, completes.
    tracker1 = DeduplicationTracker(mode="persistent", db_path=db_path)
    collector1 = _async_collector(TWO_PAGES) if async_mode else _sync_collector(TWO_PAGES)
    first_ads = await _drain(
        collector1, async_mode, query="same-query", dedup_tracker=tracker1
    )
    assert len(first_ads) == 4
    assert collector1.get_collection_conclusion().end_reason == END_REASON_COMPLETED
    tracker1.save()
    tracker1.close()

    # Second run with the *same* query: the fake returns the same ads again.
    tracker2 = DeduplicationTracker(mode="persistent", db_path=db_path)
    collector2 = _async_collector(TWO_PAGES) if async_mode else _sync_collector(TWO_PAGES)
    second_ads = await _drain(
        collector2, async_mode, query="same-query", dedup_tracker=tracker2
    )

    assert second_ads == []  # nothing new produced
    conclusion = collector2.get_collection_conclusion()
    assert conclusion.ads_collected == 0
    assert conclusion.duplicates_skipped == 4
    assert conclusion.pages_fetched == 2
    assert conclusion.completed is True
    assert conclusion.end_reason == END_REASON_COMPLETED
    tracker2.close()


async def test_resume_after_truncated_run_collects_only_new_ads(tmp_path) -> None:
    """Sync path: an interrupted (limit) run resumes and only yields new ads."""
    db_path = str(tmp_path / "state.db")

    tracker = DeduplicationTracker(mode="persistent", db_path=db_path)
    first = _sync_collector([
        _page(["ad-1", "ad-2"], cursor="c1"),
        _page(["ad-3"], cursor="c2"),
    ])
    ads = _drain_sync(first, query="q", max_results=2, dedup_tracker=tracker)
    assert [a.id for a in ads] == ["ad-1", "ad-2"]
    assert first.get_collection_conclusion().end_reason == END_REASON_MAX_RESULTS
    tracker.save()

    # Resume: page 1 repeats the two known ads, page 2 brings a new one.
    resumed = _sync_collector([
        _page(["ad-1", "ad-2"], cursor="c1"),
        _page(["ad-3"], cursor=None),
    ])
    ads = _drain_sync(resumed, query="q", dedup_tracker=tracker)
    assert [a.id for a in ads] == ["ad-3"]
    conclusion = resumed.get_collection_conclusion()
    assert conclusion.ads_collected == 1
    assert conclusion.duplicates_skipped == 2
    assert conclusion.completed is True
    assert conclusion.end_reason == END_REASON_COMPLETED
    tracker.close()


# ---------------------------------------------------------------------------
# Abnormal ending: repeated pagination cursor
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("async_mode", [False, True], ids=["sync", "async"])
async def test_repeated_cursor_raises_with_distinguishable_reason(async_mode: bool) -> None:
    responses = [
        _page(["ad-1"], cursor="same-cursor"),
        _page(["ad-2"], cursor="same-cursor"),
        _page([], cursor=None),
    ]
    collector = _async_collector(responses) if async_mode else _sync_collector(responses)
    tracker = DeduplicationTracker(mode="memory")

    with pytest.raises(MetaAdsError, match="Repeated pagination cursor"):
        await _drain(collector, async_mode, query="q", dedup_tracker=tracker)

    conclusion = collector.get_collection_conclusion()
    assert conclusion.completed is False
    assert conclusion.end_reason == END_REASON_DUPLICATE_CURSOR
    assert conclusion.end_reason_label == "重复游标"
    assert conclusion.is_abnormal is True
    assert tracker.get_last_collection_time() is None


# ---------------------------------------------------------------------------
# Abnormal ending: more than 25 consecutive empty pages
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("async_mode", [False, True], ids=["sync", "async"])
async def test_more_than_25_empty_pages_raises_with_reason(async_mode: bool) -> None:
    # 26 empty pages, each with a distinct cursor so the cursor guard never
    # fires first.
    responses = [
        _page([], cursor=f"empty-cursor-{index}") for index in range(26)
    ]
    collector = _async_collector(responses) if async_mode else _sync_collector(responses)
    tracker = DeduplicationTracker(mode="memory")

    with pytest.raises(MetaAdsError, match="25 consecutive empty pages"):
        await _drain(collector, async_mode, query="q", dedup_tracker=tracker)

    conclusion = collector.get_collection_conclusion()
    assert conclusion.completed is False
    assert conclusion.end_reason == END_REASON_EMPTY_PAGES_LIMIT
    assert conclusion.end_reason_label == "连续空页超限"
    assert conclusion.is_abnormal is True
    assert conclusion.pages_fetched == 26
    assert tracker.get_last_collection_time() is None


# ---------------------------------------------------------------------------
# Request error: client raises MetaAdsError
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("async_mode", [False, True], ids=["sync", "async"])
async def test_request_error_reason(async_mode: bool) -> None:
    collector = _sync_collector([]) if not async_mode else _async_collector([])
    request_error = MetaAdsError("boom: transport failure")
    if async_mode:
        async def _raise(**_kwargs: Any):
            raise request_error
        collector.client.search_ads = _raise
    else:
        collector.client.search_ads.side_effect = request_error

    tracker = DeduplicationTracker(mode="memory")

    with pytest.raises(MetaAdsError, match="boom"):
        await _drain(collector, async_mode, query="q", dedup_tracker=tracker)

    conclusion = collector.get_collection_conclusion()
    assert conclusion.completed is False
    assert conclusion.end_reason == END_REASON_REQUEST_ERROR
    assert conclusion.end_reason_label == "请求错误"
    assert conclusion.is_abnormal is False  # request errors are not the cycle guards
    assert tracker.get_last_collection_time() is None


# ---------------------------------------------------------------------------
# Conclusion shape and to_dict() serialisation
# ---------------------------------------------------------------------------

async def test_conclusion_to_dict_is_serialisable() -> None:
    import json

    collector = _sync_collector(TWO_PAGES)
    _drain_sync(collector, query="q")
    conclusion = collector.get_collection_conclusion()

    payload = conclusion.to_dict()
    assert payload == {
        "ads_collected": 4,
        "duplicates_skipped": 0,
        "filtered_out": 0,
        "pages_fetched": 2,
        "completed": True,
        "end_reason": END_REASON_COMPLETED,
        "errors": 0,
        "requests_made": 2,
        "end_reason_label": "完整结束",
    }
    # Must be JSON-serialisable so callers can persist/export it.
    json.dumps(payload, ensure_ascii=False)


def test_conclusion_none_before_any_search() -> None:
    collector = _sync_collector([])
    assert collector.get_collection_conclusion() is None
    assert collector.get_last_collection_conclusion() is None
