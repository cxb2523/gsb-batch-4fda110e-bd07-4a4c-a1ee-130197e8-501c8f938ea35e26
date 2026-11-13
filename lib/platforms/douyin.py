# Adapted from OmniScraper, Copyright (c) 2026 BeatAPI. MIT; see LICENSE-OmniScraper.
import re, json, html
from core import requests
from core import attempt, get, session, ts, Fail, UA_ANDROID, UA_GOOGLEBOT, UA_DESKTOP, CURRENT
NAME, MATCH = "douyin", r"(douyin\.com|iesdouyin\.com)/"


def guest_ttwid():
    r = requests.post("https://ttwid.bytedance.com/ttwid/union/register/", timeout=20, json={
        "region": "cn", "aid": 1768, "needFid": False, "service": "www.ixigua.com",
        "migrate_info": {"ticket": "", "source": "node"}, "cbUrl": "https://www.ixigua.com", "union": True})
    return r.cookies.get("ttwid")


def find_item(o):
    if isinstance(o, dict):
        if "aweme_id" in o and ("video" in o or "images" in o):
            return o
        for v in o.values():
            r = find_item(v)
            if r:
                return r
    elif isinstance(o, list):
        for v in o:
            r = find_item(v)
            if r:
                return r


def scrape(res, o):
    if "v.douyin.com" in res.url:
        res.url = session(UA_ANDROID).get(res.url, timeout=20).url
    vid = (re.search(r"(?:video|note|share/video|share/note|modal_id=)/?(\d{15,20})", res.url) or [None, None])[1]
    if not vid:
        raise Fail("cannot find aweme id in URL")
    res.url = f"https://www.douyin.com/video/{vid}"

    def share_page():
        s = session(UA_ANDROID, cookies={"ttwid": guest_ttwid()})
        h = s.get(f"https://www.iesdouyin.com/share/video/{vid}/", timeout=20).text
        m = re.search(r"_ROUTER_DATA\s*=\s*(\{.*?\})</script>", h, re.S)
        it = find_item(json.loads(m.group(1))) if m else None
        if not it:
            raise Fail("no item in _ROUTER_DATA")
        res.title = res.text = it.get("desc", "")
        res.author = it["author"]["nickname"]; res.published = ts(it.get("create_time"))
        s_ = it.get("statistics", {}); res.stats = {"likes": s_.get("digg_count"), "comments": s_.get("comment_count"), "shares": s_.get("share_count"), "collects": s_.get("collect_count")}
        v = it.get("video") or {}
        cov = (v.get("origin_cover") or v.get("cover") or {}).get("url_list") or []
        res.images += cov[:1]
        for im in it.get("images") or []:  # 图集 notes
            res.images.append((im.get("url_list") or [None])[-1])
        pa = (v.get("play_addr") or {}).get("url_list") or []
        if pa and not it.get("images"):
            clean_video = getattr(CURRENT.get(), "clean_video", False)  # --clean-video-url
            res.videos.append(pa[0].replace("playwm", "play") if clean_video else pa[0])
        res.extra["referer_ua"] = "android"

    def seo_page():
        h = get(res.url, UA_GOOGLEBOT).text
        d = re.search(r'name="description" content="([^"]*)"', h)
        if not d:
            raise Fail("no SEO description")
        desc = html.unescape(d.group(1)); res.text = desc
        m = re.match(r"(.*?) - (.*?)于(\d{8})发布在抖音，已经收获了(.*?)个喜欢", desc)
        if m:
            res.title, res.author, res.published, res.stats["likes"] = m.group(1), m.group(2), m.group(3), m.group(4)
        c = re.search(r'"commentCount":(\d+)', h)
        if c:
            res.stats["comments"] = int(c.group(1))
        im = re.search(r'https:[^"\\ ]*douyinpic[^"\\ ]*', h)
        if im:
            res.images.append(html.unescape(im.group(0)))
    attempt(res, "content", [("iesdouyin share page (guest ttwid + Android UA)", share_page), ("Googlebot SEO page", seo_page)])
    if o.with_comments:
        res.log("comments", "web API", False, "needs a_bogus signature / Argus risk control"); res.needs_paid.append("comments")
