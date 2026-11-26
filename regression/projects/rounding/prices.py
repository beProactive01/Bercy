def to_cents(value: str) -> int:
    """Convert a signed decimal amount to whole cents."""
    return round(float(value) * 100)
