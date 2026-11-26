"""Independent checks on the generated projects, including tests against deliberately incorrect implementations."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

SEEDS = Path(__file__).resolve().parent / "projects"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def run_python(directory, args, stdin=None):
    return subprocess.run(
        [sys.executable, "-B", *args], cwd=directory, input=stdin, text=True,
        capture_output=True, timeout=35, env={**os.environ, "PYTHONPATH": ""},
    )


def suite(directory):
    result = run_python(directory, ["-m", "unittest", "discover", "-s", "tests"])
    output = result.stdout + result.stderr
    count = re.search(r"Ran (\d+) tests? in", output)
    require(count and int(count[1]) > 0, "unittest did not discover tests: " + output[-700:])
    return result.returncode, int(count[1]), output


def probe(directory, code):
    result = run_python(directory, ["-c", code])
    require(result.returncode == 0, "independent probe failed: " + result.stderr[-700:])


def rejects_mutant(directory, module, replacement):
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "project"
        shutil.copytree(directory, target, ignore=shutil.ignore_patterns("__pycache__", ".git"))
        (target / module).write_text(replacement)
        status, _, log = suite(target)
        require(status != 0 and "FAILED (" in log, f"tests missed change in {module}")


def check_coding(case, execution):
    key = case["id"]
    directory = Path(execution["project"])
    seed = SEEDS / case["seed"] if case.get("seed") else None
    if seed and (seed / "tests").exists():
        for old in (seed / "tests").glob("*.py"):
            require(old.read_bytes() == (directory / "tests" / old.name).read_bytes(), "existing test was modified")
    status, count, log = suite(directory)
    require(status == 0, "delivered tests failed: " + log[-700:])
    green = [step["label"] for steps in execution["state"]["steps"].values() for step in steps
             if step["status"] == "done" and step.get("id", "").startswith("exec-") and "unittest" in step["label"]]
    require(green, "no successful unittest invocation observed from Codex")
    evidence = {"deliveredSuiteTests": count, "workerTestCommand": green[-1]}
    if key == "stock-cli":
        for data, expected in [
            ("sku,delta\n", {}),
            ('sku,delta\n007,4\n007,-3\n"S,K",5\n,9\nZ,no\n', {"007": 1, "S,K": 5}),
            ("sku,delta\nX,0\nX,-12\nY,+8\n", {"X": -12, "Y": 8}),
        ]:
            result = run_python(directory, ["stock.py"], data)
            require(result.returncode == 0 and json.loads(result.stdout) == expected, "stock CLI output mismatch")
        evidence["independentCliBatches"] = 3
    elif key == "rounding":
        probe(directory, """
from prices import to_cents
values = {'1.005':101, '-1.005':-101, '2.674':267, '0.005':1, '0':0, '9007199254740993.01':900719925474099301}
for value, expected in values.items():
    actual = to_cents(value)
    assert type(actual) is int and actual == expected, (value, actual, expected)
""")
        rejects_mutant(directory, "prices.py", (seed / "prices.py").read_text())
        evidence.update(independentAmounts=6, rejectedOriginal=True)
    elif key == "paging":
        probe(directory, """
from catalog import list_items
from copy import deepcopy
rows = [{'sku':str(i).zfill(3), 'active':i%2==0} for i in range(6)]
before = deepcopy(rows)
assert list_items(rows) == ['000','002','004']
assert list_items(rows, offset=1, limit=1) == ['002']
assert list_items(rows, limit=0) == list_items(rows, offset=8) == []
assert list_items(rows, offset=2) == ['004']
for kwargs in [{'offset':-1}, {'limit':-1}]:
    try: list_items(rows, **kwargs)
    except ValueError: pass
    else: raise AssertionError(kwargs)
try: list_items(rows, 1)
except TypeError: pass
else: raise AssertionError('offset accepted as positional')
assert rows == before
""")
        rejects_mutant(directory, "catalog.py", (seed / "catalog.py").read_text())
        evidence["rejectedOriginal"] = True
    elif key == "tests-only":
        source = (seed / "postage.py").read_text()
        require((directory / "postage.py").read_bytes() == (seed / "postage.py").read_bytes(), "production module changed")
        modules = {p.relative_to(directory).as_posix() for p in directory.rglob("*.py")
                   if p.relative_to(directory).parts[0] != "tests"}
        require(modules == {"postage.py"}, "unexpected Python file outside tests/")
        mutations = [
            ("weight <= 500", "weight < 500"), ("weight <= 1000", "weight < 1000"),
            ("base - 2", "base - 1"), ("type(weight) is not int", "not isinstance(weight, int)"),
        ]
        for old, new in mutations:
            require(source.count(old) == 1, "invalid mutation fixture")
            rejects_mutant(directory, "postage.py", source.replace(old, new))
        evidence["mutantsKilled"] = len(mutations)
    elif key == "fix-and-test":
        probe(directory, """
from events import totals
rows = [dict(id=i, depot=d, units=n) for i,d,n in [('a','N',-3),('a','S',6),('b','N',-3),('c','S',0)]]
assert totals([]) == {}
assert totals(rows) == {'N':-6,'S':0}
""")
        rejects_mutant(directory, "events.py", (seed / "events.py").read_text())
        steps = execution["state"]["steps"]
        evidence["redCommands"] = [
            s["label"] for s in steps.get("reproduce", []) if s["status"] == "failed"
            and re.search("unittest|test_duplicates", s["label"])
            and re.search(r"failures=[1-9]|AssertionError", s.get("detail", ""))
        ]
        require(evidence["redCommands"], "missing first node's failed test execution")
        require(any("unittest" in s["label"] and s["status"] == "done" and s.get("id", "").startswith("exec-")
                    for s in steps.get("repair", [])), "missing repair node's green test execution")
        evidence["rejectedOriginal"] = True
    return evidence
