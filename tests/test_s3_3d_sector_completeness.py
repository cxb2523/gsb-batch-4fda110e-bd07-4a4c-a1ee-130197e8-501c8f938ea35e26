# -*- coding: utf-8 -*-
"""S3-3D：板块采集完整性的专项离线验收。

全部离线：`EastmoneySectorProvider._get()` 被替换成脚本化的假响应
（按页码返回报文 / 抛异常 / 返回 `data:null`），不依赖真实网络。

验收规则（与 `services/data/providers/eastmoney_sector.py` 模块文档一一对应）：

  C01-C09  分页完整性
      - 多页合并 496/496 → complete
      - 中间页失败 → partial，继续抓后续页，missing_pages 记该页，已抓到的行保留
      - 首页 data=null → empty（0 行，不是 failed，也不能冒充"今天没有板块"）
      - 全部页失败 → 整体 failed，data 为 None（绝不返回空列表）
      - 跨页重复 → partial，duplicates 计数，行保留
      - 总数跨页漂移 → partial，记 total_mismatch
      - 页数上限截断 → partial，且能算出缺了哪几页
      - total 缺失 → partial（无法核对，不声称完整）
      - 连续重复页 → no_progress 停止，不空转

  N01-N08  解析层缺失语义
      - "-" / "" / None → 未知（None），不是 0
      - 真实 0 保留为 0.0
      - 不可解析数值（含 NaN/Inf）→ ProviderFormatError（不静默变 0）
      - 缺名称行跳过并计数，且不因此把整份判成 complete
      - 负 PE / PB 缺失分别计数留痕
      - asof 恒为空串（接口无时间戳，不拿 now() 顶替）

  R01-R03  结果保留链路
      - partial 的已抓行进入缓存/图表，不被校验器整份丢弃
      - flow=None 的热力图行不会让 build_heatmap_chart 抛错

  H01-H05  HTTP 层
      - 完整性结论、缺失页码与计数备注可从 X-Data-* 响应头读到
"""

import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from chart_builder import build_heatmap_chart                                  # noqa: E402
from data_service import _validate_sectors                                     # noqa: E402
from services.data.exceptions import (                                         # noqa: E402
    ProviderFormatError, ProviderNetworkError,
)
from services.data.providers.eastmoney_sector import (                         # noqa: E402
    EastmoneySectorProvider,
)

ESC = "eastmoney_sector"


def row(code, name=None, **fields):
    """一行 clist 报文；默认字段是"正常有值"的资金流/估值行。"""
    r = {"f12": code, "f14": f"板块{code}" if name is None else name,
         "f3": 1.0, "f62": 1e8}
    r.update(fields)
    return r


def payload(rows, total=None, has_total=True):
    data = {"diff": rows}
    if has_total:
        data["total"] = len(rows) if total is None else total
    return {"rc": 0, "data": data}


def rows_range(start, count):
    return [row(f"BK{i:04d}", f"板块{i}") for i in range(start, start + count)]


class ScriptedSector(EastmoneySectorProvider):
    """脚本化假响应：`{pn: payload | Exception | None}`。

    - payload dict → 该页报文
    - Exception    → 该页请求失败
    - None         → 越界页（data=null）
    - 缺省         → 同 None（越界页）
    """

    def __init__(self, pages):
        super().__init__()
        self.pages = pages
        self.calls = []

    def _get(self, params):
        pn = int(params["pn"])
        self.calls.append(pn)
        value = self.pages.get(pn)
        if isinstance(value, Exception):
            raise value
        if value is None:
            return {"rc": 0, "data": None}
        return value


def fetch(pages, mode="flow", **kwargs):
    return ScriptedSector(pages).fetch(mode=mode, **kwargs)


