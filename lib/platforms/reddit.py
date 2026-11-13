# Adapted from OmniScraper, Copyright (c) 2026 BeatAPI. MIT; see LICENSE-OmniScraper.
import re, html
import xml.etree.ElementTree as ET
from core import attempt, get, strip_html, ts, Fail
NAME, MATCH = "reddit", r"(reddit\.com|redd\.it)/"
NS = {"a": "http://www.w3.org/2005/Atom", "m": "http://search.yahoo.com/mrss/"}
AS = "https://arctic-shift.photon-reddit.com/api"


def scrape(res, o):
    pid = (re.search(r"/comments/([a-z0-9]+)", res.url) or [None, None])[1]
    base = res.url.split("?")[0].rstrip("/")

    def js():
        r = get(base + ".json?limit=20")
        if r.status_code != 200:
            raise Fail(f"HTTP {r.status_code} (blocked on datacenter IPs)")
        d = r.json()
        if pid:
            p = d[0]["data"]["children"][0]["data"]; post(p)
            res.comments = [{"author": c["data"].get("author"), "text": c["data"].get("body"), "likes": c["data"].get("score")} for c in d[1]["data"]["children"] if c["kind"] == "t1"]
        else:
            for c in d["data"]["children"]:
                p = c["data"]; res.items.append({"title": p["title"], "url": "https://www.reddit.com" + p["permalink"], "time": ts(p["created_utc"]), "stats": f"score {p['score']} comments {p['num_comments']}"})

    def post(p):
        res.title, res.author, res.published = p["title"], "u/" + str(p.get("author")), ts(p["created_utc"])
        res.text = p.get("selftext", ""); res.stats = {"score": p.get("score"), "comments": p.get("num_comments"), "upvote_ratio": p.get("upvote_ratio")}
        u = p.get("url_overridden_by_dest") or p.get("url") or ""
        if re.search(r"\.(jpg|jpeg|png|gif|webp)$", u):
            res.images.append(u)
        elif p.get("preview"):
            res.images.append(html.unescape(p["preview"]["images"][0]["source"]["url"]))

    def txt(e, path):
        x = e.find(path, NS)
        return (x.text or "") if x is not None else ""

    def rss():
        # The subreddit/title URL returns 429 while the post-ID feed works.
        r = get(f"https://www.reddit.com/comments/{pid}/.rss" if pid else base + "/.rss")
        if not r.content.strip():
            raise Fail(f"HTTP {r.status_code} empty (rate limited)")
        root = ET.fromstring(r.content)
        es = root.findall("a:entry", NS)
        if not es:
            raise Fail(f"HTTP {r.status_code} no entries")
        if pid:
            e = next((x for x in es if txt(x, "a:id") == "t3_" + pid), None)
            if e is None:
                raise Fail("RSS did not contain the requested post ID")
            res.title = txt(e, "a:title"); res.author = txt(e, "a:author/a:name")
            res.published = ts(txt(e, "a:updated")); res.text = strip_html(txt(e, "a:content"))
            th = e.find("m:thumbnail", NS)
            if th is not None:
                res.images.append(th.get("url"))
            res.comments = res.comments or [{"author": txt(x, "a:author/a:name"), "text": strip_html(txt(x, "a:content"))} for x in es if x is not e]
        else:
            res.title = root.find("a:title", NS).text
            for e in es:
                res.items.append({"title": e.find("a:title", NS).text, "url": e.find("a:link", NS).get("href"), "time": ts(e.find("a:updated", NS).text)})

    def arctic():
        if not pid:
            raise Fail("post URL only")
        d = get(f"{AS}/posts/ids?ids={pid}").json()["data"]
        if not d:
            raise Fail("not archived yet")
        p = d[0]; keep = (res.title, res.text)
        post(p)
        res.extra["arctic_snapshot_retrieved_on"] = ts(p.get("retrieved_on"))
        if keep[0]:
            res.title, res.text = keep[0], keep[1] or res.text

    def arctic_comments():
        d = get(f"{AS}/comments/search?link_id={pid}&limit=50").json()["data"]
        if not d:
            raise Fail("no archived comments")
        res.comments = [{"author": c["author"], "text": c["body"], "likes": c.get("score"), "time": ts(c["created_utc"])} for c in d]
    attempt(res, "content", [(".rss Atom", rss), (".json suffix", js)])
    if pid and "score" not in res.stats:
        if attempt(res, "stats", [("arctic-shift archive (snapshot)", arctic)]) and "content" in res.needs_paid:
            res.needs_paid.remove("content")
    if o.with_comments and pid and not res.comments:
        attempt(res, "comments", [("arctic-shift comments", arctic_comments)])
