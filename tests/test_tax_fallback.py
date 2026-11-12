import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class TaxFallbackTests(unittest.TestCase):
    def setUp(self):
        self.old_baw = server.baw
        self.old_market = server.token_market
        self.old_tax = server.token_tax
        self.old_audit = server._audit_cache
        self.old_market_cache = server._market_cache
        server.baw = lambda wallet, args, timeout=70: {
            "success": True,
            "data": {"fromCoinAmount": "100", "toCoinAmount": "95", "fromCoinSymbol": "NEW", "toCoinSymbol": "USDT", "slippage": 0.01},
        }
        server.token_market = lambda token: {
            "price": 1.0, "ts": time.time(), "liquidity": 50000, "dex": "pancakeswap", "labels": ["v2"], "pair": "0xpair", "quote": "1",
        }
        server.token_tax = lambda token: {"buy": None, "sell": None}
        server._audit_cache = {}
        server._market_cache = {"ts": time.time(), "data": {}}

    def tearDown(self):
        server.baw = self.old_baw
        server.token_market = self.old_market
        server.token_tax = self.old_tax
        server._audit_cache = self.old_audit
        server._market_cache = self.old_market_cache

    def test_unknown_tax_is_confirmed_not_permanently_blocked(self):
        q = server.quote_for("w1", "0x1111111111111111111111111111111111111111", "100")
        self.assertTrue(q["ok"])
        self.assertTrue(q["taxUnknown"])
        self.assertTrue(q["needsTaxAck"])
        self.assertEqual(q["guard"], "warn")


if __name__ == "__main__":
    unittest.main()