class TestPaginationCompleteness(unittest.TestCase):
    """C01-C08：抓了多少、总数多少、缺了哪些页、是否完整。"""

    def test_C01_multi_page_merge_is_complete(self):
        pages = {pn: payload(rows_range((pn - 1) * 100,
                                        100 if pn < 5 else 96), total=496)
                 for pn in range(1, 6)}
        res = fetch(pages)

        self.assertEqual(res.status, "success")
        self.assertEqual(res.extra["completeness"], "complete")
        self.assertEqual(res.extra["total"], 496)
        self.assertEqual(res.extra["fetched"], 496)
        self.assertEqual(res.extra["missing_pages"], [])
        self.assertEqual(res.extra["missing"], [])
        self.assertEqual(res.extra["duplicates"], 0)
        self.assertEqual(res.extra["total_mismatch"], 0)
        self.assertEqual(res.extra["expected_pages"], 5)
        self.assertEqual(res.extra["pages_fetched"], 5)
        self.assertEqual(res.extra["stopped"], "total_reached")
        self.assertEqual(len(res.data), 496)
        self.assertNotIn("rows_mismatch:496!=496", res.extra["missing"])

    def test_C02_middle_page_failure_is_partial_and_keeps_rows(self):
        pages = {1: payload(rows_range(0, 100), total=496),
                 2: ProviderNetworkError(ESC, "boom"),
                 3: payload(rows_range(100, 100), total=496),
                 4: payload(rows_range(200, 100), total=496),
                 5: payload(rows_range(300, 96), total=496),
                 6: None}
        res = fetch(pages)

        self.assertEqual(res.status, "partial")
        self.assertEqual(res.extra["completeness"], "partial")
        self.assertEqual(res.extra["missing_pages"], [2])
        self.assertEqual(res.extra["total"], 496)
        self.assertEqual(res.extra["fetched"], 396)          # 已抓到的行全部保留
        self.assertEqual(len(res.data), 396)
        self.assertIn("rows_mismatch:396!=496", res.extra["missing"])
        self.assertIn("rows_shortfall:100", res.notes)
        self.assertIn("missing_pages:2", res.notes)
        self.assertIsNone(res.error, "单页失败是 partial，不是整体 failed")

    def test_C02b_failure_then_later_pages_still_fetched(self):
        """单页失败不能中断循环：后续页必须继续请求。"""
        pages = {1: payload(rows_range(0, 100), total=496),
                 2: ProviderNetworkError(ESC, "boom"),
                 3: payload(rows_range(100, 100), total=496),
                 4: payload(rows_range(200, 100), total=496),
                 5: payload(rows_range(300, 96), total=496),
                 6: None}
        p = ScriptedSector(pages)
        res = p.fetch(mode="flow")
        self.assertEqual(p.calls, [1, 2, 3, 4, 5, 6],
                         "第 2 页失败后没有继续抓后续页")
        self.assertEqual(res.extra["missing_pages"], [2])
        self.assertEqual(res.extra["fetched"], 396)

    def test_C03_first_page_data_null_is_empty_not_failed(self):
        res = fetch({})

        self.assertEqual(res.status, "empty")
        self.assertEqual(res.data, [])
        self.assertEqual(res.extra["completeness"], "unknown")
        self.assertEqual(res.extra["fetched"], 0)
        self.assertIsNone(res.extra["total"])
        self.assertEqual(res.extra["stopped"], "data_null")
        self.assertEqual(res.extra["missing_pages"], [])
        self.assertIsNone(res.error, "data=null 是越界页正常停止，不能报失败")

    def test_C03b_data_null_mid_sequence_stops_normally(self):
        """上游没给 total、翻到越界页 data:null：正常停止，不记失败页、不报错。"""
        pages = {1: payload(rows_range(0, 100), has_total=False),
                 2: payload(rows_range(100, 50), has_total=False),
                 3: None}
        res = fetch(pages)

        self.assertEqual(res.extra["stopped"], "data_null")
        self.assertEqual(res.extra["missing_pages"], [],
                         "data=null 的越界页不是失败页，不应计入 missing_pages")
        self.assertIsNone(res.error, "data=null 是正常停止，不能当失败")
        self.assertEqual(res.extra["fetched"], 150)
        self.assertEqual(res.extra["completeness"], "partial",
                         "total 未知，无法核对完整性")

    def test_C03c_data_null_with_shortfall_counts_page_not_error(self):
        """先正常抓、后遇 data:null，但行数不足以填满 total → partial，缺页照实记。"""
        pages = {1: payload(rows_range(0, 100), total=250),
                 2: payload(rows_range(100, 50), total=250),
                 3: None}
        res = fetch(pages)

        self.assertEqual(res.extra["stopped"], "data_null")
        self.assertIsNone(res.error)
        self.assertEqual(res.extra["completeness"], "partial")
        self.assertEqual(res.extra["missing_pages"], [3],
                         "此前未见过的页（按 total 推算应有）必须列为缺页")
        self.assertIn("rows_mismatch:150!=250", res.extra["missing"])

    def test_C04_all_pages_failure_raises_overall(self):
        pages = {pn: ProviderNetworkError(ESC, "down") for pn in range(1, 21)}
        res = fetch(pages)

        self.assertEqual(res.status, "failed")
        self.assertIsNone(res.data, "全部页失败时绝不能返回空列表冒充空板块")
        self.assertEqual(res.error["type"], "ProviderNetworkError")
        self.assertEqual(res.extra, {})

    def test_C04b_all_pages_format_error_raises_overall(self):
        pages = {pn: ProviderFormatError(ESC, "坏 JSON") for pn in range(1, 21)}
        res = fetch(pages)

        self.assertEqual(res.status, "failed")
        self.assertIsNone(res.data)
        self.assertEqual(res.error["type"], "ProviderFormatError")

    def test_C05_cross_page_duplicates_deduped_and_flagged(self):
        # 第 2 页重复第 1 页内容，第 3 页补剩余 50 行
        first = payload(rows_range(0, 100), total=150)
        dup = payload(rows_range(0, 100), total=150)
        tail = payload(rows_range(100, 50), total=150)
        res = fetch({1: first, 2: dup, 3: tail, 4: None})

        self.assertEqual(res.status, "partial")
        self.assertEqual(res.extra["completeness"], "partial")
        self.assertEqual(res.extra["duplicates"], 100)
        self.assertEqual(res.extra["fetched"], 150, "去重后应按唯一板块代码计数")
        self.assertEqual(len(res.data), 150)
        self.assertIn("duplicates:100", res.notes)
        self.assertIn("duplicates:100", res.extra["missing"])
        self.assertEqual(res.extra["missing_pages"], [])
        self.assertEqual(res.extra["stopped"], "total_reached")

    def test_C06_total_drift_across_pages_is_partial(self):
        pages = {1: payload(rows_range(0, 100), total=200),
                 2: payload(rows_range(100, 100), total=201),
                 3: None}
        res = fetch(pages)

        self.assertEqual(res.status, "partial")
        self.assertEqual(res.extra["completeness"], "partial")
        self.assertEqual(res.extra["total_mismatch"], 1)
        self.assertEqual(res.extra["total"], 200, "保留首个 total 作为上游声称总数")
        self.assertEqual(res.extra["fetched"], 200)
        self.assertIn("total_mismatch:2:201!=200", res.extra["missing"])
        self.assertEqual(len(res.data), 200, "漂移时已抓到的行仍要保留")

    def test_C07_page_limit_truncation_reports_missing_pages(self):
        # total=25，pz=10 → 应有 3 页；只允许抓 2 页 → 缺第 3 页
        pages = {1: payload(rows_range(0, 10), total=25),
                 2: payload(rows_range(10, 10), total=25),
                 3: payload(rows_range(20, 5), total=25)}
        res = fetch({1: pages[1], 2: pages[2]}, page_size=10, max_pages=2)

        self.assertEqual(res.status, "partial")
        self.assertEqual(res.extra["completeness"], "partial")
        self.assertEqual(res.extra["fetched"], 20)
        self.assertEqual(res.extra["expected_pages"], 3)
        self.assertEqual(res.extra["missing_pages"], [3],
                         "页数上限截断时必须能算出缺了第几页")
        self.assertEqual(res.extra["stopped"], "max_pages")
        self.assertIn("3", res.extra["missing"])
        self.assertIn("rows_shortfall:5", res.notes)

    def test_C08_missing_total_is_partial_not_complete(self):
        pages = {1: payload(rows_range(0, 3), has_total=False), 2: None}
        res = fetch(pages)

        self.assertEqual(res.extra["completeness"], "partial",
                         "上游没给 total 时无法核对，不能声称完整")
        self.assertIsNone(res.extra["total"])
        self.assertEqual(res.extra["fetched"], 3)
        self.assertEqual(len(res.data), 3)

    def test_C08b_empty_upstream_zero_is_complete_but_status_empty(self):
        res = fetch({1: payload([], total=0)})
        self.assertEqual(res.status, "empty")
        self.assertEqual(res.extra["completeness"], "complete",
                         "上游 total=0 且确实 0 行：是完整空集，不是抓取失败")

    def test_C09_zero_progress_pages_stop_without_spinning(self):
        """上游连续重复同一批板块 → 连续两页无新板块后停止，不无限翻页。"""
        same = payload(rows_range(0, 100), total=496)
        res = fetch({1: same, 2: same, 3: same})

        self.assertEqual(res.status, "partial")
        self.assertEqual(res.extra["stopped"], "no_progress")
        self.assertEqual(res.extra["duplicates"], 200,
                         "第 2、3 页各自整页重复，逐行计入重复条数")
        self.assertEqual(res.extra["fetched"], 100)


