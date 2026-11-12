import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class ContractSendTests(unittest.TestCase):
    def test_erc20_calldata_exact(self):
        recipient = "0x1111111111111111111111111111111111111111"
        to, value, data, units = server.build_transfer_call(server.USDT, Decimal("0.000001"), recipient)
        self.assertEqual(to, server.USDT)
        self.assertEqual(value, "0")
        self.assertEqual(units, 1_000_000_000_000)
        self.assertTrue(data.startswith("0xa9059cbb"))
        self.assertEqual(len(data), 74 + 64)
        self.assertIn(recipient[2:].lower(), data)

    def test_native_value_exact(self):
        recipient = "0x1111111111111111111111111111111111111111"
        to, value, data, units = server.build_transfer_call(server.NATIVE, Decimal("0.0005"), recipient)
        self.assertEqual(to, recipient)
        self.assertEqual(value, "500000000000000")
        self.assertEqual(units, 500_000_000_000_000)
        self.assertEqual(data, "0x")

    def test_extra_precision_truncated(self):
        self.assertEqual(
            server.token_base_units(Decimal("1.1234567890123456789"), 18),
            1_123_456_789_012_345_678,
        )
        self.assertEqual(
            server.token_base_units(Decimal("652.9205138214195022412"), 18),
            652_920_513_821_419_502_241,
        )


if __name__ == "__main__":
    unittest.main()
