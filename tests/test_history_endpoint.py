"""End-to-end HTTP acceptance test for /api/history using fabricated BAW data.

Starts the real request handler on an ephemeral port; BAW and BSC RPC are
stubbed, so no wallet, network, or credentials are involved.
"""
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

TOKEN = "0x3333333333333333333333333333333333333333"
TX = "0x" + "cd" * 32
W1 = "0x" + "1" * 40
W2 = "0x" + "2" * 40


def baw_page() -> dict:
    return {
        "success": True,
        "data": {
            "transactions": [{
                "txHash": TX,
                "txTime": "2026-11-12T10:00:00+08:00",
                "txType": "contract_call",
                "status": "confirmed",
                "txHashList": [{
                    "txHash": TX,
                    "status": "confirmed",
                    "instructions": {},
                }],
            }]
        },
    }


class HistoryEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.old_dir = server.HISTORY_DIR
        cls.old_wallets = list(server.WALLETS)
        cls.old_by_id = server.WALLET_BY_ID
        cls.old_baw = server.baw
        cls.old_rpc = server.rpc_call
        cls.old_meta = dict(server._token_meta_cache)
        cls.old_decimals = dict(server._decimals_cache)
        cls.old_enrich = dict(server._history_enrich_cache)
        cls.old_fresh = server.HISTORY_FRESH_SECONDS
        cls.old_retry = server.HISTORY_RETRY_SECONDS

        server.HISTORY_DIR = Path(cls.tmp.name)
        server.HISTORY_FRESH_SECONDS = 60
        server.HISTORY_RETRY_SECONDS = 0  # never silently skip retries in tests
        server.WALLET_BY_ID = {
            "w1": {"id": "w1", "label": "W1", "address": W1},
            "w2": {"id": "w2", "label": "W2", "address": W2},
        }
        server.WALLETS = [server.WALLET_BY_ID["w1"], server.WALLET_BY_ID["w2"]]
        server._history_cache.clear()
        server._history_inflight.clear()
        server._history_enrich_cache.clear()
        server._decimals_cache.clear()
        server._token_meta_cache.clear()
        server._token_meta_cache[TOKEN] = ("TKN", 18)
        server._decimals_cache[TOKEN] = 18

        def fake_rpc(method, params, timeout=8):
            if method == "eth_getTransactionReceipt":
                return {"logs": [{
                    "address": TOKEN,
                    "topics": [server.TRANSFER_TOPIC, "0x" + "0" * 24 + "1" * 40, "0x" + "0" * 24 + "2" * 40],
                    "data": "0x" + format(12 * 10**18, "x").rjust(64, "0"),
                }]}
            if method == "eth_getTransactionByHash":
                return {"to": TOKEN, "from": W1, "value": "0x0"}
            raise AssertionError(method)

        server.rpc_call = fake_rpc

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        server.HISTORY_DIR = cls.old_dir
        server.WALLETS = cls.old_wallets
        server.WALLET_BY_ID = cls.old_by_id
        server.baw = cls.old_baw
        server.rpc_call = cls.old_rpc
        server._token_meta_cache.clear()
        server._token_meta_cache.update(cls.old_meta)
        server._decimals_cache.clear()
        server._decimals_cache.update(cls.old_decimals)
        server._history_enrich_cache.clear()
        server._history_enrich_cache.update(cls.old_enrich)
        server.HISTORY_FRESH_SECONDS = cls.old_fresh
        server.HISTORY_RETRY_SECONDS = cls.old_retry
        server._history_cache.clear()
        server._history_inflight.clear()
        cls.tmp.cleanup()

    def setUp(self):
        server._history_cache.clear()
        server._history_inflight.clear()
        server._history_enrich_cache.clear()
        for p in Path(server.HISTORY_DIR).glob("*.json"):
            p.unlink()
        self.fail_after = None
        self.calls = 0

        def fake_baw(wallet, args, timeout=70):
            self.calls += 1
            if self.fail_after is not None and self.calls > self.fail_after:
                return {"success": False, "error": {"name": "NOT_LOGGED_IN", "message": "BAW 会话已退出"}}
            return baw_page()

        server.baw = fake_baw

    def get(self, path):
        url = f"http://127.0.0.1:{self.port}{path}"
        with urllib.request.urlopen(url, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))

    def test_success_then_failure_then_opposite_directions(self):
        ok = self.get("/api/history?wallet=w1&limit=50")
        self.assertTrue(ok["ok"])
        self.assertIsNotNone(ok["updatedAt"])
        self.assertEqual(ok["wallets"]["w1"]["ok"], True)
        self.assertEqual(ok["items"][0]["fetchedAt"], ok["updatedAt"])

        # Same txHash, other wallet: opposite direction, own cache entry.
        other = self.get("/api/history?wallet=w2&limit=50")
        self.assertEqual(ok["items"][0]["txHash"], other["items"][0]["txHash"])
        self.assertEqual(ok["items"][0]["kind"], "发送")
        self.assertEqual(other["items"][0]["kind"], "接收")
        self.assertEqual(other["items"][0]["wallet"], "w2")

        # Now BAW fails: old rows survive but the payload says the attempt failed.
        self.fail_after = 1
        time.sleep(0.01)
        failed = self.get("/api/history?wallet=w1&limit=50&refresh=1")
        self.assertEqual(len(failed["items"]), 1)
        self.assertEqual(failed["updatedAt"], ok["updatedAt"])
        self.assertFalse(failed["ok"])
        self.assertIn("BAW", failed["error"])
        self.assertTrue(failed["stale"])
        self.assertNotEqual(failed["wallets"]["w1"]["attemptedAt"], ok["updatedAt"])

    def test_negative_path_is_reason_not_empty_list(self):
        self.fail_after = 0
        out = self.get("/api/history?wallet=w1&limit=50")
        self.assertEqual(out["items"], [])
        self.assertFalse(out["ok"])
        self.assertTrue(out["error"])
        self.assertIn("BAW", out["error"])
        self.assertEqual(out["wallets"]["w1"]["count"], 0)

    def test_unknown_wallet_reports_reason(self):
        out = self.get("/api/history?wallet=ghost&limit=50")
        self.assertEqual(out["items"], [])
        self.assertFalse(out["ok"])
        self.assertIn("钱包不存在", out["error"])


if __name__ == "__main__":
    unittest.main()