class TestParseAndMissingSemantics(unittest.TestCase):
    """N01-N07：缺失/零/格式错的解析口径。"""

    def test_N01_dash_and_empty_are_unknown_not_zero(self):
        for raw in ("-", "--", "", None, "null"):
            res = fetch({1: payload([row("BK0001", "甲", f62=raw)], total=1)})
            self.assertIsNone(res.data[0]["flow"], f"f62={raw!r} 被当成了 0 或其他值")
            self.assertEqual(res.extra["completeness"], "complete")

    def test_N02_real_zero_is_kept(self):
        for raw in (0, "0", 0.0):
            res = fetch({1: payload([row("BK0001", "甲", f62=raw)], total=1)})
            self.assertEqual(res.data[0]["flow"], 0.0, f"真实零 f62={raw!r} 被丢失")
            self.assertIsInstance(res.data[0]["flow"], float)
            self.assertEqual(res.extra["completeness"], "complete")

    def test_N03_unparsable_number_is_format_error(self):
        for bad in ("abc", "1.2.3", float("nan"), float("inf")):
            res = fetch({1: payload([row("BK0001", "甲", f62=bad)], total=1)})
            self.assertEqual(res.status, "failed", f"不可解析数值 {bad!r} 被静默接受")
            self.assertEqual(res.error["type"], "ProviderFormatError")
            self.assertIsNone(res.data)

    def test_N04_missing_name_skipped_and_counted_not_complete(self):
        rows = [{"f12": "BK0009", "f3": 1.0, "f62": 1e8},     # 无名称
                row("BK0001", "甲", f62=1e8)]
        res = fetch({1: payload(rows, total=2)})

        self.assertEqual(len(res.data), 1, "缺名称行必须跳过")
        self.assertIn("skipped_no_name:1", res.notes)
        self.assertEqual(res.extra["completeness"], "partial",
                         "跳过 1 行后行数对不上 total，不能判完整")
        self.assertIn("rows_mismatch:1!=2", res.extra["missing"])
        self.assertEqual(res.extra["fetched"], 1)
        self.assertIn("rows_shortfall:1", res.notes)

    def test_N05_valuation_negative_pe_and_missing_pb_counted(self):
        rows = [row(f"BK{i:04d}", f"板块{i}", f9=-10.0 if i < 3 else 20.0,
                    f23="-", f20=1e10) for i in range(5)]
        res = fetch({1: payload(rows, total=5)}, mode="valuation")

        self.assertEqual(res.extra["negative_pe"], 3)
        self.assertEqual(res.extra["pb_unavailable"], 5)
        self.assertIn("negative_pe:3", res.notes)
        self.assertIn("pb_unavailable:5", res.notes)
        self.assertEqual([r["pe"] for r in res.data[:3]], [-10.0, -10.0, -10.0],
                         "负 PE 必须保留真实数值，不能被过滤或取绝对值")
        self.assertTrue(all(r["pb"] is None for r in res.data))
        self.assertEqual(res.extra["completeness"], "complete",
                         "PB 全缺失是上游口径，不能因此把 496 行判成 partial")

    def test_N06_zero_pe_kept_and_not_counted_negative(self):
        res = fetch({1: payload([row("BK0001", "零", f9=0, f23=0.7)], total=1)},
                    mode="valuation")
        self.assertEqual(res.data[0]["pe"], 0.0)
        self.assertEqual(res.data[0]["pb"], 0.7)
        self.assertNotIn("negative_pe:1", res.notes)

    def test_N07_asof_is_empty_not_now(self):
        """接口没有时间戳：asof 必须留空，不能被当前时间顶替。"""
        res = fetch({1: payload(rows_range(0, 2), total=2)})
        self.assertEqual(res.asof, "", "asof 被伪造成了本地时间")

    def test_N08_valuation_missing_fields_are_unknown(self):
        r = {"f12": "BK0001", "f14": "甲", "f3": 1.0}
        res = fetch({1: payload([r], total=1)}, mode="valuation")
        self.assertIsNone(res.data[0]["pe"])
        self.assertIsNone(res.data[0]["pb"])
        self.assertIsNone(res.data[0]["market_cap"])


