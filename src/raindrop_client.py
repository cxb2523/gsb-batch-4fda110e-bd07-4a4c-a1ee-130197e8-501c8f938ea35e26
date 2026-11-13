"""Raindrop.io API クライアント。"""

import json
import logging
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

import httpx

from src.config import Config
from src.models import RaindropItem

logger = logging.getLogger("raindrop_summarizer")

API_BASE = "https://api.raindrop.io/rest/v1"


class InterruptionReason(str, Enum):
    """ページネーションが途中で打ち切られた理由。正常終了時は None。"""

    auth_failed = "auth_failed"  # 401: トークン無効
    rate_limited = "rate_limited"  # 429: レートリミット
    server_error = "server_error"  # 5xx
    network_error = "network_error"  # 接続失敗・タイムアウト等
    json_parse_error = "json_parse_error"  # レスポンスが JSON として解釈できない
    unexpected_status = "unexpected_status"  # 上記以外の非 200 ステータス


@dataclass
class FetchReport:
    """1 回の取得ラウンドの結果サマリー。取得のたびに検証可能な形で残す。"""

    pages_requested: int = 0  # リクエストを投げたページ数（失敗したページも含む）
    page_counts: list[int] = field(default_factory=list)  # 正常にパースできた各ページの件数
    unique_count: int = 0  # _id 重複排除後の件数
    duplicates_dropped: int = 0  # 重複として捨てた件数
    interruption: InterruptionReason | None = None  # 中断理由。正常終了時は None


class RaindropClient:
    """Raindrop.io API からコレクションの記事を取得する。"""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.client = httpx.Client(
            headers={"Authorization": f"Bearer {config.raindrop_token}"},
            timeout=config.request_timeout_seconds,
        )
        # 直近の取得ラウンドのレポート（fetch 系メソッド呼び出し後に参照できる）
        self.last_report: FetchReport | None = None

    def _fetch_raw(self) -> tuple[list[dict], FetchReport]:
        """全ページを取得し、_id で重複排除した生データと FetchReport を返す。

        途中で中断しても、それまでに取得できた分はそのまま返す。
        """
        collection_id = self.config.raindrop_collection_id
        report = FetchReport()
        seen_ids: set = set()
        unique_items: list[dict] = []
        page = 0

        logger.info(f"Raindrop API: コレクション {collection_id} を取得開始")

        while True:
            url = f"{API_BASE}/raindrops/{collection_id}"
            params = {"perpage": 50, "sort": "-created", "page": page}
            report.pages_requested += 1

            try:
                response = self.client.get(url, params=params)
            except httpx.RequestError as e:
                logger.error(f"ネットワークエラー: {e}")
                report.interruption = InterruptionReason.network_error
                break

            if response.status_code == 401:
                logger.error("認証エラー: RAINDROP_TOKEN が無効です")
                report.interruption = InterruptionReason.auth_failed
                break
            if response.status_code == 429:
                logger.error("レートリミット超過")
                report.interruption = InterruptionReason.rate_limited
                break
            if response.status_code >= 500:
                logger.error(f"サーバーエラー: {response.status_code}")
                report.interruption = InterruptionReason.server_error
                break
            if response.status_code != 200:
                logger.error(f"予期しないステータスコード: {response.status_code}")
                report.interruption = InterruptionReason.unexpected_status
                break

            try:
                data = response.json()
            except ValueError:
                logger.error("Raindrop API: JSON パースエラー")
                report.interruption = InterruptionReason.json_parse_error
                break

            items = data.get("items", [])
            report.page_counts.append(len(items))

            if not items:
                break

            for item in items:
                item_id = item.get("_id")
                if item_id is not None and item_id in seen_ids:
                    report.duplicates_dropped += 1
                    continue
                if item_id is not None:
                    seen_ids.add(item_id)
                unique_items.append(item)

            logger.debug(f"ページ {page}: {len(items)} 件取得")
            page += 1

        report.unique_count = len(unique_items)
        logger.info(
            "Raindrop API: 取得終了 — "
            f"ページ数: {report.pages_requested}, "
            f"ページ毎件数: {report.page_counts}, "
            f"ユニーク: {report.unique_count} 件, "
            f"重複破棄: {report.duplicates_dropped} 件, "
            f"中断理由: {report.interruption.value if report.interruption else 'なし'}"
        )
        return unique_items, report

    def fetch_collection(self) -> list[RaindropItem]:
        """コレクションの全記事を取得する。ページネーション・重複排除対応。"""
        raw_items, report = self._fetch_raw()
        self.last_report = report
        return [self._map_item(item) for item in raw_items]

    def save_raw(self, items: list[dict] | None = None) -> Path:
        """生データを data/raw/latest_raindrops.json に保存する。"""
        raw_dir = Path(self.config.data_dir) / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        path = raw_dir / "latest_raindrops.json"

        if items is None:
            # 取得から行う場合も重複排除済みの生データを保存する
            items, report = self._fetch_raw()
            self.last_report = report

        path.write_text(
            json.dumps(items, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        logger.info(f"生データを保存: {path} ({len(items)} 件)")
        return path

    def fetch_and_save(self) -> list[RaindropItem]:
        """取得と生データ保存を一度に行う。"""
        raw_items, report = self._fetch_raw()
        self.last_report = report

        # 重複排除済みの生データを保存（返却する RaindropItem と 1:1 で対応する）
        self.save_raw(raw_items)

        return [self._map_item(item) for item in raw_items]

    def close(self) -> None:
        """HTTP クライアントを閉じる。"""
        self.client.close()

    @staticmethod
    def _map_item(raw: dict) -> RaindropItem:
        """API レスポンスの 1 件を RaindropItem にマッピングする。"""
        collection = raw.get("collection", {})
        return RaindropItem(
            raindrop_id=raw["_id"],
            collection_id=collection.get("$id", 0),
            title=raw.get("title", ""),
            url=raw.get("link", ""),
            domain=raw.get("domain", ""),
            created_at=raw.get("created", ""),
            tags=raw.get("tags", []),
            excerpt=raw.get("excerpt", ""),
            type=raw.get("type", "link"),
            cover=raw.get("cover", ""),
            note=raw.get("note", ""),
        )
