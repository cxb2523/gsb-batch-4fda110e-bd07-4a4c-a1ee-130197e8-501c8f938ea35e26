# Adapted from OmniScraper, Copyright (c) 2026 BeatAPI. MIT; see LICENSE-OmniScraper.
import re
from urllib.parse import urlparse
from core import attempt, get, ts, Fail
NAME, MATCH = "substack", r"substack\.com/|/p/[a-z0-9-]+"


def scrape(res, o):
    u = urlparse(res.url); base = f"{u.scheme}://{u.netloc}"
    slug = (re.search(r"/p/([^/?#]+)", res.url) or [None, None])[1]
    pid = {}

    def api():
        if slug:
            p = get(f"{base}/api/v1/posts/{slug}").json()
            res.extra['paywall'] = bool(p.get('audience') in ('only_paid', 'founding', 'paid') or p.get('paywall'))
            if res.extra['paywall']:
                # Public preview only; never request a paid-body endpoint.
                p['body_html'] = ''
            pid["id"] = p["id"]
            res.title = p["title"]; res.author = ", ".join(a["name"] for a in p.get("publishedBylines", []))
            res.published = ts(p["post_date"]); res.text = re.sub(r"<[^>]+>", "", p.get("body_html") or p.get("truncated_body_text") or "")
            res.stats = {"likes": p.get("reaction_count"), "comments": p.get("comment_count"), "restacks": p.get("restacks")}
            if p.get("cover_image"):
                res.images.append(p["cover_image"])
            if p.get("podcast_url"):
                res.videos.append(p["podcast_url"])
        else:
            ps = get(f"{base}/api/v1/posts?limit=20").json()
            res.title = base
            res.items = [{"title": p["title"], "url": p["canonical_url"], "time": ts(p["post_date"]), "stats": f"likes {p.get('reaction_count')} comments {p.get('comment_count')}"} for p in ps]
    attempt(res, "content", [("Substack public /api/v1/posts", api)])
    if o.with_comments and pid:
        def cm():
            d = get(f"{base}/api/v1/post/{pid['id']}/comments?all_comments=true&sort=best_first").json()
            res.comments = [{"author": c.get("name"), "text": c.get("body"), "likes": c.get("reaction_count"), "time": ts(c.get("date"))} for c in d.get("comments", [])]
            if not res.comments:
                raise Fail("no comments")
        attempt(res, "comments", [("/api/v1/post/<id>/comments", cm)])
