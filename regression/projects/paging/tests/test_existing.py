import unittest
from catalog import list_items


class LegacyCatalog(unittest.TestCase):
    def test_original_call(self):
        self.assertEqual(list_items([{"sku": "007", "active": True}]), ["007"])
