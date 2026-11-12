import unittest
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import relinos.scraping_api as api


class LocalPageServer:
    """
    Serves a small paginated site on 127.0.0.1 so the tests never touch the internet.
    Every request path is recorded so tests can assert what was actually fetched.
    """

    def __init__(self, totalPages: int):
        self.totalPages = totalPages
        self.requests: list[str] = []

        server = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                path = self.path.split("?", 1)[0]
                server.requests.append(path)

                match = re.fullmatch(r"/page(\d+)", path)
                if path == "/" or path == "/page1":
                    n = 1
                elif match:
                    n = int(match.group(1))
                else:
                    self.send_response(404)
                    self.end_headers()
                    return

                data = server.pageHtml(n).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, format: str, *args: object) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def pageHtml(self, n: int) -> str:
        body = f"<html><body><h1>page{n}</h1><p>content of page {n}</p>"
        if n < self.totalPages:
            body += f"<a id='next' href='/page{n + 1}'>next</a>"
        elif self.deadNextLinkOnLastPage:
            # matches sites whose "next" control loses its href on the last page
            body += "<a id='next'>next</a>"
        body += "</body></html>"
        return body

    deadNextLinkOnLastPage = False

    def url(self, n: int = 1) -> str:
        return f"http://127.0.0.1:{self.port}/page{n}"

    def reset(self) -> None:
        self.requests.clear()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


class PaginationCacheTestCase(unittest.IsolatedAsyncioTestCase):
    totalPages = 6
    deadNextLinkOnLastPage = False

    def setUp(self) -> None:
        self.server = LocalPageServer(self.totalPages)
        self.server.deadNextLinkOnLastPage = self.deadNextLinkOnLastPage

        self.tmpDir = tempfile.mkdtemp()
        self.origCacheDirPath = api.cacheDirPath
        self.origCacheDBPath = api.cacheDBPath
        api.cacheDirPath = os.path.join(self.tmpDir, "cache")
        api.cacheDBPath = os.path.join(self.tmpDir, "cache.db")
        os.makedirs(api.cacheDirPath, exist_ok=True)
        api.createCache()

    def tearDown(self) -> None:
        self.server.stop()
        api.cacheDirPath = self.origCacheDirPath
        api.cacheDBPath = self.origCacheDBPath
        shutil.rmtree(self.tmpDir, ignore_errors=True)

    async def fetch(self, pages: int, maxCacheAge: int) -> tuple[list[str], list[str], list[str]]:
        self.server.reset()
        pagination = api.Pagination("//a[@id='next']", str(pages), "0")
        return await api.getMulti(self.server.url(), pagination=pagination, maxCacheAge=maxCacheAge)

    def markerSignature(self, pages: int) -> str:
        # build the marker key independently of the implementation under test, it is
        # defined as the pagination signature root plus the page count
        root = (
            self.server.url()
            + "::::" + api.generateSignature([])
            + "::::" + api.generateSignature(False)
        )
        return root + "::::" + str(pages)

    def markerExists(self, pages: int, maxAgeSeconds: int = 600) -> bool:
        found, _, _, _ = api.getCache(self.markerSignature(pages), maxAgeSeconds=maxAgeSeconds)
        return found

    def assertResult(self, result: tuple[list[str], list[str], list[str]], expectedPages: int) -> None:
        htmlStrs, finalUrls, signatureStrs = result
        self.assertEqual(len(htmlStrs), expectedPages)
        self.assertEqual(len(finalUrls), expectedPages)
        self.assertEqual(len(signatureStrs), expectedPages)
        self.assertEqual(len(set(signatureStrs)), expectedPages)
        self.assertEqual(sorted(len(r) for r in result), [expectedPages] * 3)

    def assertLastPage(self, result: tuple[list[str], list[str], list[str]], page: int) -> None:
        htmlStrs, finalUrls, _ = result
        self.assertTrue(finalUrls[-1].endswith(f"/page{page}"), finalUrls[-1])
        self.assertIn(f"content of page {page}", htmlStrs[-1])


