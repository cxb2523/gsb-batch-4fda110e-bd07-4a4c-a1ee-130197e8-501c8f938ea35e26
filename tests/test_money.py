import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


class AmountTests(unittest.TestCase):
    def test_fmt_qty_does_not_trim_integer_zeros(self):
        self.assertEqual(server.fmt_qty(Decimal("10"), server.USDT), "10")
        self.assertEqual(server.fmt_qty(Decimal("100"), server.USDT), "100")
        self.assertEqual(server.fmt_qty(Decimal("120"), server.USDT), "120")
        self.assertEqual(server.fmt_qty(Decimal("100.0"), server.USDT), "100")
        self.assertEqual(server.fmt_qty(Decimal("0.5000"), server.USDT), "0.5")
        self.assertEqual(server.fmt_qty(Decimal("0.000500000000000000"), server.NATIVE), "0.0005")

    def test_parse_positive_rejects_invalid(self):
        for bad in ("0", "-1", "NaN", "Infinity", "", None):
            with self.assertRaises(ValueError):
                server.parse_positive_amount(bad)
        self.assertEqual(server.parse_positive_amount("10"), Decimal("10"))


class TaxTests(unittest.TestCase):
    def test_tax_values_are_sanitized(self):
        server._audit_cache["0xabc"] = {"buyTax": "2.5", "sellTax": float("nan")}
        self.assertEqual(server.token_tax("0xabc"), {"buy": 2.5, "sell": None})
        self.assertEqual(server.token_tax(server.USDT), {"buy": 0, "sell": 0})


class GuardTests(unittest.TestCase):
    def test_missing_market_blocks_quote(self):
        original_baw = server.baw
        original_market = server.token_market
        original_tax = server.token_tax
        try:
            server.baw = lambda *a, **k: {"success": True, "data": {
                "toCoinAmount": "1", "fromCoinAmount": "1",
                "fromCoinSymbol": "BNB", "toCoinSymbol": "USDT", "slippage": "0.01",
            }}
            server.token_market = lambda token: {}
            server.token_tax = lambda token: {"buy": 0, "sell": 0}
            q = server.quote_for("w1", server.USDT, "1", "auto")
            self.assertFalse(q["ok"])
            self.assertEqual(q["guard"], "blocked")
            self.assertIn("行情基准", q["error"])
        finally:
            server.baw = original_baw
            server.token_market = original_market
            server.token_tax = original_tax


class PermissionTests(unittest.TestCase):
    def test_read_only_wallet_blocks_send(self):
        old_wallets = server.WALLETS
        old_map = server.WALLET_BY_ID
        try:
            server.WALLETS = [{"id": "w1", "label": "RO", "address": "0x" + "1" * 40, "trade": False}]
            server.WALLET_BY_ID = {w["id"]: w for w in server.WALLETS}
            leg = {"wallet": "w1", "status": "queued"}
            server.send_leg(leg, server.USDT, 50, "0x" + "2" * 40)
            self.assertEqual(leg["status"], "failed")
            self.assertIn("只读", leg["error"])
        finally:
            server.WALLETS = old_wallets
            server.WALLET_BY_ID = old_map


class TaskTests(unittest.TestCase):
    def test_task_claim_and_reload_marks_unknown(self):
        old_path = server.TASKS_PATH
        old_tasks = server._tasks
        path = server.DATA / "test-tasks.json"
        try:
            for f in (path, path.with_suffix(".tmp")):
                try:
                    f.unlink()
                except FileNotFoundError:
                    pass
            server.TASKS_PATH = path
            server._tasks = {}
            task = server.new_task("send", [{"wallet": "w1", "status": "queued"}], "idem-1", "fp-1")
            self.assertTrue(server.claim_task(task))
            self.assertFalse(server.claim_task(task))
            with self.assertRaises(ValueError):
                server.new_task("send", [{"wallet": "w1"}], "idem-1", "different")
            server._tasks = {}
            server.load_tasks()
            loaded = server._tasks[task["id"]]
            self.assertEqual(loaded["status"], "unknown")
        finally:
            server.TASKS_PATH = old_path
            server._tasks = old_tasks
            for f in (path, path.with_suffix(".tmp")):
                try:
                    f.unlink()
                except FileNotFoundError:
                    pass


if __name__ == "__main__":
    unittest.main()
