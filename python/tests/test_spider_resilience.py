"""Unit tests for client-side 429 retries and stream error reporting.

All responses here are mocks; nothing touches the real network.
"""

from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest
import requests

from spider.spider import (
    RateLimitExhaustedError,
    Spider,
    StreamResult,
)

URL = "http://example.com"


@pytest.fixture
def spider():
    return Spider(api_key="test_api_key", max_rate_limit_retries=2)


@pytest.fixture
def url():
    return URL


@pytest.fixture
def params():
    return {"limit": 1, "return_format": "markdown"}


def _response(status_code=200, headers=None, payload=None):
    response = MagicMock()
    response.status_code = status_code
    response.headers = headers or {}
    response.json.return_value = payload if payload is not None else [{"ok": True}]
    return response


def _rate_limited(headers=None):
    return _response(429, headers if headers is not None else {"Retry-After": "1"})


def _jsonl_response(raw_data: bytes):
    response = MagicMock()
    response.status_code = 200
    response.raw = BytesIO(raw_data)
    return response


# ---------------------------------------------------------------------------
# 429 handling
# ---------------------------------------------------------------------------


@patch.object(Spider, "_post_request")
@patch("spider.spider.time.sleep")
def test_api_post_retries_after_429_then_succeeds(mock_sleep, mock_post, spider, url, params):
    mock_post.side_effect = [_rate_limited({"Retry-After": "2"}), _response(200)]

    response = spider.api_post("crawl", {"url": url})

    assert response == [{"ok": True}]
    assert mock_post.call_count == 2
    mock_sleep.assert_called_once_with(2.0)


@patch.object(Spider, "_get_request")
@patch("spider.spider.time.sleep")
def test_api_get_retries_after_429_defaults_to_one_second(mock_sleep, mock_get, spider):
    # No Retry-After header at all -> default 1 second.
    mock_get.side_effect = [_rate_limited({}), _response(200, payload={"data": []})]

    response = spider.api_get("data/credits")

    assert response == {"data": []}
    assert mock_get.call_count == 2
    mock_sleep.assert_called_once_with(1.0)


@patch.object(Spider, "_post_request")
@patch("spider.spider.time.sleep")
def test_429_retries_update_rate_limit_state(mock_sleep, mock_post, spider):
    mock_post.side_effect = [
        _rate_limited(
            {
                "Retry-After": "1",
                "RateLimit-Limit": "10",
                "RateLimit-Remaining": "0",
                "RateLimit-Reset": "60",
            }
        ),
        _response(200),
    ]

    spider.api_post("crawl", {"url": URL})

    assert spider.rate_limit.limit == 10
    assert spider.rate_limit.remaining == 0
    assert spider.rate_limit.reset_seconds == 60


@patch.object(Spider, "_get_request")
@patch("spider.spider.time.sleep")
def test_retry_after_http_date_is_parsed(mock_sleep, mock_get, spider):
    future = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=20))
    mock_get.side_effect = [_rate_limited({"Retry-After": future}), _response(200)]

    spider.api_get("data/credits")

    wait = mock_sleep.call_args[0][0]
    assert 15 <= wait <= 20


@patch.object(Spider, "_post_request")
@patch("spider.spider.time.sleep")
def test_429_retry_exhaustion_raises_identifiable_error(mock_sleep, mock_post, spider, url):
    # max_rate_limit_retries = 2 => 1 initial attempt + 2 retries = 3 attempts.
    mock_post.return_value = _rate_limited({"Retry-After": "3"})

    with pytest.raises(RateLimitExhaustedError) as exc_info:
        spider.api_post("crawl", {"url": url})

    err = exc_info.value
    assert err.endpoint == "crawl"
    assert err.attempts == 3
    assert err.last_retry_after == 3.0
    assert err.status_code == 429
    assert "crawl" in str(err)
    # The two retries slept, the would-be third was reported instead of slept.
    assert mock_sleep.call_count == 2
    assert mock_post.call_count == 3
    # Still a RequestException subclass, for callers already catching that.
    assert isinstance(err, requests.exceptions.RequestException)


@patch.object(Spider, "_get_request")
@patch("spider.spider.time.sleep")
def test_429_exhaustion_on_api_get_reports_last_wait(mock_sleep, mock_get, spider):
    mock_get.side_effect = [
        _rate_limited({"Retry-After": "5"}),
        _rate_limited({"Retry-After": "7"}),
        _rate_limited({}),  # missing header -> 1s default on the final wait
    ]

    with pytest.raises(RateLimitExhaustedError) as exc_info:
        spider.api_get("data/credits")

    err = exc_info.value
    assert err.endpoint == "data/credits"
    assert err.attempts == 3
    assert err.last_retry_after == 1.0
    assert mock_get.call_count == 3


