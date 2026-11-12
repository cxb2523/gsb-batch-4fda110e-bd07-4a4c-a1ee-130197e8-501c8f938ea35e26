# -*- coding: utf-8 -*-
"""东方财富板块 Provider：一个类，两种模式（资金流 / 估值），同一 clist 接口。

| 模式 | 用途 | fields |
|---|---|---|
| flow | 行业板块资金流（热力图） | `f12,f14,f2,f3,f62` |
| valuation | 行业板块估值（PE/PB/市值） | `f12,f14,f2,f3,f9,f20,f23,f25,f37` |

为什么两种模式放一个类：请求层（URL/UA/分页循环/`diff` 形态兼容/错误分类）完全相同，
只有 `fields` 与行映射不同。拆成两个 Provider 会把分页与去重逻辑复制两遍 —— 一处修好、
另一处忘改，正是 S3 要消灭的东西。

## 分页（S3-3 D2 实测结论，2026-11-10）

- `total` 是**完整板块数**（当前 496），不是某页条数；
- `pz` 服务端上限 **100**（101/200/500 都只回 100 行，响应字节相同）；
- `pn` 从 1 开始，越界页返回 `data:null`、83 字节 —— **不是空数组**，必须区分；
- 496 条 = 5 页 × 100（最后一页 96），按 `f12` 去重后唯一数应等于 `total`。

## 完整性结论（S3-3A/3D）

一次抓取结束后，`extra` 必须能直接回答三个问题：

| 字段 | 含义 |
|---|---|
| `total` | 上游声称的总数（各页 `data.total`；跨页漂移时保留首个并在 `missing` 记 `total_mismatch`） |
| `fetched` | 本次解析后实际可用的板块行数（按 `f12` 去重、跳过缺名称行之后） |
| `missing_pages` | 缺了哪些页：请求失败的页 + 上游 `total` 表明存在但本次没拿到的页 |

`completeness` 的判定是**唯一出口**，只有下列全部成立才是 `complete`：

1. `total` 已知；
2. `fetched == total`；
3. 没有失败页 / 未拿到页（`missing_pages` 为空）；
4. 没有跨页重复（`duplicates == 0`）；
5. 没有总数漂移（`total_mismatch == 0`）。

任何一条不满足 → `partial`，并且**保留已抓到的行**（不整份丢弃）。
一页都没抓到（`fetched == 0`）时无法判断完整度 → `unknown`；上游明确 `total=0`
且确实 0 行时才是 `complete`（这是"真的没有板块"，与"抓取失败"由状态区分）。

停止原因写在 `stopped`：

| 值 | 含义 |
|---|---|
| `total_reached` | 唯一板块数已达到 `total`，正常结束 |
| `data_null` | 越界页返回 `data:null`（**正常停止，不是失败**） |
| `empty_page` | 某页返回空数组，正常停止 |
| `no_progress` | 连续两页没有带来任何新板块（上游重复/卡页），停止以免空转 |
| `max_pages` | 达到本地页数上限仍未取满（可能截断） |

所有页都失败时 `request()` 直接抛出首个错误（整体失败），不会产出 `stopped`。

## 缺失语义（S3-3 D3/D4）

| 上游 | 对外 |
|---|---|
| `1.85` | `1.85` |
| `0` / `"0"` | `0.0`（**真实零，不是缺失**） |
| `"-"` / `"--"` / `""` / 键不存在 | `None` |
| `"abc"` / `NaN` / `Inf` 等不可解析 | 抛 `ProviderFormatError`（不静默变 0，也不静默变 null） |

实测（496 行全量）：`f23`(PB) **496/496 为 `"-"`**，`f37` 同；`f9`(PE) 全为数值，其中 90 个为负。
因此 valuation 的 `pb` 恒为 `None` —— 这是上游事实，不是本地过滤。
"""

import json
import math

import requests

from ..base import Provider
from ..exceptions import ProviderFormatError, ProviderNetworkError, ProviderTimeout

CLIST_URL = "https://push2.eastmoney.com/api/qt/clist/get"
UT = "bd1d9ddb04089700cf9c27f6f7426281"
FS_INDUSTRY = "m:90+t:2"          # 行业板块（当前 496 个）；概念 t:3 / 地域 t:1 不在本阶段

PAGE_SIZE_MAX = 100               # 服务端硬上限，超过也只回 100 行
MAX_PAGES = 20                    # 防御：499 个板块也只需 5 页，20 页足够兜住异常增长

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"),
    "Referer": "https://quote.eastmoney.com/",
}