class TestPaginationCache(PaginationCacheTestCase):
    totalPages = 6

    async def testMarkerHitReusesCachedPages(self) -> None:
        first = await self.fetch(3, maxCacheAge=600)
        self.assertResult(first, 3)
        self.assertLastPage(first, 3)
        self.assertEqual(len(self.server.requests), 3)
        self.assertTrue(self.markerExists(3))

        self.server.reset()
        second = await self.fetch(3, maxCacheAge=600)
        self.assertResult(second, 3)
        self.assertLastPage(second, 3)
        # a matching, unexpired marker means no network access at all
        self.assertEqual(len(self.server.requests), 0)
        self.assertEqual(second[0], first[0])
        self.assertEqual(second[1], first[1])

    async def testExpiredMarkerTriggersRefetch(self) -> None:
        await self.fetch(4, maxCacheAge=600)
        self.assertEqual(len(self.server.requests), 4)
        self.assertTrue(self.markerExists(4))

        # backdate only the virtual markers, the page bodies themselves stay fresh
        old = int(time.time()) - 1200
        with sqlite3.connect(api.cacheDBPath) as conn:
            conn.execute('UPDATE cache SET createdAt=? WHERE isEmpty=1', (old,))
            conn.commit()
        self.assertFalse(self.markerExists(4))

        result = await self.fetch(4, maxCacheAge=600)
        self.assertResult(result, 4)
        self.assertLastPage(result, 4)
        # an expired marker must not be trusted, everything is fetched again
        self.assertEqual(len(self.server.requests), 4)
        self.assertTrue(self.markerExists(4))

    async def testMorePagesThenFewer(self) -> None:
        await self.fetch(4, maxCacheAge=600)
        self.assertEqual(len(self.server.requests), 4)

        # a request for 2 must return 2 pages even though a 4 page marker also exists
        result = await self.fetch(2, maxCacheAge=600)
        self.assertResult(result, 2)
        self.assertLastPage(result, 2)

        # the requested count is served exactly, no matter what was fetched before
        result4 = await self.fetch(4, maxCacheAge=600)
        self.assertResult(result4, 4)
        self.assertLastPage(result4, 4)

    async def testFewerPagesThenMore(self) -> None:
        await self.fetch(2, maxCacheAge=600)
        self.assertEqual(len(self.server.requests), 2)
        self.assertFalse(self.markerExists(4))

        result = await self.fetch(4, maxCacheAge=600)
        self.assertResult(result, 4)
        self.assertLastPage(result, 4)
        # growing the page count requires replaying pagination from page 1
        self.assertEqual(len(self.server.requests), 4)

    async def testMorePagesThenFewerAfterMarkerExpired(self) -> None:
        """ a 4 page marker must not serve a 2 page request once it has expired """
        await self.fetch(4, maxCacheAge=600)

        # expire markers and page bodies together, exactly like a maxCacheAge window ending
        with sqlite3.connect(api.cacheDBPath) as conn:
            conn.execute('UPDATE cache SET createdAt=createdAt-1200')
            conn.commit()

        result = await self.fetch(2, maxCacheAge=600)
        self.assertResult(result, 2)
        self.assertLastPage(result, 2)
        self.assertEqual(len(self.server.requests), 2)

    async def testZeroMaxCacheAgeAlwaysRefetches(self) -> None:
        await self.fetch(3, maxCacheAge=0)
        self.assertEqual(len(self.server.requests), 3)

        # cache=0s must never be served from cache, not even within the same second
        result = await self.fetch(3, maxCacheAge=0)
        self.assertResult(result, 3)
        self.assertLastPage(result, 3)
        self.assertEqual(len(self.server.requests), 3)

    async def testPaginationNoneIsUnchanged(self) -> None:
        result = await api.getMulti(self.server.url(), maxCacheAge=600)
        self.assertResult(result, 1)
        self.assertLastPage(result, 1)
        self.assertEqual(len(self.server.requests), 1)
        # no pagination marker is written for single page requests
        self.assertFalse(self.markerExists(1))


class TestPaginationShortSite(PaginationCacheTestCase):
    """ the last page keeps a 'next' control without an href, so pagination stops early """
    totalPages = 3
    deadNextLinkOnLastPage = True

    async def testMarkerReflectsActuallyFetchedPages(self) -> None:
        result = await self.fetch(8, maxCacheAge=600)
        self.assertResult(result, 3)
        self.assertLastPage(result, 3)
        self.assertEqual(len(self.server.requests), 3)

        # markers describe the pages that really exist, not the requested count
        self.assertTrue(self.markerExists(3))
        self.assertFalse(self.markerExists(4))
        self.assertFalse(self.markerExists(8))

        # and the request for the real page count is then served from cache
        result3 = await self.fetch(3, maxCacheAge=600)
        self.assertResult(result3, 3)
        self.assertLastPage(result3, 3)
        self.assertEqual(len(self.server.requests), 0)

    async def testFewerThanFetchedPagesStillExact(self) -> None:
        await self.fetch(3, maxCacheAge=600)
        result = await self.fetch(2, maxCacheAge=600)
        self.assertResult(result, 2)
        self.assertLastPage(result, 2)


if __name__ == "__main__":
    unittest.main()
