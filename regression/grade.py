"""Classify a run without making any model calls. Exit nonzero on failure or unresolved review."""
import importlib.util
import json
from collections import Counter
from pathlib import Path
import re
import sys
from uuid import UUID

from business import NeedsReview, check_business, final_text, find_office
from coding import check_coding, require

ROOT = Path(__file__).resolve().parent
CASES = {c["id"]: c for c in json.loads((ROOT / "cases.json").read_text())}


def starts(state, node):
    return [time for time, msg in state.get("events", {}).get(node, []) if msg.startswith(("开始执行", "Started", "Starting"))]


def check_flow(key, execution):
    state = execution["state"]
    files = state["files"]
    actions = execution["actions"]
    if key == "exhausted":
        require(state.get("rounds", {}).get("review", 0) >= 2, "test did not reach the rework limit")
        require(not starts(state, "publish") and "publish" not in files, "rejection reached publish: " + str(files.get("publish", {}).get("body")))
        require(not state["active"] and (state.get("errors") or state["label"] != "已交付"), "no visible rejection state")
        return {"reviewRounds": state["rounds"]["review"], "publishStarted": False}
    if key == "race":
        require(state.get("rounds", {}).get("review", 0) >= 1, "review did not trigger a return")
        press_starts = starts(state, "press")
        draft_starts = starts(state, "draft")
        require(len(draft_starts) >= 2 and press_starts and press_starts[0] <= draft_starts[1], "overlap was not exercised")
        output = json.loads(files["assemble"]["body"])
        require(output == {"review":"BRAVO-42", "press":"BRAVO-42"}, f"stale inputs reached join: {output}")
        return output
    if key == "join":
        artifact = next(a for a in files["left"]["artifacts"] if a["name"].endswith("east.txt"))
        east = Path(artifact["path"]).read_text().strip()
        west = files["right"]["body"].strip()
        require(UUID(east) != UUID(west), "independent UUIDs expected")
        require(artifact["id"] in [a["id"] for a in state["sent"]["join"]], "lost file ID")
        require(json.loads(files["join"]["body"]) == {"east":east, "west":west}, "join combined wrong values")
        return {"east":east, "west":west}
    if key == "missing":
        require(actions.get("supplied") and actions["beforeSupply"]["files"] == ["source"], "missing-input gate not observed")
        require("TK-80417" in files["receipt"]["body"] and len(starts(state, "receipt")) == 1, "receipt ran early or with wrong value")
        return {"resumeCode":"TK-80417"}
    if key == "retry":
        require(actions.get("retried") and actions["beforeRetry"]["files"] == ["steady"], "failed branch not isolated")
        require(len(starts(state, "steady")) == 1 and len(starts(state, "interrupted")) == 2, "incorrect retry scope")
        require(len(starts(state, "receipt")) == 1 and all(x in files["receipt"]["body"] for x in ("A-314","B-159")), "join after retry")
        return {"steadyAttempts":1, "interruptedAttempts":2}
    raise ValueError(key)


def classify(case, execution):
    if execution.get("error"):
        raise AssertionError(execution["error"])
    state = execution["state"]
    dispatched = {n.get("harness") for n in state["dispatch"].values()}
    require(dispatched <= {"Codex"}, f"unexpected runtimes: {dispatched}")
    if case["id"] != "exhausted":
        require(state["done"] and not state.get("errors") and state["label"] == "已交付",
                f"incomplete delivery: {state['label']}, {state.get('errors')}")
    if case["group"] == "flow": return check_flow(case["id"], execution)
    if case["group"] == "coding": return check_coding(case, execution)
    return check_business(case["id"], state)


def main():
    directory = Path(sys.argv[1])
    if "--check" in sys.argv[2:]:
        ids = set(sys.argv[3:])
        if "excel" in ids:
            require(importlib.util.find_spec("openpyxl") and find_office(), "Excel checks need openpyxl and LibreOffice (SOFFICE)")
        if "audio" in ids:
            require(importlib.util.find_spec("numpy"), "audio checks need numpy")
        return 0
    config = json.loads((directory / "config.json").read_text())
    require(config["runtime"] == ["Codex"] and config["planner"] == "Codex", "unexpected runtime configuration")
    runs = json.loads((directory / "executions.json").read_text())
    ids = sys.argv[2:] or config["selected"]
    results = []
    for key in ids:
        case = CASES[key]
        execution = runs.get(key, {})
        try:
            info = classify(case, execution)
            status = "PASS"
        except NeedsReview as exc:
            status, info = "REVIEW", str(exc)
        except Exception as exc:
            status, info = "FAIL", f"{type(exc).__name__}: {exc}"
        results.append({"id":key, "group":case["group"], "status":status, "criteria":case["accept"],
                        "details":info, "session":execution.get("session"), "seconds":execution.get("elapsedSeconds")})
        print(status, key, "" if status == "PASS" else info)
    counts = dict(Counter(r["status"] for r in results))
    report = {"counts":counts, "configuration":config, "cases":results}
    output = directory / "report.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(counts, output)
    return int(any(r["status"] != "PASS" for r in results))


if __name__ == "__main__":
    sys.exit(main())