class TestRowsRetainedDownstream(unittest.TestCase):
    """R01-R03：partial 的行不能在缓存校验/图表层被整份丢掉。"""

    def test_R01_validate_sectors_keeps_partial_all_zero_rows(self):
        # 真实的全 0 行情（全部平盘/无资金）也必须是"可返回的数据"
        self.assertTrue(_validate_sectors([
            {"name": "甲", "change": 0.0, "flow": 0.0},
            {"name": "乙", "change": 0.0, "flow": 0.0},
        ]))

    def test_R01b_validate_sectors_rejects_only_empty(self):
        self.assertFalse(_validate_sectors([]))
        self.assertFalse(_validate_sectors(None))
        self.assertFalse(_validate_sectors({"a": 1}))

    def test_R02_heatmap_builder_keeps_null_flow_rows(self):
        chart = build_heatmap_chart([
            {"name": "甲", "flow": None, "change": None},
            {"name": "乙", "flow": 5, "change": 1.0},
        ])
        self.assertEqual(len(chart), 2, "flow=None 的板块行被整行丢弃")
        self.assertIsNone(chart[0]["flow"])
        self.assertEqual(chart[0]["value"], 0)
        self.assertEqual(chart[1]["value"], 5)

    def test_R03_partial_keeps_rows_even_with_duplicates_and_failure(self):
        pages = {1: payload(rows_range(0, 50), total=200),
                 2: ProviderNetworkError(ESC, "boom"),
                 3: payload(rows_range(0, 50), total=200),   # 与第 1 页重复
                 4: payload(rows_range(50, 50), total=200)}
        res = fetch(pages)
        self.assertEqual(res.status, "partial")
        self.assertEqual(res.extra["fetched"], 100)
        self.assertEqual(len(res.data), 100, "重复/失败页的已抓行不应被丢弃")