MODES = ("flow", "valuation")

FIELDS = {
    "flow": "f12,f14,f2,f3,f62",
    "valuation": "f12,f14,f2,f3,f9,f20,f23,f25,f37",
}

DASHES = ("-", "--", "—")


def num(value, field, row_name=""):
    """严格数值解析：`"-"`/空 → None；不可解析 → ProviderFormatError。

    与 data_service 老 `_num(v, default=0.0)` 的区别只有一条，但很关键：
    `"-"` 不再变成 0。宁可返回 null 让页面显示"--"，也不能把"不知道"写成"0 倍"。
    """
    if value is None:
        return None
    if isinstance(value, bool):        # bool 是 int 的子类，容易被误当 1/0
        raise ProviderFormatError("eastmoney_sector",
                                  f"{row_name} {field} 是布尔值：{value!r}")
    if isinstance(value, (int, float)):
        result = float(value)
        if not math.isfinite(result):  # NaN / Infinity 是"解析失败"的数值形态
            raise ProviderFormatError("eastmoney_sector",
                                      f"{row_name} {field} 不是有限数字：{value!r}")
        return result
    text = str(value).strip().replace(",", "")
    if text in DASHES or text == "" or text.lower() in ("null", "none"):
        return None
    try:
        result = float(text)
    except (TypeError, ValueError):
        raise ProviderFormatError("eastmoney_sector",
                                  f"{row_name} {field} 不是数字：{value!r}")
    if not math.isfinite(result):      # "nan"/"inf" 字符串同样不能静默通过
        raise ProviderFormatError("eastmoney_sector",
                                  f"{row_name} {field} 不是有限数字：{value!r}")
    return result


def _diff_rows(payload):
    """`data.diff` 可能是数组（np=1）也可能是"下标字符串→对象"的 dict，两种都要吃。"""
    data = payload.get("data")
    if data is None:
        return None, None
    if not isinstance(data, dict):
        raise ProviderFormatError("eastmoney_sector", f"data 不是对象：{type(data).__name__}")
    rows = data.get("diff")
    if rows is None:
        return data.get("total"), []
    if isinstance(rows, dict):
        rows = list(rows.values())
    if not isinstance(rows, list):
        raise ProviderFormatError("eastmoney_sector", f"diff 类型异常：{type(rows).__name__}")
    return data.get("total"), rows


