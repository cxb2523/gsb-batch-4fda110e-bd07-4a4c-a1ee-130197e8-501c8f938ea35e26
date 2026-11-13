# Adapted from OmniScraper, Copyright (c) 2026 BeatAPI. MIT; see LICENSE-OmniScraper.
from core import attempt, ytdlp_info, fill_from_ytdlp, get, Fail
import json
NAME, MATCH = "tiktok", r"tiktok\.com/"


def scrape(res, o):
    def ytd():
        fill_from_ytdlp(res, ytdlp_info(res.url, {"getcomments": bool(o.with_comments)}))
    def oembed():
        d = get("https://www.tiktok.com/oembed?url=" + res.url).json()
        res.title, res.author = d.get("title", ""), d.get("author_name", "")
        res.images.append(d.get("thumbnail_url")); res.videos.append(("ytdlp", res.url))
    attempt(res, "content", [("yt-dlp TikTok extractor (play stream = no watermark)", ytd), ("oEmbed", oembed)])
    if o.with_comments and not res.comments:
        res.log("comments", "yt-dlp", False, "0 comments as guest"); res.needs_paid.append("comments")
