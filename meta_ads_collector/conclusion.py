"""Queryable collection conclusions for Meta Ad Library collection runs.

A :class:`CollectionConclusion` is the verifiable outcome of a single
:meth:`~meta_ads_collector.collector.MetaAdsCollector.search` run.  Unlike the
raw ad count, it records how many ads were produced, how many were skipped as
duplicates, how many were removed by filters, how many pages were requested,
whether pagination was exhausted, and *why* the run ended.

End-reason constants
--------------------

* :data:`END_REASON_COMPLETED` -- every pagination page was consumed normally.
* :data:`END_REASON_MAX_RESULTS` -- the run stopped because ``max_results``
  was reached while more pages were available.
* :data:`END_REASON_DUPLICATE_CURSOR` -- a pagination cursor repeated, which
  indicates a response cycle.  An abnormal ending that raises
  :class:`~meta_ads_collector.exceptions.MetaAdsError`.
* :data:`END_REASON_EMPTY_PAGES_LIMIT` -- more than 25 consecutive empty
  pages were returned.  An abnormal ending that raises
  :class:`~meta_ads_collector.exceptions.MetaAdsError`.
* :data:`END_REASON_REQUEST_ERROR` -- the run aborted because a request
  failed (transport error, exhausted rate-limit/session retries, an error
  payload in the response, ...).

Only :data:`END_REASON_COMPLETED` marks a run as complete
(:attr:`CollectionConclusion.completed` is ``True``); every other reason is an
incomplete ending, so the persistent deduplication tracker must not advance
its last-collection time and the same query can be resumed later.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

# End-reason identifiers (stable, machine-readable values).
END_REASON_COMPLETED = "completed"
END_REASON_MAX_RESULTS = "max_results_reached"
END_REASON_DUPLICATE_CURSOR = "duplicate_cursor"
END_REASON_EMPTY_PAGES_LIMIT = "empty_pages_limit"
END_REASON_REQUEST_ERROR = "request_error"

# Human-readable Chinese labels, keyed by the identifiers above.  These are
# convenience labels for callers that render the conclusion directly.
END_REASON_LABELS: dict[str, str] = {
    END_REASON_COMPLETED: "完整结束",
    END_REASON_MAX_RESULTS: "达到上限",
    END_REASON_DUPLICATE_CURSOR: "重复游标",
    END_REASON_EMPTY_PAGES_LIMIT: "连续空页超限",
    END_REASON_REQUEST_ERROR: "请求错误",
}

# Abnormal endings that must be surfaced as MetaAdsError.
ABNORMAL_END_REASONS = frozenset(
    {
        END_REASON_DUPLICATE_CURSOR,
        END_REASON_EMPTY_PAGES_LIMIT,
    }
)

# All known end-reason identifiers.
ALL_END_REASONS = frozenset(
    {
        END_REASON_COMPLETED,
        END_REASON_MAX_RESULTS,
        END_REASON_DUPLICATE_CURSOR,
        END_REASON_EMPTY_PAGES_LIMIT,
        END_REASON_REQUEST_ERROR,
    }
)


@dataclass
class CollectionConclusion:
    """Verifiable outcome of a single collection run.

    Attributes:
        ads_collected: Number of ads produced (yielded) by this run.
        duplicates_skipped: Number of ads skipped because the deduplication
            tracker had already recorded them.
        filtered_out: Number of ads removed by client-side filters.
        pages_fetched: Number of successfully fetched response pages.
        completed: ``True`` only when pagination was exhausted normally.
            ``False`` for limit cut-offs, abnormal endings, and errors.
        end_reason: One of the ``END_REASON_*`` constants describing why
            the run ended.
        end_reason_label: Human-readable label for :attr:`end_reason`.
        errors: Number of errors counted during the run.
        requests_made: Number of API requests attempted, including retries.
    """

    ads_collected: int = 0
    duplicates_skipped: int = 0
    filtered_out: int = 0
    pages_fetched: int = 0
    completed: bool = False
    end_reason: str = END_REASON_REQUEST_ERROR
    errors: int = 0
    requests_made: int = 0

    @property
    def end_reason_label(self) -> str:
        """Human-readable label for the current :attr:`end_reason`."""
        return END_REASON_LABELS.get(self.end_reason, self.end_reason)

    @property
    def is_abnormal(self) -> bool:
        """``True`` when the ending must be raised as a :class:`MetaAdsError`."""
        return self.end_reason in ABNORMAL_END_REASONS

    def to_dict(self) -> dict[str, Any]:
        """Return a plain, JSON-serialisable representation.

        The mapping includes both the machine-readable ``end_reason`` and
        the human-readable ``end_reason_label``.
        """
        data = asdict(self)
        data["end_reason_label"] = self.end_reason_label
        return data
