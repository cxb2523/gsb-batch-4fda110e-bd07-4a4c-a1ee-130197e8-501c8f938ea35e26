"""B 站直播关注列表：读取「我关注的主播」及其开播状态（需要登录态）。

接口 /xlive/web-ucenter/user/following 是直播中心「我的关注」数据源，
返回当前账号关注的直播间（开播的排最前），游客调用返回 -101。
与弹幕通道不同：弹幕 WS 游客可连，关注列表属于私有数据，必须带有效 SESSDATA。

分页实测坑（2026-10-15 抓包确认）：
- page_size 只接受小值，20 合法；30/50 会被服务端**静默拒绝**——降级为 10 条/页，
  且连 page 参数一并忽略，任意页码都返回相同的第 1 页 10 条（totalPage 等字段照常，
  极具迷惑性）。因此 PAGE_SIZE 固定 20，禁止调大。
- 缺少风控 cookie（buvid3 等）时即使 page_size=10 也会触发同样的静默降级，
  请求前必须调用 P.init_risk_cookies()。
"""
from __future__ import annotations

import httpx

from . import protocol as P

FOLLOWING_URL = ("https://api.live.bilibili.com/xlive/web-ucenter/"
                 "user/following")
PAGE_SIZE = 20          # 实测合法值；30/50 会被静默降级，禁止调大
MAX_PAGE = 1000         # 参数上限保护，真实总页数由 totalPage 给出


class FollowingError(Exception):
    """关注列表拉取失败。code 为 B 站业务码（如 -101 未登录）。"""

    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


# 批量采集的结束原因（end_reason 取值，前端按此区分展示）
END_COMPLETE = "complete"        # 取满：已拉完全部 total_page 页
END_NO_MORE = "no_more_pages"    # 无更多页：服务端给出空页 / total_page 为 0
END_PAGE_LIMIT = "page_limit"    # 达到本地页数上限（保护性停止，结果可能不完整）
END_DEGRADED = "degraded"        # 疑似静默降级：某页条目数 < page_size 且仍有后续页
END_AUTH = "auth_invalid"        # 凭证失效（-101 / -111）
END_ERROR = "error"              # 其他接口错误（含页码非法 400、网络失败等）

# 视为「正常结束」的结束原因；degraded / auth_invalid / error 均为提前结束
NORMAL_END_REASONS = (END_COMPLETE, END_NO_MORE, END_PAGE_LIMIT)

AUTH_INVALID_CODES = (-101, -111)


def _norm_item(raw: dict) -> dict | None:
    """把关注接口的一条原始记录规整成前端用结构；room_id 非正数返回 None。"""
    room_id = raw.get("roomid") or raw.get("room_id")
    try:
        room_id = int(room_id)
    except (TypeError, ValueError):
        return None
    if room_id <= 0:
        return None
    return {
        "room_id": room_id,
        "uid": int(raw.get("uid") or 0),
        "uname": str(raw.get("uname") or "").strip(),
        "title": str(raw.get("title") or "").strip(),
        # 1=直播中 2=轮播中 0=未开播
        "live_status": int(raw.get("live_status") or 0),
        "face": str(raw.get("face") or "").strip(),
        "live_time": str(raw.get("live_time") or "").strip(),
    }


def fetch_followed_page(sessdata: str, page: int = 1) -> dict:
    """拉取关注列表的单页数据（前端增量加载的数据源）。

    返回：{items, page, page_size, total, total_page, live_count}
    Raises FollowingError: 未登录 / 业务错误 / 网络失败 / 页码非法。
    """
    sessdata = (sessdata or "").strip()
    if not sessdata:
        raise FollowingError("未配置 SESSDATA", -101)
    try:
        page = int(page)
    except (TypeError, ValueError):
        page = 0
    if not 1 <= page <= MAX_PAGE:
        raise FollowingError(f"页码非法：{page}", 400)

    with httpx.Client(
        headers=P.HEADERS,
        cookies={"SESSDATA": sessdata},
        timeout=15, follow_redirects=True,
    ) as client:
        # 必须先拿风控 cookie，缺 buvid3 时分页参数会被服务端静默忽略
        P.init_risk_cookies(client)
        try:
            resp = client.get(FOLLOWING_URL, params={
                "page": page, "page_size": PAGE_SIZE,
            })
            body = resp.json()
        except (httpx.HTTPError, ValueError) as e:
            raise FollowingError(f"关注列表请求失败：{e}") from e

    code = body.get("code")
    if code != 0:
        if code in AUTH_INVALID_CODES:
            raise FollowingError(
                "登录态无效或已过期，请重新到「设置」页填写 SESSDATA",
                code)
        raise FollowingError(
            f"关注列表返回错误（code={code}）："
            f"{str(body.get('message', ''))[:80]}", code)

    data = body.get("data") or {}
    raw_items = data.get("list") or data.get("rooms") or []
    items: list[dict] = []
    seen: set[int] = set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        it = _norm_item(raw)
        if it and it["room_id"] not in seen:
            seen.add(it["room_id"])
            items.append(it)

    total = int(data.get("count") or 0)
    total_page = int(data.get("total_page")
                     or data.get("totalPage") or 0)
    live_count = int(data.get("live_count") or 0)
    return {
        "items": items,
        "page": page,
        "page_size": PAGE_SIZE,
        "total": total,
        "total_page": total_page,
        "live_count": live_count,
    }


