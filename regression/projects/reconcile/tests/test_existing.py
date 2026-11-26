import unittest
from events import totals


class ExistingTotals(unittest.TestCase):
    def test_one_depot(self):
        self.assertEqual(totals([{"id": "A", "depot": "north", "units": 3}]), {"north": 3})
