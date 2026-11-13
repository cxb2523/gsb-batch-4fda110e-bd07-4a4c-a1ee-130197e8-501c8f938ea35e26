# Adapted from OmniScraper, Copyright (c) 2026 BeatAPI. MIT; see LICENSE-OmniScraper.
import re, html
from core import attempt, get, strip_html, ts, Fail
NAME, MATCH = "telegram", r"(t\.me|telegram\.me)/"


def parse(b):
    t = re.search(r'tgme_widget_message_text[^>]*>(.*?)</div>', b, re.S)
    v = re.search(r'tgme_widget_message_views">([^<]*)', b)
    d = re.search(r'datetime="([^"]+)"', b)
    p = re.search(r'data-post="([^"]+)"', b)
    im = re.findall(r"background-image:url\('([^']+)'\)", b)
    return {"text": strip_html(t.group(1)) if t else "", "views": v.group(1) if v else None, "time": ts(d.group(1)) if d else "", "post": p.group(1) if p else "",
            "images": [("https:" + i if i.startswith("//") else i) for i in im if "photo" in b]}


def scrape(res, o):
    m = re.search(r"t\.me/(?:s/)?([A-Za-z0-9_]+)(?:/(\d+))?", res.url)
    ch, mid = m.group(1), m.group(2)

    def page():
        url = f"https://t.me/s/{ch}" + (f"?before={int(mid) + 1}" if mid else "")
        h = get(url).text
        blocks = [parse(b) for b in h.split("tgme_widget_message_wrap")[1:]]
        if not blocks:
            raise Fail("no public preview (private channel?)")
        res.author = "@" + ch
        if mid:
            b = next((x for x in blocks if x["post"].endswith("/" + mid)), None)
            if b is None:
                raise Fail('指定消息未出现在公开预览；不返回附近消息冒充')
            res.title = b["text"][:80]; res.text = b["text"]; res.published = b["time"]; res.stats = {"views": b["views"]}; res.images = b["images"]
        else:
            res.title = f"@{ch} channel"
            res.items = [{"time": x["time"], "title": x["text"][:200], "url": "https://t.me/" + x["post"], "stats": f"views {x['views']}"} for x in blocks]
    attempt(res, "content", [("t.me/s web preview", page)])
