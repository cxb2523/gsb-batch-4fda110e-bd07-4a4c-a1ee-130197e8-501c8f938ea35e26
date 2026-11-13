"""Offline tests for comment collection across paginated comment pages.

Every test builds its own Reddit-shaped HTML locally (``shreddit-post``,
``shreddit-comment`` and pagination partials) and replaces the instance
``get``/``post`` methods with fakes, so nothing touches the network.
"""

import asyncio
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reddrix import Reddrix

POST_URL = "https://www.reddit.com/r/test/comments/p1/title/"


# --------------------------------------------------------------------------- #
# HTML fixture builders
# --------------------------------------------------------------------------- #

def post_html(post_id: str = "p1") -> str:
    return f"""
    <shreddit-post id="t3_{post_id}" permalink="/r/test/comments/{post_id}/title/"
        created-timestamp="2024-01-01T00:00:00" post-type="text"
        post-title="Test post"
        author="alice" score="10" comment-count="5" upvote-ratio="0.9"
        subreddit-prefixed-name="r/test">
        <div id="t3_{post_id}-post-rtjson-content">post body</div>
    </shreddit-post>
    """


def comment_html(
    thing_id: str,
    depth: int = 0,
    author: str = "user",
    post_id: str = "p1",
    fold_more_token: str = None,
    fold_more_parent_depth: int = None,
) -> str:
    """Builds a ``shreddit-comment`` with an optional single-thread "more" link."""
    more = ""
    if fold_more_token:
        more = (
            f'<div class="fold-more"><a class="more-comments-link" '
            f'href="https://www.reddit.com/r/test/comments/{post_id}/title/'
            f'{fold_more_token}/">more</a></div>'
        )
    return f"""
    <shreddit-comment thingid="{thing_id}" depth="{depth}" author="{author}"
        score="5" permalink="/r/test/comments/{post_id}/title/{thing_id}/"
        created="2024-01-01T00:00:00" postid="{post_id}">
        <div id="{thing_id}-post-rtjson-content">{thing_id} body</div>
        {more}
    </shreddit-comment>
    """


def children_partial(token: str, cursor: str) -> str:
    """Builds the ``#comment-children`` pagination partial fetched with a POST cursor."""
    return f"""
    <div id="comment-children">
        <faceplate-partial slot="children"
            src="https://www.reddit.com/svc/children/{token}/">
            <input name="cursor" value="{cursor}">
        </faceplate-partial>
    </div>
    """


def page(*fragments: str) -> str:
    return "<html><body>" + "".join(fragments) + "</body></html>"


# --------------------------------------------------------------------------- #
# Fake transport
# --------------------------------------------------------------------------- #

class FakeWeb:
    """Replaces ``Reddrix.get`` / ``Reddrix.post`` for a single post."""

    def __init__(self, initial_html: str):
        self.initial_html = initial_html
        self.get_pages = {}
        self.post_pages = {}

    def serve_get(self, token: str, html: str):
        self.get_pages[token] = html
        return self

    def serve_post(self, cursor: str, html: str):
        self.post_pages[cursor] = html
        return self

    async def get(self, url, params={}):
        for token, html in self.get_pages.items():
            if token in url:
                return html
        return self.initial_html

    async def post(self, url, params={}, json_data={}, form_data={}):
        return self.post_pages[form_data["cursor"]]


class YieldingQueue:
    """Stand-in for the scraper's internal items queue.

    A real bounded queue suspends producers whenever it is saturated. This shim
    recreates that suspension point on every ``put`` so the interleaving between
    concurrent pagination sub-tasks is deterministic instead of timing dependent.
    """

    def __init__(self):
        self._items = None

    async def put(self, item):
        if self._items is None:
            self._items = asyncio.Queue()
        await asyncio.sleep(0)  # the suspension point a full queue would cause
        await self._items.put(item)

    async def get(self):
        if self._items is None:
            self._items = asyncio.Queue()
        return await self._items.get()


