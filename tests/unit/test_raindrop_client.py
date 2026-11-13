"""raindrop_client.py のテスト。respx で Raindrop API をスタブする。"""

import json

import httpx
import pytest
import respx

from src.config import Config
from src.raindrop_client import API_BASE, InterruptionReason, RaindropClient

COLLECTION_ID = 123


def _raw_item(rid: int) -> dict:
    return {
        "_id": rid,
        "title": f"記事 {rid}",
        "link": f"https://example.com/{rid}",
        "domain": "example.com",
        "created": "2026-01-01T00:00:00Z",
        "collection": {"$id": 100},
    }


def _page(*ids: int) -> httpx.Response:
    return httpx.Response(200, json={"result": True, "items": [_raw_item(i) for i in ids]})


@pytest.fixture
def client(tmp_path):
    config = Config(
        raindrop_token="test-token",
        raindrop_collection_id=COLLECTION_ID,
        data_dir=str(tmp_path),
    )
    c = RaindropClient(config)
    yield c
    c.close()


def _read_saved_raw(client: RaindropClient) -> list[dict]:
    path = f"{client.config.data_dir}/raw/latest_raindrops.json"
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class TestFetchAndSave:
    @respx.mock
    def test_two_pages_with_duplicate_ids(self, client):
        """2 ページにまたがる重複 _id は排除され、正常終了時の中断理由は None。"""
        route = respx.get(f"{API_BASE}/raindrops/{COLLECTION_ID}")
        route.mock(side_effect=[_page(1, 2, 3), _page(3, 4), _page()])

        items = client.fetch_and_save()

        assert [i.raindrop_id for i in items] == [1, 2, 3, 4]

        report = client.last_report
        assert report is not None
        assert report.pages_requested == 3
        assert report.page_counts == [3, 2, 0]
        assert report.unique_count == 4
        assert report.duplicates_dropped == 1
        assert report.interruption is None

        # 落盘 JSON は返却件数と一致し、重複を含まない
        saved = _read_saved_raw(client)
        assert len(saved) == len(items)
        assert [s["_id"] for s in saved] == [1, 2, 3, 4]

    @respx.mock
    def test_second_page_429_keeps_first_page_items(self, client):
        """2 ページ目が 429 で中断しても 1 ページ目の取得分は保持・保存される。"""
        route = respx.get(f"{API_BASE}/raindrops/{COLLECTION_ID}")
        route.mock(side_effect=[_page(1, 2), httpx.Response(429)])

        items = client.fetch_and_save()

        assert [i.raindrop_id for i in items] == [1, 2]

        report = client.last_report
        assert report is not None
        assert report.pages_requested == 2
        assert report.page_counts == [2]
        assert report.unique_count == 2
        assert report.duplicates_dropped == 0
        assert report.interruption == InterruptionReason.rate_limited

        saved = _read_saved_raw(client)
        assert len(saved) == len(items)
        assert [s["_id"] for s in saved] == [1, 2]

    @respx.mock
    def test_duplicates_within_single_page(self, client):
        """同一ページ内の重複 _id は 1 件だけ残る。"""
        route = respx.get(f"{API_BASE}/raindrops/{COLLECTION_ID}")
        route.mock(side_effect=[_page(1, 1, 1), _page()])

        items = client.fetch_and_save()

        assert [i.raindrop_id for i in items] == [1]

        report = client.last_report
        assert report is not None
        assert report.page_counts == [3, 0]
        assert report.unique_count == 1
        assert report.duplicates_dropped == 2
        assert report.interruption is None

        saved = _read_saved_raw(client)
        assert len(saved) == len(items) == 1
