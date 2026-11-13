# Adapted from OmniScraper, Copyright (c) 2026 BeatAPI. MIT; see LICENSE-OmniScraper.
from core import attempt, ytdlp_info, fill_from_ytdlp
NAME, MATCH = "instagram", r"instagram\.com/"


def scrape(res, o):
    def ytd():
        info = ytdlp_info(res.url, {"getcomments": bool(o.with_comments)})
        entries = list(info.get("entries") or []) if info.get("_type") == "playlist" else []
        fill_from_ytdlp(res, info)
        if not res.text and not res.stats:
            raise RuntimeError("empty (profile pages need login)")
    attempt(res, "content", [("yt-dlp Instagram extractor (post/reel, guest GraphQL)", ytd)])
    res.extra["note"] = "Public media URLs returned by yt-dlp; signed URLs expire. No account used."
    if o.with_comments and not res.comments:
        res.needs_paid.append("comments")