@patch.object(Spider, "_post_request")
@patch("spider.spider.time.sleep")
def test_rate_limit_exhausted_error_is_not_retried_by_tenacity(mock_sleep, mock_post, spider):
    """Tenacity's outer retry must not mask or multiply the 429 error."""
    mock_post.return_value = _rate_limited({"Retry-After": "1"})

    with pytest.raises(RateLimitExhaustedError):
        spider.api_post("crawl", {"url": URL})

    # If tenacity retried the RateLimitExhaustedError too, _post_request
    # would be called 3 * 5 times = 15.
    assert mock_post.call_count == 3


@patch.object(Spider, "_post_request")
@patch("spider.spider.time.sleep")
def test_non_429_error_keeps_handle_error_behavior(mock_sleep, mock_post, spider):
    with patch.object(Spider, "_handle_error") as mock_handle_error:
        mock_post.return_value = _response(500, payload={"error": "boom"})

        spider.api_post("crawl", {"url": URL})

    mock_handle_error.assert_called_once()
    args = mock_handle_error.call_args[0]
    assert args[1] == "post to crawl"
    assert mock_post.call_count == 1
    assert not mock_sleep.called


@patch.object(Spider, "_post_request")
@patch("spider.spider.time.sleep")
def test_non_429_status_raises_via_handle_error(mock_sleep, mock_post, spider):
    mock_post.return_value = _response(500, payload={"error": "boom"})

    with pytest.raises(Exception, match="Failed to post to crawl. Status code: 500. Error: boom"):
        spider.api_post("crawl", {"url": URL})

    assert mock_post.call_count == 1
    assert not mock_sleep.called


# ---------------------------------------------------------------------------
# Stream handling
# ---------------------------------------------------------------------------


def test_stream_reader_continues_after_bad_json_line(spider):
    raw = b'{"item": 1}\n{not valid json}\n{"item": 2}\n'
    seen = []

    result = spider.stream_reader(_jsonl_response(raw), seen.append)

    assert seen == [{"item": 1}, {"item": 2}]
    assert isinstance(result, StreamResult)
    assert result.processed == 2
    assert result.failed == 1
    assert result.total == 3
    assert result.ok is False
    assert "JSON parse error" in result.error_summary


def test_stream_reader_records_callback_exception_and_continues(spider):
    raw = b'{"item": 1}\n{"item": 2}\n{"item": 3}\n'
    seen = []

    def callback(item):
        seen.append(item)
        if item["item"] == 2:
            raise ValueError("callback exploded")

    result = spider.stream_reader(_jsonl_response(raw), callback)

    # The failing item was read and its callback invoked; later items still arrive.
    assert seen == [{"item": 1}, {"item": 2}, {"item": 3}]
    assert result.processed == 2
    assert result.failed == 1
    assert "ValueError" in result.error_summary
    assert "callback exploded" in result.error_summary


def test_stream_reader_clean_stream_reports_no_failures(spider):
    raw = b'{"item": 1}\n{"item": 2}\n'
    seen = []

    result = spider.stream_reader(_jsonl_response(raw), seen.append)

    assert seen == [{"item": 1}, {"item": 2}]
    assert result.processed == 2
    assert result.failed == 0
    assert result.ok is True
    assert result.error_summary == ""


@patch.object(Spider, "_post_request")
@patch("spider.spider.time.sleep")
def test_crawl_url_stream_returns_stream_result(mock_sleep, mock_post, spider, url, params):
    raw = b'{"url": "a"}\nbroken\n{"url": "b"}\n'
    mock_post.return_value = _jsonl_response(raw)
    seen = []

    result = spider.crawl_url(
        url, params, stream=True, callback=seen.append
    )

    assert seen == [{"url": "a"}, {"url": "b"}]
    assert isinstance(result, StreamResult)
    assert result.processed == 2
    assert result.failed == 1
    # The JSONL content type is used for the callback path.
    assert mock_post.call_args[0][2]["Content-Type"] == "application/jsonl"


@patch.object(Spider, "_post_request")
@patch("spider.spider.time.sleep")
def test_unlimited_crawl_stream_returns_stream_result(mock_sleep, mock_post, spider, url, params):
    raw = b'{"url": "a"}\n{"url": "b"}\n'
    mock_post.return_value = _jsonl_response(raw)
    seen = []

    result = spider.unlimited_crawl(
        url, params, stream=True, callback=seen.append
    )

    assert seen == [{"url": "a"}, {"url": "b"}]
    assert isinstance(result, StreamResult)
    assert result.processed == 2
    assert result.failed == 0
