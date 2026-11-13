# Adapted from OmniScraper, Copyright (c) 2026 BeatAPI. MIT; see LICENSE-OmniScraper.
import re
import xml.etree.ElementTree as ET
from core import attempt, get, strip_html, ts, meta_tag, Fail
NAME, MATCH = "medium", r"medium\.com/|\.medium\.com"
CE = "{http://purl.org/rss/1.0/modules/content/}encoded"


def scrape(res, o):
    m = re.search(r"medium\.com/(@[^/?]+)", res.url) or re.search(r"//([a-z0-9-]+)\.medium\.com", res.url)
    feed = f"https://medium.com/feed/{m.group(1)}" if m and m.group(1).startswith("@") else (f"https://{m.group(1)}.medium.com/feed" if m else None)
    slug = res.url.split("?")[0].rstrip("/").split("-")[-1]

    def rss():
        if not feed:
            raise Fail("no author in URL")
        root = ET.fromstring(get(feed).content)
        its = root.findall("channel/item")
        hit = [i for i in its if slug and slug in (i.find("link").text or "")]
        if hit or "/@" in res.url and res.url.rstrip("/").endswith(m.group(1)):
            it = (hit or its)[0]
            ce = it.find(CE).text or ""
            res.title, res.author, res.published = it.find("title").text, it.find("{http://purl.org/dc/elements/1.1/}creator").text, ts(it.find("pubDate").text) if False else it.find("pubDate").text
            res.text = strip_html(ce); res.images = re.findall(r'<img[^>]+src="([^"]+)"', ce)
            if not hit:
                res.items = [{"title": i.find("title").text, "url": i.find("link").text, "time": i.find("pubDate").text} for i in its]
        else:
            raise Fail("article not in latest RSS items")

    def og():
        h = get(res.url).text
        res.title = meta_tag(h, "og:title"); res.text = meta_tag(h, "og:description"); res.author = meta_tag(h, "author")
        if meta_tag(h, "og:image"):
            res.images.append(meta_tag(h, "og:image"))
        if not res.title:
            raise Fail("blocked")
    attempt(res, "content", [("author RSS (full text)", rss), ("article OpenGraph (summary only)", og)])