def run_scraper(web: FakeWeb, queue_factory=None, **kwargs) -> list[dict]:
    """Drives ``get_items()`` end to end against the fake transport."""
    reddrix = Reddrix(
        mode="standard",
        post_urls=[POST_URL],
        include_comments=True,
        **kwargs,
    )
    # Bypass the decorated network methods (and therefore the retry machinery).
    reddrix.get = web.get
    reddrix.post = web.post

    async def collect():
        if queue_factory is not None:
            # Name-mangled private attribute of Reddrix.__init__.
            reddrix._Reddrix__items_queue = queue_factory()
        items = []
        async for item in reddrix.get_items():
            items.append(item)
        return items

    # Remove the anti-bot jitter so the suite stays fast.
    original_uniform = random.uniform
    random.uniform = lambda low, high: 0.0
    try:
        return asyncio.run(collect())
    finally:
        random.uniform = original_uniform


def comments_of(items: list[dict]) -> list[dict]:
    return [item for item in items if item["submissionType"] == "comment"]


def by_id(comments: list[dict]) -> dict[str, dict]:
    return {item["submissionId"]: item for item in comments}


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #

def test_normal_single_post_collects_comment_tree_with_real_depths():
    """One post, a first page plus one single-thread "more comments" page."""
    initial = page(
        post_html(),
        comment_html("t1_c1", depth=0),
        # A reply whose hidden children live on their own paginated page.
        comment_html("t1_c2", depth=1, fold_more_token="c2-children"),
        comment_html("t1_c3", depth=0),
        # Deleted comments keep being skipped by the existing rule.
        comment_html("t1_deleted_bracket", depth=1, author="[deleted]"),
        comment_html("t1_deleted_word", depth=1, author="deleted"),
    )
    child = page(
        # Depths on this page are relative to its parent (t1_c2 at depth 1).
        comment_html("t1_c4", depth=1),
    )

    web = FakeWeb(initial).serve_get("c2-children", child)
    items = run_scraper(web)

    posts = [item for item in items if item["submissionType"] == "post"]
    comments = comments_of(items)

    assert [item["submissionId"] for item in posts] == ["p1"]

    found = by_id(comments)
    assert set(found) == {"c1", "c2", "c3", "c4"}
    assert len(comments) == 4, "every unique comment is emitted exactly once"
    assert found["c1"]["depth"] == 0
    assert found["c2"]["depth"] == 1
    assert found["c3"]["depth"] == 0
    assert found["c4"]["depth"] == 2, "depth offset of the sub-page is applied"
    assert "deleted_bracket" not in found and "deleted_word" not in found


def test_duplicate_comments_are_emitted_once_keeping_first_depth():
    """The same thingid reached through several pages must be emitted once."""
    initial = page(
        post_html("p2"),
        comment_html("t1_c1", depth=0, post_id="p2"),
        comment_html("t1_c2", depth=0, post_id="p2"),
        comment_html("t1_c3", depth=1, post_id="p2"),
        children_partial("dup-children", "cursor-dup"),
    )
    children = page(
        # Shared children pages overlap with their parent page: c2 and c3 are
        # re-served, and c3 arrives with a page-relative depth of 0.
        comment_html("t1_c2", depth=0, post_id="p2"),
        comment_html("t1_c3", depth=0, post_id="p2"),
        comment_html("t1_c4", depth=0, post_id="p2"),
    )

    web = FakeWeb(initial).serve_post("cursor-dup", children)
    # Sub-tasks are spawned in arbitrary order; a yielding queue makes every
    # pagination page interleave so duplicate delivery is exercised.
    items = run_scraper(web, queue_factory=YieldingQueue)

    comments = comments_of(items)
    found = by_id(comments)

    assert set(found) == {"c1", "c2", "c3", "c4"}
    assert len(comments) == 4, "no comment is emitted twice"
    assert found["c1"]["depth"] == 0
    assert found["c2"]["depth"] == 0
    assert found["c3"]["depth"] == 1, "the first occurrence keeps its depth"
    assert found["c4"]["depth"] == 0


