import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class SessionStatusTests(unittest.TestCase):
    def setUp(self):
        self.old_wallets = server.WALLETS
        self.old_by_id = server.WALLET_BY_ID
        self.old_keepalive = server._keepalive
        self.old_baw = server.baw
        self.old_save = server.save_keepalive
        self.old_wallet_address = server.wallet_address
        server.WALLETS = [{"id": "w1"}]
        server.WALLET_BY_ID = {"w1": {"id": "w1", "trade": True, "address": "0x1111111111111111111111111111111111111111"}}
        server._keepalive = {"wallets": {}, "at": None}
        server.save_keepalive = lambda: None
        server.baw = lambda wallet, args, timeout=70: {
            "success": True, "data": {"status": "UNCONNECTED"},
        }

    def tearDown(self):
        server.WALLETS = self.old_wallets
        server.WALLET_BY_ID = self.old_by_id
        server._keepalive = self.old_keepalive
        server.baw = self.old_baw
        server.save_keepalive = self.old_save
        server.wallet_address = self.old_wallet_address

    def test_keepalive_reports_unconnected(self):
        server.keepalive_once()
        self.assertEqual(server._keepalive["wallets"]["w1"]["status"], "UNCONNECTED")

    def test_failed_address_marks_session(self):
        server.wallet_address = lambda wallet: ""
        error = server.wallet_ready_error("w1")
        self.assertIn("会话已退出", error)
        self.assertEqual(server._keepalive["wallets"]["w1"]["status"], "UNCONNECTED")


if __name__ == "__main__":
    unittest.main()
