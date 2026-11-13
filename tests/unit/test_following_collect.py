"""关注列表批量采集 collect_all_followed 的单元测试（不连 B 站）。

全程用 monkeypatch 替换 fetch_followed_page，构造四类样例：
正常多页（含跨页重复，验证合并去重与 added 标记）、第二页静默降级、
-101 凭证失效、页码非法（400）——断言页码序列、每页条数、降级标记
与错误码映射（凭证失效与页码非法必须可区分）。
"""
from __future__ import annotations

import pytest

from recorder import following as fmod


def _item(room_id: int, uname: str = "", live_status: int = 0) -> dict:
    return {
        "room_id": room_id, "uid": room_id * 10,
        "uname": uname or f"主播{room_id}", "title": "",
        "live_status": live_status, "face": "", "live_time": "",
    }


def _page(page: int, room_ids: list[int], total: int, total_page: int) -> dict:
    return {
        "items": [_item(r) for r in room_ids],
        "page": page, "page_size": fmod.PAGE_SIZE,
        "total": total, "total_page": total_page, "live_count": 0,
    }


def _pager(pages: dict[int, dict]):
    """按页码查表的 fetch_followed_page 替身，并记录实际请求页码。"""
    calls: list[int] = []

    def fake(sessdata, page=1):
        calls.append(page)
        if page not in pages:
            raise fmod.FollowingError(f"页码非法：{page}", 400)
        return pages[page]

    fake.calls = calls
    return fake


# 正常多页

def test_collect_multi_page_merges_and_dedups(monkeypatch):
    """三页正常拉取：跨页重复的 room_id 只保留一条，added 标记按已有目标标注。"""
    pager = _pager({
        1: _page(1, list(range(1, 21)), total=44, total_page=3),
        # 第 2 页满页 20 条，其中 room 5 与第 1 页跨页重复
        2: _page(2, [5] + list(range(21, 40)), total=44, total_page=3),
        3: _page(3, list(range(40, 45)), total=44, total_page=3),  # 末页残页属正常
    })
    monkeypatch.setattr(fmod, "fetch_followed_page", pager)

    r = fmod.collect_all_followed("SESS", existing_room_ids={21})

    assert r["end_reason"] == fmod.END_COMPLETE
    assert r["ok"] is True and r["degraded"] is False
    assert r["error"] is None and r["error_code"] is None
    assert r["pages"] == [1, 2, 3] == pager.calls
    assert r["page_counts"] == [20, 20, 5]
    # 44 个去重后的房间，顺序按首次出现
    assert [i["room_id"] for i in r["items"]] == list(range(1, 45))
    added = {i["room_id"]: i["added"] for i in r["items"]}
    assert added[21] is True
    assert all(v is False for k, v in added.items() if k != 21)
    # 条目字段齐备：room_id / uname / live_status / added
    for it in r["items"]:
        assert {"room_id", "uname", "live_status", "added"} <= set(it)


def test_collect_stops_at_page_limit(monkeypatch):
    """total_page 很大时，达到 max_pages 上限即保护性停止，不无限翻页。"""
    pager = _pager({
        p: _page(p, list(range(p * 100, p * 100 + 20)),
                 total=9999, total_page=999) for p in (1, 2, 3)
    })
    monkeypatch.setattr(fmod, "fetch_followed_page", pager)

    r = fmod.collect_all_followed("SESS", max_pages=3)

    assert r["end_reason"] == fmod.END_PAGE_LIMIT
    assert r["ok"] is True and r["degraded"] is False
    assert r["pages"] == [1, 2, 3]
    assert len(r["items"]) == 60


def test_collect_empty_first_page_is_no_more(monkeypatch):
    """首页即空：正常结束（无更多页），不算降级。"""
    pager = _pager({1: _page(1, [], total=0, total_page=0)})
    monkeypatch.setattr(fmod, "fetch_followed_page", pager)

    r = fmod.collect_all_followed("SESS")

    assert r["end_reason"] == fmod.END_NO_MORE
    assert r["ok"] is True and r["degraded"] is False
    assert r["items"] == [] and r["page_counts"] == [0]


# 第二页降级

