"""Offline tests for the staged free-proxy harvest pipeline.

Every network touchpoint is replaced with a synthetic source response or a
synthetic proxy verdict, so these tests never contact the public proxy sources
or the IP-echo service.
"""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from antidetect import api, proxy

SOURCE_A = "https://fake-a.example/list.txt"
SOURCE_B = "https://fake-b.example/list.txt"


class FakeNetwork:
    """Context manager that replaces harvest's fetch and verify stages."""

    def __init__(self, source_map, verdicts):
        self.source_map = source_map
        self.verdicts = verdicts
        self.tested: list[tuple[str, float]] = []

    def __enter__(self):
        async def fake_fetch(url: str, timeout: float) -> str:
            value = self.source_map[url]
            if isinstance(value, BaseException):
                raise value
            return value

        async def fake_test(px, timeout: float = 15.0):
            hostport = f"{px.host}:{px.port}"
            self.tested.append((hostport, timeout))
            verdict = self.verdicts[hostport]
            if isinstance(verdict, BaseException):
                raise verdict
            return dict(verdict)

        self._fetch_patch = patch.object(proxy, "_fetch_source_text", fake_fetch)
        self._test_patch = patch.object(proxy, "test", fake_test)
        # Belt and braces: prove no HTTP client is constructed in this test.
        self._client_patch = patch.object(
            proxy.httpx, "AsyncClient",
            side_effect=AssertionFailure("harvest tried to open a real connection"),
        )
        self._fetch_patch.start()
        self._test_patch.start()
        self._client_patch.start()
        return self

    def __exit__(self, *exc_info):
        for p in (self._client_patch, self._test_patch, self._fetch_patch):
            p.stop()
        return False


class AssertionFailure(Exception):
    pass


def _normal_verdicts(ok: dict[str, dict], bad: dict[str, str]):
    verdicts = {hp: {"ok": False, "error": msg} for hp, msg in bad.items()}
    for hp, info in ok.items():
        verdicts[hp] = {"ok": True, "latency_ms": 40, **info}
    return verdicts