class EastmoneySectorProvider(Provider):
    """板块资金流 / 板块估值（同一 clist 接口，两模式）。"""

    name = "eastmoney_sector"
    kind = "sector"
    timeout = 8.0

    # ---- 请求层 ----
    def _get(self, params):
        """单次 GET → dict。测试通过覆盖此方法注入报文，不打真实网络。"""
        try:
            resp = requests.get(CLIST_URL, params=params, headers=HEADERS, timeout=self.timeout)
        except requests.Timeout as e:
            raise ProviderTimeout(self.name, f"请求超时（{self.timeout}s）", url=CLIST_URL, cause=e)
        except requests.RequestException as e:
            raise ProviderNetworkError(self.name, f"请求失败 {type(e).__name__}", url=CLIST_URL, cause=e)
        if resp.status_code != 200:
            raise ProviderNetworkError(self.name, f"HTTP {resp.status_code}", url=CLIST_URL)
        try:
            return json.loads(resp.text)
        except ValueError as e:
            raise ProviderFormatError(self.name, "响应不是合法 JSON", url=CLIST_URL, cause=e)

    def request(self, mode="flow", page_size=PAGE_SIZE_MAX, max_pages=MAX_PAGES):
        """逐页抓取，**不因单页失败而整体失败** —— 失败页记进 missing_pages 交给 normalize。

        停止条件（按优先级）：
          - 唯一板块数（按 f12）已达到 `total` → total_reached；
          - 上游返回 `data:null`（越界页）→ data_null（**正常停止，不是失败**）；
          - 某页返回空数组 → empty_page；
          - 页放回的行全是已见过的板块（连续无进展）→ no_progress；
          - 达到本地页数上限 → max_pages（可能被截断，交由 normalize 判 partial）。
        全部页都失败时抛出首个错误，绝不返回空列表冒充"今天没有板块"。
        """
        if mode not in MODES:
            raise ProviderFormatError(self.name, f"未知 mode：{mode!r}")
        page_size = max(1, min(int(page_size or PAGE_SIZE_MAX), PAGE_SIZE_MAX))

        pages, missing, first_error = [], [], None
        total = None
        seen_codes = set()          # 只用于判断"取满 total"与"无进展"，解析层会再独立去重
        stopped = "max_pages"
        idle_pages = 0
        for pn in range(1, max_pages + 1):
            params = {
                "pn": str(pn), "pz": str(page_size), "po": "1", "np": "1",
                "ut": UT, "fltt": "2", "invt": "2", "fid": "f3",
                "fs": FS_INDUSTRY, "fields": FIELDS[mode],
            }
            try:
                payload = self._get(params)
                rc = payload.get("rc")
                if rc not in (0, None):
                    raise ProviderFormatError(self.name, f"第 {pn} 页 rc={rc}")
                page_total, rows = _diff_rows(payload)
            except (ProviderNetworkError, ProviderTimeout, ProviderFormatError) as e:
                pages.append({"pn": pn, "error": e.to_error()})
                missing.append(pn)
                first_error = first_error or e
                continue

            if rows is None:                      # data=null：越界页，明确停止
                stopped = "data_null"
                break
            if not rows:
                # 空数组页同样是正常停止（不是失败），但上游此时给的 total 仍然有效：
                # total=0 就是"确实没有板块"（完整空集）；total>0 则是上游异常返回空页，
                # 后面按 total 推算缺页并判 partial，不冒充"今天没有板块"。
                if page_total is not None and total is None:
                    total = page_total
                stopped = "empty_page"
                break
            if page_total is not None:
                if total is None:
                    total = page_total
                elif page_total != total:
                    missing.append(f"total_mismatch:{pn}:{page_total}!={total}")
            pages.append({"pn": pn, "total": page_total, "rows": rows})

            new = 0
            for row in rows:
                # 与解析层同一套去重键（code 优先，缺失时退回名称），
                # 否则"无 code 但有名称"的行会被误当成重复，提前触发 no_progress。
                code = str(row.get("f12") or "").strip()
                key = code or str(row.get("f14") or "").strip()
                if key and key not in seen_codes:
                    seen_codes.add(key)
                    new += 1
            unique = len(seen_codes)
            if total is not None and unique >= total:
                stopped = "total_reached"
                break
            # 整页都是已见过的板块：偶发一页(例如排序抖动导致整页重复)还要继续翻，
            # 但**连续两页**都没有任何新板块说明上游卡页/重复返回，再翻只是空转。
            idle_pages = idle_pages + 1 if new == 0 else 0
            if idle_pages >= 2:
                stopped = "no_progress"
                break
        if not any("rows" in p for p in pages) and first_error is not None:
            # 全部页都失败：整体失败，不能返回空列表冒充"今天没有板块"
            raise first_error
        return {"mode": mode, "page_size": page_size, "pages": pages,
                "missing_pages": missing, "stopped": stopped, "total_hint": total}

    # ---- 解析层 ----
    def normalize(self, raw, mode=None, **_):
        mode = (raw or {}).get("mode") or mode or "flow"
        rows_out, seen, duplicates = [], set(), 0
        notes = []
        negative_pe = 0
        pb_unavailable = 0
        skipped_no_name = 0

        for page in (raw or {}).get("pages", []):
            if "rows" not in page:
                continue
            for row in page["rows"]:
                name = str(row.get("f14") or "").strip()
                if not name:
                    skipped_no_name += 1
                    continue
                code = str(row.get("f12") or "").strip()
                key = code or name
                if key in seen:
                    duplicates += 1
                    continue
                seen.add(key)

                change = num(row.get("f3"), "f3", name)
                item: dict = {"name": name}
                if mode == "flow":
                    flow = num(row.get("f62"), "f62", name)
                    item["change"] = None if change is None else round(change, 2)
                    item["flow"] = None if flow is None else round(flow / 1e8, 2)
                else:
                    pe = num(row.get("f9"), "f9", name)
                    pb = num(row.get("f23"), "f23", name)
                    mc = num(row.get("f20"), "f20", name)
                    item["pe"] = None if pe is None else round(pe, 2)
                    item["pb"] = None if pb is None else round(pb, 2)
                    item["change"] = None if change is None else round(change, 2)
                    item["market_cap"] = None if mc is None else round(mc / 1e8, 2)
                    if pe is not None and pe < 0:
                        negative_pe += 1
                    if pb is None:
                        pb_unavailable += 1
                rows_out.append(item)

        total = (raw or {}).get("total_hint")
        fetched = len(rows_out)
        missing = list((raw or {}).get("missing_pages") or [])
        failed_pages = [m for m in missing if isinstance(m, int)]
        total_mismatch = sum(1 for m in missing if str(m).startswith("total_mismatch"))

        # “缺了哪些页” = 请求失败的页 ∪ 按上游 total 推算应有、但本次根本没取到的页。
        # 后者覆盖"页数上限截断""提前无进展停止"这类静默缺口 ——
        # 没有这一步，缺页只能靠人拿行数反推。
        expected_pages = _expected_pages(total, (raw or {}).get("page_size"))
        fetched_pns = {p.get("pn") for p in (raw or {}).get("pages", []) if "rows" in p}
        missing_pages = set(failed_pages)
        if expected_pages is not None:
            missing_pages.update(pn for pn in range(1, expected_pages + 1)
                                 if pn not in fetched_pns)
        inferred_pages = sorted(missing_pages - set(failed_pages))
        missing_pages = sorted(missing_pages)
        for pn in inferred_pages:
            missing.append(pn)               # 让 X-Data-Missing 也能列出这些页
        if missing_pages:
            notes.append(f"missing_pages:{','.join(str(p) for p in missing_pages)}")

        if skipped_no_name:
            notes.append(f"skipped_no_name:{skipped_no_name}")
        if duplicates:
            notes.append(f"duplicates:{duplicates}")
            missing.append(f"duplicates:{duplicates}")
        if total is not None and fetched != total:
            # 行数与 total 不一致（分页期间行情跳动会导致跨页重复/遗漏）；
            # 如实给出差额，不静默补齐、不四舍五入成"看起来完整"。
            missing.append(f"rows_mismatch:{fetched}!={total}")
            if fetched < total:
                notes.append(f"rows_shortfall:{total - fetched}")
                if not missing_pages:
                    # 没有缺页却仍不够 total：上游提前截断或漏行，
                    # 与"分页请求失败"区分开，便于运维看清缺口的性质。
                    missing.append(f"pages_shortfall:{fetched}<{total}")
        if mode == "valuation":
            if negative_pe:
                notes.append(f"negative_pe:{negative_pe}")
            if pb_unavailable:
                notes.append(f"pb_unavailable:{pb_unavailable}")

        extra = {
            "mode": mode,
            "total": total,
            "fetched": fetched,
            "duplicates": duplicates,
            "total_mismatch": total_mismatch,
            "missing_pages": missing_pages,
            "missing": [str(m) for m in missing],
            "notes": notes,
            "pages_fetched": len(fetched_pns),
            "expected_pages": expected_pages,
            "stopped": (raw or {}).get("stopped"),
            "negative_pe": negative_pe,
            "pb_unavailable": pb_unavailable,
        }
        extra["completeness"] = _completeness_of(total, fetched, missing_pages, duplicates,
                                                 total_mismatch)
        # 接口没有任何时间戳字段：asof 恒为空串，由缓存层用"最近成功抓取时刻"补齐，
        # 绝不用 now() 冒充交易所时间（S3-0 已确认 clist 报文无时间字段）。
        return rows_out, "", extra


