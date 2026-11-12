import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class HistoryWalletCacheTests(unittest.TestCase):
    def setUp(self):
        self.old_by_id = server.WALLET_BY_ID
        self.old_rpc = server.rpc_call
        self.old_meta = dict(server._token_meta_cache)
        self.old_decimals = dict(server._decimals_cache)
        self.old_cache = dict(server._history_enrich_cache)
        server.WALLET_BY_ID = {
            "w1": {"id": "w1", "address": "0x1111111111111111111111111111111111111111"},
            "w2": {"id": "w2", "address": "0x2222222222222222222222222222222222222222"},
        }
        token = "0x3333333333333333333333333333333333333333"
        server._token_meta_cache[token] = ("TKN", 18)
        server._decimals_cache[token] = 18
        server._history_enrich_cache.clear()
        self.token = token
        self.tx = "0x" + "ab" * 32
        self.receipt = {
            "logs": [{
                "address": token,
                "topics": [
                    server.TRANSFER_TOPIC,
                    "0x" + "0" * 24 + "1" * 40,
                    "0x" + "0" * 24 + "2" * 40,
                ],
                "data": "0x" + format(123 * 10**18, "x").rjust(64, "0"),
            }]
        }
        self.tx_data = {"to": token, "from": "0x" + "1" * 40, "value": "0x0"}

        def fake_rpc(method, params, timeout=8):
            if method == "eth_getTransactionReceipt":
                return self.receipt
            if method == "eth_getTransactionByHash":
                return self.tx_data
            raise AssertionError(method)

        server.rpc_call = fake_rpc

    def tearDown(self):
        server.WALLET_BY_ID = self.old_by_id
        server.rpc_call = self.old_rpc
        server._token_meta_cache.clear()
        server._token_meta_cache.update(self.old_meta)
        server._decimals_cache.clear()
        server._decimals_cache.update(self.old_decimals)
        server._history_enrich_cache.clear()
        server._history_enrich_cache.update(self.old_cache)

    def test_same_tx_is_directional_per_wallet(self):
        out = server._enrich_contract_history("w1", self.tx)
        inc = server._enrich_contract_history("w2", self.tx)
        self.assertEqual(out["kind"], "发送")
        self.assertEqual(inc["kind"], "接收")
        self.assertIn("w1:" + self.tx, server._history_enrich_cache)
        self.assertIn("w2:" + self.tx, server._history_enrich_cache)


if __name__ == "__main__":
    unittest.main()