def collect_all_followed(sessdata: str, max_pages: int = MAX_PAGE,
                         existing_room_ids=None) -> dict:
    """按页批量采集全部关注直播间，逐页合并去重，直到取满或触发停止条件。

    停止条件（对应 end_reason）：
    - complete      取满：拉完全部 total_page 页；
    - no_more_pages 无更多页：首页即空或 total_page 为 0；
    - page_limit    达到 max_pages 页数上限（保护性停止）；
    - degraded      疑似静默降级：某页条目数 < PAGE_SIZE 且仍有后续页
                    （page_size 被调大或缺风控 cookie 时的典型症状），立即中止，
                    避免拿着残缺的第 1 页副本误以为采完；
    - auth_invalid  凭证失效（-101 / -111）；
    - error         其他接口错误（页码非法 400、网络失败等，error_code 与
                    凭证失效可区分，不会混成同一个失败）。

    返回（不抛 FollowingError，失败也带回已采到的部分结果）：
    {items, pages, page_counts, page_size, total, total_page,
     degraded, end_reason, ok, error, error_code}
    items 每条附带 added 标记（room_id 是否已在 existing_room_ids 中）。
    """
    try:
        max_pages = int(max_pages)
    except (TypeError, ValueError):
        max_pages = MAX_PAGE
    max_pages = max(1, min(MAX_PAGE, max_pages))
    existing = {int(r) for r in (existing_room_ids or [])}

    items: list[dict] = []
    seen: set[int] = set()
    pages: list[int] = []        # 实际请求的页码序列
    page_counts: list[int] = []  # 每页返回的条目数
    total = 0
    total_page = 0
    end_reason = END_COMPLETE
    error: str | None = None
    error_code: int | None = None

    page = 1
    while True:
        try:
            data = fetch_followed_page(sessdata, page)
        except FollowingError as e:
            # 凭证失效与页码非法等其他错误必须可区分：分别映射 end_reason，
            # 原始业务码一律保留在 error_code 里
            if e.code in AUTH_INVALID_CODES:
                end_reason = END_AUTH
            else:
                end_reason = END_ERROR
            error = str(e)
            error_code = e.code
            break
        pages.append(page)
        got = data["items"]
        page_counts.append(len(got))
        total = int(data.get("total") or 0)
        total_page = int(data.get("total_page") or 0)
        for it in got:
            rid = it["room_id"]
            if rid not in seen:
                seen.add(rid)
                items.append({**it, "added": rid in existing})

        if not got and page == 1:
            end_reason = END_NO_MORE      # 首页即空：没有可关注
            break
        # 降级判定：本页条目数不足 page_size 且服务端声称还有后续页。
        # 注意末页本来就可能是残页，必须先看降级再判取满。
        if len(got) < PAGE_SIZE and page < total_page:
            end_reason = END_DEGRADED
            break
        if page >= total_page:
            end_reason = END_COMPLETE     # 取满
            break
        if page >= max_pages:
            end_reason = END_PAGE_LIMIT
            break
        page += 1

    return {
        "items": items,
        "pages": pages,
        "page_counts": page_counts,
        "page_size": PAGE_SIZE,
        "total": total,
        "total_page": total_page,
        "degraded": end_reason == END_DEGRADED,
        "end_reason": end_reason,
        "ok": end_reason in NORMAL_END_REASONS,
        "error": error,
        "error_code": error_code,
    }
