# Adapted from OmniScraper, Copyright (c) 2026 BeatAPI. MIT; see LICENSE-OmniScraper.
import re, json
from core import attempt, get, ts, Fail
NAME, MATCH = "x", r"(twitter\.com|x\.com)/"


def scrape(res, o):
    tid = (re.search(r"/status/(\d+)", res.url) or [None, None])[1]
    user = (re.search(r"(?:twitter|x)\.com/([A-Za-z0-9_]{1,15})/?(?:$|\?)", res.url) or [None, None])[1]

    def tweet():
        d = get(f"https://cdn.syndication.twimg.com/tweet-result?id={tid}&token=4&lang=en").json()
        res.title = d["text"][:80]; res.text = d["text"]
        res.author = f'{d["user"]["name"]} (@{d["user"]["screen_name"]})'; res.published = ts(d["created_at"])
        res.stats = {"likes": d.get("favorite_count"), "replies": d.get("conversation_count")}
        for m in d.get("mediaDetails") or []:
            res.images.append(m["media_url_https"])
            vs = [v for v in (m.get("video_info") or {}).get("variants", []) if v.get("content_type") == "video/mp4"]
            if vs:
                res.videos.append(max(vs, key=lambda v: v.get("bitrate", 0))["url"])
        if d.get("photos"):
            res.images += [p["url"] for p in d["photos"] if p["url"] not in res.images]

    def timeline():
        h = get(f"https://syndication.twitter.com/srv/timeline-profile/screen-name/{user}").text
        m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', h)
        if not m:
            raise Fail("no __NEXT_DATA__")
        ents = json.loads(m.group(1))["props"]["pageProps"]["timeline"]["entries"]
        res.title = f"@{user} timeline"; res.author = "@" + user
        for e in ents:
            t = e.get("content", {}).get("tweet")
            if t:
                res.items.append({"time": ts(t["created_at"]), "title": t.get("full_text", ""), "url": f"https://x.com/{user}/status/{t['id_str']}", "stats": f"likes {t.get('favorite_count')}"})
        if not res.items:
            raise Fail("empty timeline")
    if tid:
        attempt(res, "content", [("syndication tweet-result", tweet)])
    elif user:
        attempt(res, "profile", [("syndication timeline-profile", timeline)])
    if o.with_comments and tid:
        res.needs_paid.append("comments")
