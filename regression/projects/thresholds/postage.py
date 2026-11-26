def fee(weight, member=False):
    """Positive integer grams only. Member postage is discounted by two units."""
    if type(weight) is not int or weight <= 0:
        raise ValueError("positive integer grams required")
    base = 5 if weight <= 500 else 9 if weight <= 1000 else 14
    return base - 2 if member else base