def _expected_pages(total, page_size):
    """上游 total + 本地 pz → 应有页数；total 未知时返回 None（不猜）。"""
    try:
        total = int(total)
    except (TypeError, ValueError):
        return None
    try:
        page_size = int(page_size or PAGE_SIZE_MAX)
    except (TypeError, ValueError):
        page_size = PAGE_SIZE_MAX
    if total <= 0 or page_size <= 0:
        return 0 if total == 0 else None
    return -(-total // page_size)          # ceil


def _completeness_of(total, fetched, missing_pages, duplicates, total_mismatch):
    """完整性唯一出口：行数、缺页、重复、total 漂移全部通过才算 complete。

    - total 未知但抓到了行 → partial（无法核对行数，不能声称完整）
    - 一行都没拿到 → unknown（抓取失败的"空"不是"完整"）
    - 只有"0 行且 total=0"是 complete：这是"上游确实没有板块"，不是抓取失败
    - 其余 partial：已抓到的行照常返回，只是不声称完整
    """
    if total is None:
        return "partial" if (fetched > 0 or missing_pages) else "unknown"
    if total == 0 and fetched == 0 and not missing_pages:
        return "complete"
    if fetched == 0:
        return "unknown"
    ok = (fetched == total and not missing_pages
          and duplicates == 0 and total_mismatch == 0)
    return "complete" if ok else "partial"
