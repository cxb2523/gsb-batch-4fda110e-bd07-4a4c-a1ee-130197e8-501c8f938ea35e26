# Deduplication Guide

`DeduplicationTracker` skips ad IDs already recorded by that tracker. It supports in-memory tracking for one process and persistent SQLite-backed tracking across runs. It does not deduplicate across separate database files or different tracker instances.

## In-memory mode

State lives in a Python `set`. Fast, but lost when the process exits.

```python
from meta_ads_collector import MetaAdsCollector, DeduplicationTracker

tracker = DeduplicationTracker(mode="memory")

with MetaAdsCollector() as collector:
    for ad in collector.search(query="test", dedup_tracker=tracker):
        print(ad.id)  # This ID is recorded before the ad is yielded.

print(f"Unique ads: {tracker.count()}")
```

## Persistent mode

State is stored in a SQLite database file. Survives across process restarts.

```python
from meta_ads_collector import MetaAdsCollector, DeduplicationTracker

tracker = DeduplicationTracker(mode="persistent", db_path="collection_state.db")

with MetaAdsCollector() as collector:
    for ad in collector.search(query="test", dedup_tracker=tracker):
        print(ad.id)  # Skips ads already recorded in any previous run
tracker.close()

# The search generator saves yielded ad IDs when it finishes or is closed. It advances the last-collection time only when the search reaches the end without parse errors or an unmet result limit. Closing early or stopping at a limit preserves yielded IDs but leaves the last-collection time unchanged.
```

The SQLite database contains two tables:
- `seen_ads` -- maps ad IDs to their first-seen timestamp
- `collection_runs` -- records the timestamp of each completed collection run

## Incremental collection

Combine persistent deduplication with date filtering to only collect new ads since the last run.

```python
from meta_ads_collector import MetaAdsCollector, DeduplicationTracker, FilterConfig

tracker = DeduplicationTracker(mode="persistent", db_path="state.db")
last_run = tracker.get_last_collection_time()

# Only fetch ads newer than the last collection
filters = FilterConfig(start_date=last_run) if last_run else None

with MetaAdsCollector() as collector:
    for ad in collector.search(query="crypto", filter_config=filters, dedup_tracker=tracker):
        print(ad.id)  # Replace with your application's processing code.
tracker.close()
```

## CLI usage

```bash
# In-memory deduplication (within a single run)
meta-ads-collector -q "test" --dedup -o ads.json

# Persistent deduplication (across runs)
meta-ads-collector -q "test" --state-file state.db -o ads.json

# Incremental: only collect ads since the last run
meta-ads-collector -q "test" --state-file state.db --since-last-run -o new_ads.jsonl
```

## API reference

### DeduplicationTracker

```python
from meta_ads_collector import DeduplicationTracker

memory_tracker = DeduplicationTracker(mode="memory")
persistent_tracker = DeduplicationTracker(mode="persistent", db_path="state.db")
```

| Method | Description |
|---|---|
| `has_seen(ad_id)` | Returns `True` if the ad ID was previously recorded |
| `mark_seen(ad_id, timestamp=None)` | Record an ad ID as seen |
| `get_last_collection_time()` | Returns the datetime of the most recent completed run, or `None` |
| `update_collection_time()` | Record the current time as the latest collection run |
| `save()` | Persist changes to disk (persistent mode only; no-op for memory) |
| `load()` | Load state from disk (persistent mode only; no-op for memory) |
| `count()` | Number of unique ad IDs tracked |
| `clear()` | Remove all tracked state |
| `close()` | Close the database connection (persistent mode) |

### Context manager

`DeduplicationTracker` supports `with` for automatic save and close:

```python
from meta_ads_collector import DeduplicationTracker

with DeduplicationTracker(mode="persistent", db_path="state.db") as tracker:
    tracker.mark_seen("12345")
    # Automatically saves and closes on exit
```

## Collection conclusions (resumable runs)

Every `search()` run records a verifiable
`CollectionConclusion`, available through
`collector.get_collection_conclusion()` (returns `None` before the first
run). It carries more than the final ad count:

| Field | Meaning |
|---|---|
| `ads_collected` | Ads produced (yielded) by this run |
| `duplicates_skipped` | Ads skipped because the tracker had already seen them |
| `filtered_out` | Ads removed by client-side filters |
| `pages_fetched` | Successfully fetched response pages |
| `completed` | `True` only when pagination was exhausted normally |
| `end_reason` | Machine-readable end reason (`END_REASON_*` constant) |
| `end_reason_label` | Human-readable label for the end reason |
| `errors` / `requests_made` | Error count and attempted requests (including retries) |

The five end reasons are:

| Constant | Label | Complete? |
|---|---|---|
| `END_REASON_COMPLETED` | 完整结束 | yes |
| `END_REASON_MAX_RESULTS` | 达到上限 | no |
| `END_REASON_DUPLICATE_CURSOR` | 重复游标 | no, raises `MetaAdsError` |
| `END_REASON_EMPTY_PAGES_LIMIT` | 连续空页超限 | no, raises `MetaAdsError` |
| `END_REASON_REQUEST_ERROR` | 请求错误 | no |

Only a `completed` run advances the `collection_runs` timestamp in the
SQLite state database. A run that stops at `max_results`, raises on a
repeated cursor or on more than 25 consecutive empty pages, or aborts on a
request error leaves the last-collection time untouched, so the same query
can be resumed later and already-seen ads are skipped automatically.

```python
from meta_ads_collector import (
    MetaAdsCollector, DeduplicationTracker,
    END_REASON_COMPLETED, END_REASON_MAX_RESULTS,
)

tracker = DeduplicationTracker(mode="persistent", db_path="state.db")
with MetaAdsCollector() as collector:
    ads = list(collector.search(query="crypto", dedup_tracker=tracker))

conclusion = collector.get_collection_conclusion()
print(conclusion.to_dict())
if conclusion.end_reason == END_REASON_MAX_RESULTS:
    print("Truncated by max_results; last-collection time was not advanced.")
tracker.close()
```
