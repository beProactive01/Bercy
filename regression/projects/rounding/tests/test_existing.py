import unittest
from prices import to_cents


class LegacyPrices(unittest.TestCase):
    def test_whole_and_exact_amounts(self):
        self.assertEqual(to_cents("10"), 1000)
        self.assertEqual(to_cents("0.01"), 1)