class HarvestTests(unittest.IsolatedAsyncioTestCase):
    async def test_normal_merge_reports_counts_and_source_attribution(self):
        source_map = {
            SOURCE_A: "1.1.1.1:80\n2.2.2.2:8080\n# comment\nnot-a-proxy\n",
            SOURCE_B: "3.3.3.3:3128\n4.4.4.4:1080\n",
        }
        verdicts = _normal_verdicts(
            ok={"1.1.1.1:80": {"ip": "203.0.113.7", "country": "US"},
                "3.3.3.3:3128": {"ip": "198.51.100.9", "country": "DE"}},
            bad={"2.2.2.2:8080": "ConnectError: refused",
                 "4.4.4.4:1080": "TimeoutException: timed out"},
        )
        with FakeNetwork(source_map, verdicts) as net:
            result = await proxy.harvest(protocol="http", expected=10, verify=True,
                                         total_timeout=2.0, sources=[SOURCE_A, SOURCE_B])

        self.assertEqual(result["fetched"], 4)
        self.assertEqual(result["deduped"], 4)
        self.assertEqual(result["kept"], 4)
        self.assertFalse(result["truncated"])
        self.assertEqual(result["source_failures"], 0)
        self.assertEqual([s["url"] for s in result["sources"]], [SOURCE_A, SOURCE_B])
        for detail in result["sources"]:
            self.assertTrue(detail["ok"])
            self.assertEqual(detail["lines"], 2)
            self.assertEqual(detail["deduped"], 2)
            self.assertEqual(detail["kept"], 2)
            self.assertIsNone(detail["error"])

        self.assertEqual([e["server"] for e in result["available"]],
                         ["http://1.1.1.1:80", "http://3.3.3.3:3128"])
        self.assertEqual(result["available"][0]["country"], "US")
        self.assertEqual([e["server"] for e in result["unavailable"]],
                         ["http://2.2.2.2:8080", "http://4.4.4.4:1080"])
        self.assertEqual(result["unfinished"], [])
        self.assertEqual(result["counts"],
                         {"kept": 4, "available": 2, "unfinished": 0, "unavailable": 2})
        self.assertEqual(
            {s["reason"]: s["count"] for s in result["error_summary"]},
            {"ConnectError": 1, "TimeoutException": 1},
        )
        self.assertEqual(sorted(hp for hp, _ in net.tested), sorted(verdicts))

    async def test_one_failed_source_does_not_stop_the_others(self):
        source_map = {
            SOURCE_A: "1.1.1.1:80\n",
            # Non-2xx: httpx raises HTTPStatusError carrying the response.
            SOURCE_B: proxy.httpx.HTTPStatusError(
                "503 Service Unavailable",
                request=SimpleNamespace(),
                response=SimpleNamespace(status_code=503),
            ),
            "https://fake-c.example/list.txt": "5.5.5.5:80\n",
        }
        verdicts = _normal_verdicts(
            ok={"1.1.1.1:80": {"ip": "203.0.113.7"}, "5.5.5.5:80": {"ip": "203.0.113.8"}},
            bad={},
        )
        urls = [SOURCE_A, SOURCE_B, "https://fake-c.example/list.txt"]
        with FakeNetwork(source_map, verdicts):
            result = await proxy.harvest(expected=10, total_timeout=2.0, sources=urls)

        self.assertEqual(result["source_failures"], 1)
        failed, rest = result["sources"][1], [result["sources"][0], result["sources"][2]]
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["status"], 503)
        self.assertIn("HTTPStatusError", failed["error"])
        self.assertEqual(failed["lines"], 0)
        self.assertEqual(failed["deduped"], 0)
        for detail in rest:
            self.assertTrue(detail["ok"])
        self.assertEqual(result["deduped"], 2)
        self.assertEqual(result["kept"], 2)
        self.assertEqual(len(result["available"]), 2)
        self.assertEqual(result["unfinished"], [])
        self.assertEqual(result["counts"],
                         {"kept": 2, "available": 2, "unfinished": 0, "unavailable": 0})

    async def test_duplicates_keep_first_source_and_truncation_is_reported(self):
        source_map = {
            SOURCE_A: "2.2.2.2:80\n1.1.1.1:80\n2.2.2.2:80\n",
            SOURCE_B: "2.2.2.2:80\n3.3.3.3:80\n",
        }
        verdicts = _normal_verdicts(
            ok={"1.1.1.1:80": {"ip": "203.0.113.7"}, "2.2.2.2:80": {"ip": "203.0.113.8"},
                "3.3.3.3:80": {"ip": "203.0.113.9"}},
            bad={},
        )
        with FakeNetwork(source_map, verdicts):
            result = await proxy.harvest(expected=2, total_timeout=2.0,
                                         sources=[SOURCE_A, SOURCE_B])

        self.assertEqual(result["fetched"], 5)
        self.assertEqual(result["deduped"], 3)
        self.assertEqual(result["kept"], 2)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["truncated_count"], 1)
        self.assertEqual([e["server"] for e in result["entries"]],
                         ["http://2.2.2.2:80", "http://1.1.1.1:80"])

        # First source contributed both kept entries; the duplicate in B is dropped
        # and B's one new entry is the one cut by the cap.
        self.assertEqual([s["url"] for s in result["sources"]], [SOURCE_A, SOURCE_B])
        self.assertEqual(result["sources"][0]["deduped"], 2)
        self.assertEqual(result["sources"][1]["deduped"], 1)
        self.assertEqual(result["sources"][1]["kept"], 0)
        self.assertEqual({e["source"] for e in result["available"]}, {SOURCE_A})
        self.assertEqual(result["counts"],
                         {"kept": 2, "available": 2, "unfinished": 0, "unavailable": 0})

        # Attribution survives the cap: 2.2.2.2 came from A even though B repeated it.
        self.assertEqual([e["source"] for e in result["entries"]], [SOURCE_A, SOURCE_A])
        self.assertEqual({e["source"] for e in result["available"]}, {SOURCE_A})

    async def test_batch_deadline_marks_unfinished_without_counting_as_available(self):
        source_map = {SOURCE_A: "1.1.1.1:80\n2.2.2.2:80\n"}
        verdicts = {
            "1.1.1.1:80": {"ok": True, "ip": "203.0.113.7", "country": "US", "latency_ms": 20},
            "2.2.2.2:80": {"delay": 5.0},
        }

        async def fake_fetch(url, timeout):
            return source_map[url]

        async def fake_test(px, timeout: float = 15.0):
            verdict = verdicts[f"{px.host}:{px.port}"]
            if "delay" in verdict:
                await asyncio.sleep(verdict["delay"])
                return {"ok": True, "ip": "hung"}
            return dict(verdict)

        with patch.object(proxy, "_fetch_source_text", fake_fetch), \
             patch.object(proxy, "test", fake_test):
            started = asyncio.get_running_loop().time()
            result = await asyncio.wait_for(
                proxy.harvest(expected=10, verify=True, total_timeout=0.25, sources=[SOURCE_A]),
                timeout=2.0,
            )
            elapsed = asyncio.get_running_loop().time() - started

        self.assertLess(elapsed, 2.0, "harvest did not respect the whole-batch deadline")
        self.assertEqual([e["server"] for e in result["available"]], ["http://1.1.1.1:80"])
        self.assertEqual([e["server"] for e in result["unfinished"]], ["http://2.2.2.2:80"])
        self.assertIn("deadline", result["unfinished"][0]["reason"])
        self.assertEqual(result["unavailable"], [])
        self.assertEqual(result["counts"],
                         {"kept": 2, "available": 1, "unfinished": 1, "unavailable": 0})
        # The unfinished proxy is never reported as usable.
        self.assertNotIn("http://2.2.2.2:80", [e["server"] for e in result["available"]])

    async def test_all_sources_failing_yields_empty_report(self):
        source_map = {SOURCE_A: proxy.httpx.HTTPStatusError(
            "503", request=SimpleNamespace(), response=SimpleNamespace(status_code=503))}
        with FakeNetwork(source_map, {}):
            result = await proxy.harvest(expected=10, total_timeout=2.0, sources=[SOURCE_A])
        self.assertEqual(result["source_failures"], 1)
        self.assertEqual(result["kept"], 0)
        self.assertEqual(result["counts"],
                         {"kept": 0, "available": 0, "unfinished": 0, "unavailable": 0})
        self.assertEqual((result["available"], result["unfinished"], result["unavailable"]), ([], [], []))

    async def test_verify_false_reports_untested_candidates_not_available(self):
        source_map = {SOURCE_A: "1.1.1.1:80\n2.2.2.2:80\n"}
        with FakeNetwork(source_map, {}) as net:
            result = await proxy.harvest(expected=10, verify=False, sources=[SOURCE_A])

        self.assertFalse(result["verify"])
        self.assertEqual(result["available"], [])
        self.assertEqual(result["unfinished"], [])
        self.assertEqual(result["counts"],
                         {"kept": 2, "available": 0, "unfinished": 0, "unavailable": 0})
        self.assertEqual([e["server"] for e in result["untested"]],
                         ["http://1.1.1.1:80", "http://2.2.2.2:80"])
        self.assertEqual([e["source"] for e in result["untested"]], [SOURCE_A, SOURCE_A])
        self.assertEqual(net.tested, [])