def test_concurrent_pages_cannot_break_comment_and_top_comment_limits():
    """Caps hold when several pagination sub-tasks contribute at once."""
    initial = page(
        post_html("p3"),
        comment_html("t1_t1", depth=0, post_id="p3"),
        comment_html("t1_t2", depth=0, post_id="p3"),
        comment_html("t1_t3", depth=0, post_id="p3"),
        comment_html("t1_r1", depth=1, post_id="p3"),
        comment_html("t1_r2", depth=1, post_id="p3"),
        children_partial("cap-children-a", "cursor-a"),
        children_partial("cap-children-b", "cursor-b"),
    )
    page_a = page(
        comment_html("t1_a_top", depth=0, post_id="p3"),
        comment_html("t1_a_reply", depth=1, post_id="p3"),
    )
    page_b = page(
        comment_html("t1_b_top", depth=0, post_id="p3"),
        comment_html("t1_b_reply", depth=1, post_id="p3"),
    )

    web = FakeWeb(initial)
    web.serve_post("cursor-a", page_a).serve_post("cursor-b", page_b)

    items = run_scraper(
        web,
        queue_factory=YieldingQueue,
        max_comments_per_post=6,
        max_top_comments_per_post=3,
    )

    comments = comments_of(items)
    top_level = [item for item in comments if item["depth"] == 0]

    assert len(comments) == 6, "max_comments_per_post must not be exceeded"
    assert len(top_level) == 3, "max_top_comments_per_post must not be exceeded"
    # The three top-level comments are the ones seen on the initial page.
    assert {item["submissionId"] for item in top_level} == {"t1", "t2", "t3"}
    # The sixth slot is a reply; replies are not counted as top comments.
    assert any(item["depth"] > 0 for item in comments)
    assert all(item["depth"] <= 1 for item in comments)


def test_top_comment_limit_is_independent_from_total_limit():
    """Replies stay collectible after the top-level budget is exhausted."""
    initial = page(
        post_html("p4"),
        comment_html("t1_t1", depth=0, post_id="p4"),
        children_partial("top-children-a", "cursor-top-a"),
        children_partial("top-children-b", "cursor-top-b"),
    )
    page_a = page(
        comment_html("t1_a_top", depth=0, post_id="p4"),
        comment_html("t1_a_reply", depth=1, post_id="p4"),
    )
    page_b = page(
        comment_html("t1_b_top", depth=0, post_id="p4"),
        comment_html("t1_b_reply", depth=1, post_id="p4"),
    )

    web = FakeWeb(initial)
    web.serve_post("cursor-top-a", page_a).serve_post("cursor-top-b", page_b)

    items = run_scraper(
        web,
        queue_factory=YieldingQueue,
        max_comments_per_post=3,
        max_top_comments_per_post=1,
    )

    comments = comments_of(items)
    top_level = [item for item in comments if item["depth"] == 0]

    assert len(comments) == 3
    assert [item["submissionId"] for item in top_level] == ["t1"]
    assert sum(1 for item in comments if item["depth"] > 0) == 2


def test_depth_limit_uses_original_depth_across_nested_pages():
    """Nested "more comments" pages must accumulate their depth offsets."""
    initial = page(
        post_html("p5"),
        comment_html("t1_c1", depth=0, post_id="p5"),
        comment_html("t1_c2", depth=1, post_id="p5", fold_more_token="c2-thread"),
        comment_html("t1_c9", depth=2, post_id="p5"),
        comment_html("t1_c10", depth=3, post_id="p5"),
    )
    first_child_page = page(
        # Single-thread pages repeat the parent comment at relative depth 0; it
        # is deduplicated by thingid, and `<a class="more-comments-link">` sits
        # inside that repeated node, so the child page is reached through it.
        comment_html("t1_c2", depth=0, post_id="p5", fold_more_token="c2-children"),
        # Real depth 2 (offset 1 + relative 1): filtered by max depth 1.
        comment_html("t1_c3", depth=1, post_id="p5"),
    )
    second_child_page = page(
        # The offset must stay 1 (real depth of the repeated parent); if the
        # repeated parent were treated as a page-local depth 0 the offset would
        # collapse and this real depth 2 comment would appear as depth 1.
        comment_html("t1_c4", depth=1, post_id="p5"),
    )

    web = FakeWeb(initial)
    web.serve_get("c2-thread", first_child_page)
    web.serve_get("c2-children", second_child_page)

    items = run_scraper(web, queue_factory=YieldingQueue, max_comments_depth=1)

    comments = comments_of(items)
    found = by_id(comments)

    assert set(found) == {"c1", "c2"}
    assert len(comments) == 2
    assert found["c1"]["depth"] == 0
    assert found["c2"]["depth"] == 1
    assert all(item["depth"] <= 1 for item in comments)
    assert "c3" not in found, "comments below a repeated parent must keep their real depth"
    assert "c4" not in found, "nested sub-page comments must not slip past the depth limit"
    assert "c9" not in found and "c10" not in found
