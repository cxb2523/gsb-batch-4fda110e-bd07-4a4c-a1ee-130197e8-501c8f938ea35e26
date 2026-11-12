import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class AmountTests(unittest.TestCase):
    def test_percentage_19th_decimal_is_truncated(self):
        half = Decimal("0.123456789012345679") * Decimal(50) / Decimal(100)
        self.assertEqual(server.token_base_units(half, 18), 61728394506172839)

    def test_large_value_keeps_every_digit(self):
        units = server.token_base_units(Decimal("123456789012.123456789012345678"), 18)
        self.assertEqual(units, 123456789012123456789012345678)

    def test_manual_extra_precision_is_rejected(self):
        with self.assertRaises(ValueError):
            server.token_base_units(Decimal("1.1234567890123456789"), 18, truncate=False)

    def test_scientific_preview_large_amount(self):
        self.assertTrue(server.preview_amount_matches(6e23, 600000 * 10**18))

    def test_integer_allocation_never_draws_more_than_wallet(self):
        wallets = [5, 10, 15]
        shares = server.allocate_units(10, wallets)
        self.assertEqual(sum(shares), 10)
        self.assertTrue(all(a <= b for a, b in zip(shares, wallets)))


class StatusTests(unittest.TestCase):
    def test_confirmed_is_not_phone_confirmation(self):
        self.assertEqual(server.classify_execute_status({"status": "CONFIRMED"}), "submitted")

    def test_pending_confirmation(self):
        self.assertEqual(server.classify_execute_status({"status": "PENDING_CONFIRMATION"}), "needs_confirm")


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.old_wallet = server.WALLET_BY_ID.get("w1")
        self.old_address = server.wallet_address
        self.old_baw = server.baw
        self.old_save = server.save_keepalive
        self.old_pending = set(server._relogin_pending)
        server.WALLET_BY_ID["w1"] = {"id": "w1", "trade": True, "address": "0x1111111111111111111111111111111111111111"}
        server.wallet_address = lambda wallet: "0x1111111111111111111111111111111111111111"
        server.save_keepalive = lambda: None

    def tearDown(self):
        if self.old_wallet is None:
            server.WALLET_BY_ID.pop("w1", None)
        else:
            server.WALLET_BY_ID["w1"] = self.old_wallet
        server.wallet_address = self.old_address
        server.baw = self.old_baw
        server.save_keepalive = self.old_save
        server._relogin_pending.clear()
        server._relogin_pending.update(self.old_pending)

    def test_unknown_tx_lock_stops(self):
        server.baw = lambda wallet, args, timeout=70: {"success": False, "error": "temporary failure"}
        self.assertIn("交易锁状态", server.wallet_ready_error("w1"))

    def test_locked_wallet_stops(self):
        server.baw = lambda wallet, args, timeout=70: {"success": True, "data": {"status": "LOCKED"}}
        self.assertIn("交易锁", server.wallet_ready_error("w1"))

    def test_relogin_blocks_submission(self):
        server._relogin_pending.add("w1")
        self.assertIn("重新登录", server.wallet_ready_error("w1"))

    def test_second_relogin_request_is_rejected(self):
        server._relogin_pending.add("w1")
        out = server.start_wallet_relogin("w1")
        self.assertFalse(out["ok"])
        self.assertIn("扫码请求", out["error"])

    def test_blocked_mismatch_stops(self):
        server.WALLET_BY_ID["w1"]["sessionBlocked"] = True
        self.assertIn("地址", server.wallet_ready_error("w1"))


if __name__ == "__main__":
    unittest.main()
