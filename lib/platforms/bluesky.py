# Adapted from OmniScraper, Copyright (c) 2026 BeatAPI. MIT; see LICENSE-OmniScraper.
import re
from core import attempt, get, ts, Fail
NAME, MATCH = "bluesky", r"bsky\.app/"
API = "https://public.api.bsky.app/xrpc"


def post2(res, p):
    r = p["record"]
    res.title = r.get("text", "")[:80]; res.text = r.get("text", "")
    res.author = f"{p['author'].get('displayName')} (@{p['author']['handle']})"; res.published = ts(r.get("createdAt"))
    res.stats = {"likes": p.get("likeCount"), "reposts": p.get("repostCount"), "replies": p.get("replyCount"), "quotes": p.get("quoteCount")}
    e = p.get("embed") or {}
    res.images += [i["fullsize"] for i in e.get("images", [])] + [i["fullsize"] for i in (e.get("media") or {}).get("images", [])]
    if e.get("playlist"):
        res.videos.append(("ytdlp", res.url))


def scrape(res, o):
    m = re.search(r"profile/([^/]+)(?:/post/([a-z0-9]+))?", res.url)
    actor, rkey = m.group(1), m.group(2)

    def thread():
        d = get(f"{API}/app.bsky.feed.getPostThread", params={"uri": f"at://{actor}/app.bsky.feed.post/{rkey}", "depth": 1}).json()
        if "thread" not in d:
            raise Fail(d.get("message"))
        post2(res, d["thread"]["post"])
        res.comments = [{"author": r["post"]["author"]["handle"], "text": r["post"]["record"].get("text"), "likes": r["post"].get("likeCount"), "time": ts(r["post"]["record"].get("createdAt"))} for r in d["thread"].get("replies", []) if "post" in r][:50]

    def feed():
        d = get(f"{API}/app.bsky.feed.getAuthorFeed", params={"actor": actor, "limit": 30}).json()
        res.title = f"@{actor} feed"; res.author = "@" + actor
        res.items = [{"time": ts(f["post"]["record"].get("createdAt")), "title": f["post"]["record"].get("text", "")[:200], "url": f"https://bsky.app/profile/{f['post']['author']['handle']}/post/{f['post']['uri'].split('/')[-1]}", "stats": f"likes {f['post'].get('likeCount')}"} for f in d.get("feed", [])]
        if not res.items:
            raise Fail("empty feed")
    attempt(res, "content", [("public AppView getPostThread", thread)] if rkey else [("public AppView getAuthorFeed", feed)])