def test_collect_detects_degradation_on_second_page(monkeypatch):
    """第二页只回 10 条（< page_size 20）且 total_page 显示仍有后续页：
    判定疑似静默降级，立即中止，不再请求第三页。"""
    pager = _pager({
        1: _page(1, list(range(1001, 1021)), total=60, total_page=3),   # 满页 20
        2: _page(2, list(range(1001, 1011)), total=60, total_page=3),   # 降级：第 1 页前 10 条
        3: _page(3, list(range(1001, 1011)), total=60, total_page=3),   # 不应被请求
    })
    monkeypatch.setattr(fmod, "fetch_followed_page", pager)

    r = fmod.collect_all_followed("SESS")

    assert r["degraded"] is True
    assert r["end_reason"] == fmod.END_DEGRADED
    assert r["ok"] is False
    assert r["pages"] == [1, 2] == pager.calls   # 中止，没碰第 3 页
    assert r["page_counts"] == [20, 10]
    # 已采部分仍合并去重后带回（第 2 页全是重复，净剩第 1 页 20 条）
    assert len(r["items"]) == 20
    assert [i["room_id"] for i in r["items"]] == list(range(1001, 1021))


def test_collect_partial_last_page_is_not_degraded(monkeypatch):
    """末页不足 page_size 属正常残页，不误报降级。"""
    pager = _pager({
        1: _page(1, list(range(1001, 1021)), total=25, total_page=2),
        2: _page(2, list(range(1021, 1026)), total=25, total_page=2),
    })
    monkeypatch.setattr(fmod, "fetch_followed_page", pager)

    r = fmod.collect_all_followed("SESS")

    assert r["end_reason"] == fmod.END_COMPLETE
    assert r["degraded"] is False and r["ok"] is True
    assert r["page_counts"] == [20, 5]
    assert len(r["items"]) == 25


# 凭证失效

@pytest.mark.parametrize("code", [-101, -111])
def test_collect_auth_invalid_distinct_end_reason(monkeypatch, code):
    """-101 / -111 凭证失效：end_reason=auth_invalid，error_code 保留原业务码。"""
    def fake(sessdata, page=1):
        raise fmod.FollowingError("登录态无效或已过期", code)

    monkeypatch.setattr(fmod, "fetch_followed_page", fake)
    r = fmod.collect_all_followed("SESS")

    assert r["end_reason"] == fmod.END_AUTH
    assert r["ok"] is False and r["degraded"] is False
    assert r["error_code"] == code
    assert "过期" in r["error"]
    assert r["pages"] == [] and r["items"] == []


def test_collect_auth_invalid_keeps_partial_items(monkeypatch):
    """第二页才失效：第一页已采到的条目保留，中止原因仍是凭证失效。"""
    page1 = _page(1, list(range(1001, 1021)), total=25, total_page=2)

    def fake(sessdata, page=1):
        if page == 1:
            return page1
        raise fmod.FollowingError("登录态无效或已过期", -101)

    monkeypatch.setattr(fmod, "fetch_followed_page", fake)
    r = fmod.collect_all_followed("SESS")

    assert r["end_reason"] == fmod.END_AUTH
    assert r["error_code"] == -101
    assert r["pages"] == [1] and r["page_counts"] == [20]
    assert [i["room_id"] for i in r["items"]] == list(range(1001, 1021))


# 页码非法（与凭证失效可区分）

def test_collect_invalid_page_error_is_distinct(monkeypatch):
    """页码非法（code=400）映射为 error 而非 auth_invalid，error_code 不混淆。"""
    def fake(sessdata, page=1):
        raise fmod.FollowingError(f"页码非法：{page}", 400)

    monkeypatch.setattr(fmod, "fetch_followed_page", fake)
    r = fmod.collect_all_followed("SESS")

    assert r["end_reason"] == fmod.END_ERROR
    assert r["end_reason"] != fmod.END_AUTH
    assert r["error_code"] == 400
    assert r["error_code"] not in fmod.AUTH_INVALID_CODES
    assert r["ok"] is False


def test_collect_network_error_maps_to_generic_error(monkeypatch):
    """无业务码的网络失败：end_reason=error，error_code 为 None。"""
    def fake(sessdata, page=1):
        raise fmod.FollowingError("关注列表请求失败：timeout")

    monkeypatch.setattr(fmod, "fetch_followed_page", fake)
    r = fmod.collect_all_followed("SESS")

    assert r["end_reason"] == fmod.END_ERROR
    assert r["error_code"] is None
    assert r["ok"] is False