class TestManyTests(unittest.IsolatedAsyncioTestCase):
    async def test_default_path_still_returns_every_verdict_in_order(self):
        """The deadline parameter must not change test_many's existing contract."""
        proxies = [proxy.Proxy(type="http", host="a", port=1),
                   proxy.Proxy(type="http", host="b", port=2)]

        async def fake_test(px, timeout: float = 15.0):
            return {"ok": px.host == "a", "error": "" if px.host == "a" else "boom"}

        with patch.object(proxy, "test", fake_test):
            results = await proxy.test_many(proxies)
            bounded = await proxy.test_many(proxies, deadline=5.0)

        self.assertEqual([r["index"] for r in results], [0, 1])
        self.assertEqual([r["server"] for r in results], ["http://a:1", "http://b:2"])
        self.assertTrue(results[0]["ok"])
        self.assertFalse(results[1]["ok"])
        self.assertNotIn("unfinished", results[0])
        self.assertEqual(results, bounded)


class HarvestApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(api.app, base_url="http://127.0.0.1")
        self.addCleanup(self.client.close)

    def test_endpoint_returns_stage_report_without_network(self):
        source_map = {SOURCE_A: "1.1.1.1:80\n2.2.2.2:80\n"}
        verdicts = _normal_verdicts(
            ok={"1.1.1.1:80": {"ip": "203.0.113.7"}},
            bad={"2.2.2.2:80": "ConnectError: refused"},
        )
        with FakeNetwork(source_map, verdicts), \
             patch.object(proxy, "_FREE_SOURCES", {"http": [SOURCE_A]}):
            response = self.client.post("/api/proxy/fetch-harvest", json={
                "protocol": "http", "expected": 10, "total_timeout": 2.0, "verify": True,
            })
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["counts"],
                         {"kept": 2, "available": 1, "unfinished": 0, "unavailable": 1})
        self.assertEqual(data["sources"][0]["url"], SOURCE_A)
        self.assertEqual(data["available"][0]["server"], "http://1.1.1.1:80")

    def test_invalid_limits_are_rejected(self):
        for payload in [{"expected": 0}, {"expected": 501}, {"total_timeout": 0},
                        {"total_timeout": 301}, {"protocol": "http", "expected": -1}]:
            with self.subTest(payload=payload):
                self.assertEqual(self.client.post("/api/proxy/fetch-harvest", json=payload).status_code, 422)


if __name__ == "__main__":
    unittest.main()
