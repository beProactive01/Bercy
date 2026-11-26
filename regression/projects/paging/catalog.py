def list_items(items):
    """Return all active SKU strings in input order."""
    return [item["sku"] for item in items if item["active"]]
