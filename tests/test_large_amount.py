import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class LargePreviewAmountTests(unittest.TestCase):
    def test_scientific_notation_large_amount_matches(self):
        units = 600_000 * 10**18
        self.assertTrue(server.preview_amount_matches(6e23, units))
        self.assertFalse(server.preview_amount_matches(1e18, units))


if __name__ == "__main__":
    unittest.main()
