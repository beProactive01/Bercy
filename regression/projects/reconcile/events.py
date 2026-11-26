def totals(events):
    result = {}
    for event in events:
        depot = event["depot"]
        result[depot] = result.get(depot, 0) + event["units"]
    return result