class TestRouteCompletenessHeaders(unittest.TestCase):
    """HTTP 层：完整性结论、缺失页码与计数备注要能被外部读到。

    复用 S3-3B 的离线路由夹具（把 `data_service.requests.get` 换成按 pn/pz
    返回真实分页形态的假实现），Provider 的分页/去重/缺失判定是真跑的。
    """

    def setUp(self):
        from tests.test_s3_3b_sector_cache import SectorCacheTestBase
        self._case = SectorCacheTestBase()
        self._case.setUp()
        self.client = self._case.client

    def tearDown(self):
        self._case.tearDown()

    def get_json(self, path):
        return self._case.get(path)

    def _get(self, path, http_fn):
        from unittest import mock
        import data_service
        with mock.patch.object(data_service.requests, "get", side_effect=http_fn):
            return self.get_json(path)

    def test_H01_complete_reports_rows_and_total(self):
        from tests.test_s3_3b_sector_cache import sector_http
        r, body = self._get("/api/heatmap", sector_http(total=496))
        self.assertEqual(body["code"], 200)
        h = r.headers
        self.assertEqual(h["X-Data-Completeness"], "complete")
        self.assertEqual(h["X-Data-Rows"], "496")
        self.assertEqual(h["X-Data-Total"], "496")
        self.assertEqual(h["X-Data-Missing"], "-")
        self.assertEqual(h["X-Data-AsOf"], "unknown")

    def test_H02_partial_lists_failed_page_and_shortfall(self):
        from tests.test_s3_3b_sector_cache import sector_http
        r, body = self._get("/api/heatmap", sector_http(total=496, fail_pages={3}))
        h = r.headers
        self.assertEqual(h["X-Data-Completeness"], "partial")
        self.assertEqual(h["X-Data-Rows"], "396")
        self.assertEqual(h["X-Data-Total"], "496")
        missing = h["X-Data-Missing"].split(",")
        self.assertIn("3", missing)
        self.assertIn("rows_mismatch:396!=496", missing)
        self.assertEqual(len(body["data"]), 396, "部分成功仍要保留已抓到的行")

    def test_H03_duplicates_and_drift_are_reported(self):
        from tests.test_s3_3b_sector_cache import sector_http
        r, _ = self._get("/api/heatmap", sector_http(total=496, duplicate_pages={2}))
        self.assertEqual(r.headers["X-Data-Completeness"], "partial")
        self.assertIn("duplicates:100", r.headers["X-Data-Missing"].split(","))

        self._case.restart()          # 清掉上一轮内存命中，模拟新一次采集
        r, _ = self._get("/api/heatmap", sector_http(total=496, page_total_shift={2: 10}))
        self.assertEqual(r.headers["X-Data-Completeness"], "partial")
        self.assertIn("total_mismatch", r.headers["X-Data-Missing"])

    def test_H04_all_pages_failed_is_500_not_empty_list(self):
        from tests.test_s3_3b_sector_cache import timeout_http
        r, body = self._get("/api/heatmap", timeout_http())
        self.assertEqual(body["code"], 500)
        self.assertIsNone(body.get("data"))
        self.assertEqual(r.headers["X-Data-Fetch-Status"], "failed")
        self.assertEqual(r.headers["X-Data-Completeness"], "unknown")
        self.assertEqual(r.headers["X-Data-Served-From"], "none")

    def test_H05_valuation_complete_with_pb_null_and_negative_pe_notes(self):
        from tests.test_s3_3b_sector_cache import sector_http
        r, body = self._get("/api/sector-valuation", sector_http(total=496, pe_negative=90))
        self.assertEqual(r.headers["X-Data-Completeness"], "complete",
                         "PB 全 null 是上游口径，不能因此判 partial")
        self.assertEqual(r.headers["X-Data-Rows"], "496")
        self.assertEqual(len(body["data"]), 496)
        self.assertTrue(all(row["pb"] is None for row in body["data"]))
        negatives = [row for row in body["data"]
                     if row["pe"] is not None and row["pe"] < 0]
        self.assertEqual(len(negatives), 90)
        notes = self._case.meta_of("sector_valuation")["notes"]
        self.assertIn("negative_pe:90", notes)
        self.assertIn("pb_unavailable:496", notes)


if __name__ == "__main__":
    unittest.main(verbosity=2)
