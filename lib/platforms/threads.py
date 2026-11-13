# Adapted from OmniScraper, Copyright (c) 2026 BeatAPI. MIT; see LICENSE-OmniScraper.
import re, json, html
from core import attempt, get, meta_tag, ts, Fail, UA_GOOGLEBOT, UA_FBEXT
NAME, MATCH = "threads", r"threads\.(net|com)/"


def scrape(res, o):
    code = (re.search(r"/post/([A-Za-z0-9_-]+)", res.url) or [None, None])[1]

    def crawler(ua):
        def f():
            h = get(res.url.replace("threads.net", "threads.com"), ua).text
            res.title = meta_tag(h, "og:title"); res.text = meta_tag(h, "og:description")
            if meta_tag(h, "og:image"):
                res.images.append(meta_tag(h, "og:image"))
            if not res.title:
                raise Fail("no og tags")
            res.author = (re.search(r"\(@([^)]+)\)", res.title) or [0, ""])[1]
            # SSR JSON: find posts with like_count
            for m in re.finditer(r'"code":"([A-Za-z0-9_-]{8,})".{0,4000}?"like_count":(\d+)', h, re.S):
                if code and m.group(1) == code:
                    res.stats["likes"] = int(m.group(2))
                elif not code:
                    res.items.append({"url": f"{res.url.rstrip('/')}/post/{m.group(1)}", "stats": f"likes {m.group(2)}"})
            t = re.search(r'"taken_at":(\d+)', h)
            if t and code:
                res.published = ts(t.group(1))
        return f
    attempt(res, "content", [("Googlebot UA SSR", crawler(UA_GOOGLEBOT)), ("facebookexternalhit UA og", crawler(UA_FBEXT))])
    if o.with_comments:
        res.needs_paid.append("comments")
