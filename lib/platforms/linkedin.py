# Adapted from OmniScraper, Copyright (c) 2026 BeatAPI. MIT; see LICENSE-OmniScraper.
import re, json, html
from core import attempt, get, meta_tag, ts, Fail
NAME, MATCH = "linkedin", r"linkedin\.com/"


def scrape(res, o):
    def jsonld():
        r = get(res.url)
        if "authwall" in r.url or "login" in r.url:
            raise Fail("authwall (personal profiles/search need login)")
        h = r.text
        posts = []
        for m in re.findall(r'<script type="application/ld\+json">(.*?)</script>', h, re.S):
            d = json.loads(m)
            for g in d.get("@graph", [d]):
                if g.get("@type") in ("SocialMediaPosting", "Article", "NewsArticle", "DiscussionForumPosting", "VideoObject"):
                    posts.append(g)
                elif g.get("@type") == "Organization" and not res.title:
                    res.title = g.get("name", ""); res.text = g.get("description", "")
        def stat(p):
            i = p.get("interactionStatistic")
            i = i if isinstance(i, list) else [i] if i else []
            return {x.get("interactionType", "").split("/")[-1]: x.get("userInteractionCount") for x in i}
        if "/posts/" in res.url or "/pulse/" in res.url or "/feed/update/" in res.url:
            if not posts:
                raise Fail("no JSON-LD post")
            p = posts[0]
            res.title = p.get("headline") or (p.get("text") or "")[:80]; res.text = p.get("text") or p.get("articleBody") or p.get("description") or p.get("caption") or ""
            if isinstance(res.text, dict): res.text = res.text.get("text", "")
            res.comments = [{"author": (c.get("author") or {}).get("name"), "text": c.get("text"), "time": ts(c.get("datePublished"))} for c in (p.get("comment") or []) if isinstance(c, dict)]
            a = p.get("author") or p.get("creator") or {}; res.author = a.get("name", "") if isinstance(a, dict) else str(a)
            res.published = ts(p.get("datePublished")); res.stats = stat(p); res.stats["comments"] = p.get("commentCount")
        else:
            res.title = res.title or meta_tag(h, "og:title")
            for p in posts:
                res.items.append({"time": ts(p.get("datePublished")), "title": (p.get("text") or "")[:200], "url": p.get("mainEntityOfPage") or p.get("url"), "stats": stat(p)})
        img = meta_tag(h, "og:image")
        if img:
            res.images.append(img)
        if not (res.title or res.items):
            raise Fail("nothing parsed")
    attempt(res, "content", [("guest page JSON-LD", jsonld)])
    if o.with_comments and not res.comments:
        res.needs_paid.append("comments")
