"""Freshness / ownership / de-duplication tests for the history pipeline.

These use only fabricated BAW payloads and receipt data; no network or BAW
binary is involved.
"""
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

TOKEN = "0x3333333333333333333333333333333333333333"
TX = "0x" + "ab" * 32
W1 = "0x" + "1" * 40
W2 = "0x" + "2" * 40


def baw_page(amount: str = "12", symbol: str = "TKN") -> dict:
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
                    "instructions": {
                        "send": [{
                            "amount": amount,
                            "tokenInfo": {"symbol": symbol},
                            "addressInfo": {"address": W1},
                        }],
                        "receive": [{
                            "amount": amount,
                            "tokenInfo": {"symbol": symbol},
                            "addressInfo": {"address": W2},
                        }],
                    },
                }],
            }]
        },
    }


class HistoryFreshnessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_by_id = server.WALLET_BY_ID
        self.old_wallets = list(server.WALLETS)
        self.old_history_dir = server.HISTORY_DIR
        self.old_baw = server.baw
        self.old_rpc = server.rpc_call
        self.old_token_meta = dict(server._token_meta_cache)
        self.old_decimals = dict(server._decimals_cache)
        self.old_enrich = dict(server._history_enrich_cache)
        self.old_fresh = server.HISTORY_FRESH_SECONDS
        self.old_retry = server.HISTORY_RETRY_SECONDS

        server.WALLET_BY_ID = {
            "w1": {"id": "w1", "label": "W1", "address": W1},
            "w2": {"id": "w2", "label": "W2", "address": W2},
        }
        server.WALLETS = [server.WALLET_BY_ID["w1"], server.WALLET_BY_ID["w2"]]
        server.HISTORY_DIR = Path(self.tmp.name)
        server._history_cache.clear()
        server._history_inflight.clear()
        server._history_enrich_cache.clear()
        server._token_meta_cache.clear()
        server._decimals_cache.clear()
        server._token_meta_cache[TOKEN] = ("TKN", 18)
        server._decimals_cache[TOKEN] = 18

        self.receipt = {
            "logs": [{
                "address": TOKEN,
                "topics": [
                    server.TRANSFER_TOPIC,
                    "0x" + "0" * 24 + "1" * 40,
                    "0x" + "0" * 24 + "2" * 40,
                ],
                "data": "0x" + format(12 * 10**18, "x").rjust(64, "0"),
            }]
        }
        self.tx_data = {"to": TOKEN, "from": W1, "value": "0x0"}

        def fake_rpc(method, params, timeout=8):
            if method == "eth_getTransactionReceipt":
                return self.receipt
            if method == "eth_getTransactionByHash":
                return self.tx_data
            raise AssertionError(method)

        server.rpc_call = fake_rpc
        self.fail_after = None
        self.calls = 0

        def fake_baw(wallet, args, timeout=70):
            self.calls += 1
            if self.fail_after is not None and self.calls > self.fail_after:
                return {"success": False, "error": {"name": "NOT_LOGGED_IN", "message": "BAW 会话已退出"}}
            return baw_page()

        server.baw = fake_baw

    def tearDown(self):
        server.WALLET_BY_ID = self.old_by_id
        server.WALLETS = self.old_wallets
        server.HISTORY_DIR = self.old_history_dir
        server.baw = self.old_baw
        server.rpc_call = self.old_rpc
        server._token_meta_cache.clear()
        server._token_meta_cache.update(self.old_token_meta)
        server._decimals_cache.clear()
        server._decimals_cache.update(self.old_decimals)
        server._history_enrich_cache.clear()
        server._history_enrich_cache.update(self.old_enrich)
        server.HISTORY_FRESH_SECONDS = self.old_fresh
        server.HISTORY_RETRY_SECONDS = self.old_retry
        server._history_cache.clear()
        server._history_inflight.clear()
        self.tmp.cleanup()

    def read_tx(self):
        return server.history_state("w1")

    def test_success_reports_timestamp_and_ok(self):
        out = server.build_history("w1", limit=50)
        self.assertTrue(out["ok"])
        self.assertIsNotNone(out["updatedAt"])
        self.assertEqual(len(out["items"]), 1)
        self.assertEqual(out["wallets"]["w1"]["ok"], True)
        row = out["items"][0]
        self.assertEqual(row["wallet"], "w1")
        self.assertEqual(row["walletAddress"], W1)
        self.assertEqual(row["fetchedAt"], out["updatedAt"])

    def test_failure_keeps_old_rows_and_marks_stale(self):
        out = server.build_history("w1", limit=50)
        first_success = out["updatedAt"]
        self.assertTrue(out["ok"])
        self.fail_after = 1
        time.sleep(0.02)
        failed = server.build_history("w1", limit=50, force=True)
        # Old data survives...
        self.assertEqual(len(failed["items"]), 1)
        self.assertEqual(failed["updatedAt"], first_success)
        # ...but the failure is explicit, with a readable reason and timestamp.
        self.assertFalse(failed["ok"])
        self.assertIn("BAW 会话已退出", failed["error"])
        self.assertTrue(failed["stale"])
        self.assertTrue(failed["wallets"]["w1"]["stale"])
        self.assertGreaterEqual(failed["wallets"]["w1"]["failures"], 1)
        self.assertIsNotNone(failed["wallets"]["w1"]["attemptedAt"])
        self.assertNotEqual(failed["wallets"]["w1"]["attemptedAt"], first_success)
        self.assertTrue(failed["items"][0]["stale"])

    def test_failure_without_previous_success_is_readable_not_empty_list(self):
        self.fail_after = 0
        out = server.build_history("w1", limit=50)
        self.assertEqual(out["items"], [])
        self.assertFalse(out["ok"])
        self.assertIn("BAW 会话已退出", out["error"])
        self.assertFalse(out["stale"])

    def test_repeated_calls_after_failure_back_off(self):
        self.fail_after = 0
        first = server.build_history("w1", limit=50)
        self.assertFalse(first["ok"])
        calls_after_first = self.calls
        for _ in range(5):
            out = server.build_history("w1", limit=50)
            self.assertFalse(out["ok"])
            self.assertIn("BAW 会话已退出", out["error"])
        # The retry window has not elapsed, so no extra BAW invocations.
        self.assertEqual(self.calls, calls_after_first)

    def test_successful_empty_page_is_not_refetched_every_call(self):
        server.baw = lambda wallet, args, timeout=70: {"success": True, "data": {"transactions": []}}
        first = server.build_history("w1", limit=50)
        self.assertTrue(first["ok"])
        self.assertEqual(first["items"], [])
        calls_after_first = self.calls
        for _ in range(3):
            server.build_history("w1", limit=50)
        self.assertEqual(self.calls, calls_after_first)

    def test_same_tx_hash_has_opposite_direction_per_wallet(self):
        a = server._enrich_contract_history("w1", TX)
        b = server._enrich_contract_history("w2", TX)
        self.assertEqual(a["kind"], "发送")
        self.assertEqual(b["kind"], "接收")
        # Cache keys are wallet-scoped and values remember their address.
        self.assertEqual(server._history_enrich_cache["w1:" + TX][2], W1)
        self.assertEqual(server._history_enrich_cache["w2:" + TX][2], W2)

    def test_endpoint_rows_keep_their_wallet_ownership(self):
        # Both wallets report the same txHash; the merged list must keep them
        # distinct and each must carry its own direction.
        w1 = server.build_history("w1", limit=50)
        w2 = server.build_history("w2", limit=50)
        self.assertEqual(w1["items"][0]["kind"], "发送")
        self.assertEqual(w2["items"][0]["kind"], "接收")
        merged = server.build_history("all", limit=50)
        rows = {(r["wallet"], r["kind"]) for r in merged["items"]}
        self.assertIn(("w1", "发送"), rows)
        self.assertIn(("w2", "接收"), rows)

    def test_rebound_wallet_does_not_reuse_old_address_cache(self):
        server._enrich_contract_history("w1", TX)
        server.WALLET_BY_ID["w1"] = {"id": "w1", "label": "W1", "address": W2}
        out = server._enrich_contract_history("w1", TX)
        self.assertEqual(out["kind"], "接收")  # now viewed as W2
        self.assertEqual(server._history_enrich_cache["w1:" + TX][2], W2)

    def test_concurrent_refresh_reuses_single_baw_call(self):
        gate = threading.Event()
        calls = {"n": 0}
        original = server.baw

        def slow_baw(wallet, args, timeout=70):
            calls["n"] += 1
            gate.wait(1.0)
            return original(wallet, args, timeout=timeout)

        server.baw = slow_baw
        results = []

        def run():
            results.append(server.history_state("w1", force=True))

        threads = [threading.Thread(target=run) for _ in range(5)]
        for t in threads:
            t.start()
        time.sleep(0.15)  # let all callers enter the join path
        gate.set()
        for t in threads:
            t.join(5)
        self.assertEqual(calls["n"], 1)
        self.assertEqual(len(results), 5)
        self.assertTrue(all(len(r["items"]) == 1 for r in results))

    def test_disk_snapshot_is_reused_across_cache_clear(self):
        out = server.build_history("w1", limit=50)
        self.assertIsNotNone(out["updatedAt"])
        # Simulate a process restart: drop memory but keep data/history.
        server._history_cache.clear()
        self.fail_after = 0
        restored = server.build_history("w1", limit=50)
        # A snapshot restored from disk is served with its own fetch time,
        # but no attempt was made in this process, so ok is unknown (None).
        self.assertEqual(len(restored["items"]), 1)
        self.assertEqual(restored["updatedAt"], out["updatedAt"])
        self.assertIsNone(restored["ok"])
        self.assertIsNone(restored["error"])
        # A forced refresh then fails: rows stay, failure is explicit.
        failed = server.build_history("w1", limit=50, force=True)
        self.assertEqual(len(failed["items"]), 1)
        self.assertEqual(failed["updatedAt"], out["updatedAt"])
        self.assertFalse(failed["ok"])
        self.assertIn("BAW 会话已退出", failed["error"])


if __name__ == "__main__":
    unittest.main()
