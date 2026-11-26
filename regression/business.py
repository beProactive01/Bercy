import csv
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import wave
from zoneinfo import ZoneInfo

from coding import require, run_python

INPUTS = Path(__file__).resolve().parent / "inputs"


class NeedsReview(Exception):
    """There is insufficient evidence to classify an open-ended answer automatically."""


def find_office():
    bundled = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice"
    return os.environ.get("SOFFICE") or shutil.which("soffice") or (str(bundled) if bundled.is_file() else None)


def final_text(state):
    parents = {n for deps in state["deps"].values() for n in deps}
    return "\n".join(v["body"] for k, v in state["files"].items() if k not in parents)


def artifacts(state, suffix):
    # The answer dock includes both sink attachments and other deliverables.
    parents = {n for deps in state["deps"].values() for n in deps}
    nodes = sorted(state["files"], key=lambda n: n in parents)
    return [Path(a["path"]) for n in nodes for a in state["files"][n].get("artifacts", [])
            if a["name"].lower().endswith(suffix)]


def file_of(state, suffix):
    matches = artifacts(state, suffix)
    require(matches, f"missing {suffix} file")
    return matches[0]


def table(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.reader(stream))


def workbook(state):
    from openpyxl import load_workbook
    source = file_of(state, ".xlsx")
    book = load_workbook(source)
    sheet = book.active
    require(len(book.worksheets) == 1, "expected one sheet")
    require([c.value for c in sheet[1][:4]] == ["item", "quantity", "price", "amount"], "wrong header")
    for row, (item, qty, price) in enumerate(table(INPUTS / "expenses.csv")[1:], 2):
        require([c.value for c in sheet[row][:3]] == [item, int(qty), float(price)], f"data row {row}")
        formula = str(sheet[f"D{row}"].value).replace("$", "").replace(" ", "").upper()
        require(formula in (f"=B{row}*C{row}", f"=C{row}*B{row}"), f"wrong formula D{row}")
    require(str(sheet["D5"].value).upper().replace("$", "").replace(" ", "") == "=SUM(D2:D4)", "wrong SUM")
    for cell in ["C2", "C3", "C4", "D2", "D3", "D4", "D5"]:
        require("0.00" in sheet[cell].number_format, f"format {cell}")
    totals = []
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        out = root / "out"
        out.mkdir()
        for qty in (4, 5):
            sheet["B2"] = qty
            name = f"qty-{qty}.xlsx"
            book.save(root / name)
            subprocess.run([find_office(), "-env:UserInstallation=" + (root / "lo").as_uri(), "--headless",
                            "--convert-to", "xlsx", "--outdir", str(out), str(root / name)], check=True,
                           capture_output=True, timeout=45)
            totals.append(round(load_workbook(out / name, data_only=True).active["D5"].value, 2))
    require(totals == [461.60, 489.10], f"recalculation {totals}")
    return {"recalculatedTotals": totals}


def subtitle_blocks(path):
    result = []
    for block in re.split(r"\n\s*\n", path.read_text(encoding="utf-8-sig").strip()):
        number, span, *lines = block.splitlines()
        endpoints = []
        for t in span.split(" --> "):
            h, m, s, ms = map(int, re.fullmatch(r"(\d\d):(\d\d):(\d\d),(\d{3})", t).groups())
            endpoints.append(((h * 60 + m) * 60 + s) * 1000 + ms)
        result.append((number, endpoints, lines))
    return result


def check_audio(state):
    import numpy as np
    with wave.open(str(file_of(state, ".wav"))) as w:
        header = (w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes())
        require(header == (48000, 1, 2, 144000), f"WAV header {header}")
        pulses = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").reshape(6, 24000)
    peaks = []
    for pulse in pulses:
        active = np.flatnonzero(pulse)
        require(active.size and active[0] < 20 and 2300 < active[-1] < 2500, "pulse timing or silence mismatch")
        peaks.append(int(abs(np.fft.rfft(pulse[:2400] * np.hanning(2400), 48000)).argmax()))
    require(all(abs(n - 880) <= 1 for n in peaks), f"pulse frequencies {peaks}")
    return {"frames": header[-1], "frequenciesHz": peaks}


def calendar(state):
    ics = re.sub(r"\n[ \t]", "", file_of(state, ".ics").read_text(encoding="utf-8-sig"))
    txt = file_of(state, ".txt").read_text(encoding="utf-8-sig")
    require(ics.count("BEGIN:VEVENT") == 1 and "END:VEVENT" in ics, "event count")
    event = ics.split("BEGIN:VEVENT")[1].split("END:VEVENT")[0]
    for key in ("UID", "DTSTAMP"):
        require(len(re.findall("^" + key + r"[:;].+", event, re.M)) == 1, "missing or repeated " + key)
    for key, expected in [("DTSTART", "20261203T020000"), ("DTEND", "20261203T033000")]:
        params, value = re.search("^" + key + r"([^:]*):([^\n]+)", event, re.M).groups()
        zone = timezone.utc if value.endswith("Z") else ZoneInfo(re.search(r'TZID="?([^";]+)', params)[1])
        dt = datetime.strptime(value.rstrip("Z"), "%Y%m%dT%H%M%S").replace(tzinfo=zone)
        require(dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%S") == expected, key)
    require("SUMMARY:River Walk Lab" in event and "LOCATION:Cedar 307" in event, "wrong event")
    require(all(k in txt for k in ["River Walk Lab", "Cedar 307", "10:00", "11:30"]), "incomplete notes")
    require(re.search(r"2026\s*[-年/]\s*12\s*[-月/]\s*0?3|Dec(?:ember)?\s+3,?\s+2026", txt, re.I), "wrong notes date")
    require("水瓶" in txt or "water bottle" in txt.lower(), "missing water bottle")
    return {"calendar": "one event, UID/DTSTAMP present", "utc": ["02:00", "03:30"]}


def ledger(state, body):
    raw = table(INPUTS / "ledger-nov.csv")[1:]
    unique = {row[0]: row for row in raw}
    expected = defaultdict(lambda: [0, 0])
    for _, region, cents, status in unique.values():
        if status != "void":
            expected[region][0] += 1
            expected[region][1] += int(cents)
    rows = table(file_of(state, ".csv"))
    require(rows[0] == ["region", "count", "cents"] and len(rows) == 1 + len(expected), "wrong region table")
    require({r:[int(n), int(v)] for r,n,v in rows[1:]} == expected, "region totals differ")
    readers = [n for n, group in state.get("sent", {}).items()
               if any(a["path"].endswith("ledger-nov.csv") for a in group)]
    require(len(set(readers)) >= 2, "second node did not receive original")
    audited = []
    for n in readers:
        for step in state.get("steps", {}).get(n, []):
            detail = str(step.get("detail", "")).replace(",", "") if step.get("detail") else ""
            if step["status"] == "done" and any(str(x) in detail for x in (18400163, 4704828, 4440234, 4444555, 4810546, 1866)):
                audited.append(n)
                break
    if len(set(audited)) < 2 or not re.search("一致|匹配|通过", body):
        raise NeedsReview("汇总正确且两个节点收到原件，需人工核对独立复算命令与结论")
    return {"rows": len(raw), "duplicates": len(raw)-len(unique), "verifiedNodes": audited, "regions": dict(expected)}


def check_business(key, state):
    body = final_text(state).strip()
    if key == "excel": return workbook(state)
    if key == "audio": return check_audio(state)
    if key == "pair": return calendar(state)
    if key == "volume": return ledger(state, body)
    if key == "ids":
        expected = [["9007199254740993","0007","重试"],["9007199254740995","0008",None],["100","0010","OK"]]
        require(json.loads(body) == [dict(zip(["id","order","note"],row)) for row in expected], "JSON values or types differ")
    elif key == "capacity":
        rooms = json.loads(body)
        sizes = dict(zip(["G1","G2","G3","G4","G5","G6"],[4,3,3,2,2,2]))
        require(set(rooms) == set("ABC") and Counter(sum(rooms.values(), [])) == Counter(sizes.keys()), "invalid assignment")
        loads = [sum(sizes[g] for g in rooms[r]) for r in "ABC"]
        require(all(x <= cap for x,cap in zip(loads,[6,6,4])), f"over capacity: {loads}")
        return {"loads":loads}
    elif key == "refunds":
        rows = table(file_of(state, ".csv"))
        require(rows[0] == ["order_id","customer","paid_cents","refund_cents","net_cents"], "header")
        require(sorted(rows[1:]) == [["0001","Lin, May","12505","4505","8000"],["0002","周扬","8999","8999","0"],["0003","Sam","100","0","100"]], "order rows")
        require("8100" in body.replace(",",""), "missing net total")
    elif key == "srt":
        expected = [(n,[v+1250 for v in t],ls) for n,t,ls in subtitle_blocks(INPUTS/"recording.srt")]
        require(subtitle_blocks(file_of(state,".srt")) == expected, "SRT text, index or timing mismatch")
    elif key == "copy":
        lines = body.splitlines()
        require(len(lines)==3 and all(v.startswith(h) and len(v)<=10 and "购买" not in v for v,h in zip(lines,"来给让")), "title constraints")
    elif key == "cli":
        script = file_of(state,".py")
        require(script.name == "sum_minutes.py", "wrong filename")
        for lines, expected in [([],{}),(["bad","null","[]"],{}),
            (['{"owner":"唐","minutes":0}','{"owner":"唐","minutes":7}'],{"唐":7}),
            (['{"owner":"B","minutes":true}','{"owner":"B","minutes":-1}','{"owner":"","minutes":1}'],{}),
            (['{"owner":"Q","minutes":1000000000000000000}','{"owner":"Q","minutes":1}'],{"Q":1000000000000000001})]:
            result = run_python(script.parent,["-I",str(script)],"\n".join(lines))
            require(result.returncode == 0 and json.loads(result.stdout) == expected, "script output mismatch")
    elif key == "web":
        require(all(x in body for x in [".test",".example",".invalid",".localhost"]), "reserved names incomplete")
        require(re.search(r"https://www\.rfc-editor\.org/(?:rfc/rfc2606|info/rfc2606)", body), "wrong original source")
        for steps in state["steps"].values():
            for st in steps:
                label = st.get("label", "")
                snippet = str(st.get("detail", ""))
                if (st["status"] == "done" and "rfc-editor.org" in label and
                        re.search(r"curl|wget|urlopen|fetch|打开|open", label, re.I) and
                        ".localhost" in snippet and ".invalid" in snippet):
                    return {"sourceEvidence": st}
        raise NeedsReview("答案与来源匹配，现有工具日志不足以独立证明读取正文")
    else:
        # Text can be phrased in more than one valid way. Unrecognized phrasing goes to manual review.
        # Start/end times may be separate Markdown table cells on the same city row.
        time_cells = re.sub(r"(\d{1,2}:\d{2})[ \t]*\|[ \t]*(?=\d{1,2}:\d{2})", r"\1-", body)
        normalized = re.sub(r"[\s*|()（）]", "", time_cells.lower()).replace("–","-").replace("—","-").replace("至","-")
        patterns = {
            "translation":[r"exports?",r"30(?:th)?nov|nov(?:ember)?30",r"22:15",r"22:45",r"beijing",r"log.?in|signin",r"brows",r"pause|unavailable|suspend|interrupt|disabled",r"as(?:usual|normal)|remain|continu|unaffected|available"],
            "handover":[r"阿莲.{0,20}周五18:00",r"小齐.{0,22}下周一12:00",r"回滚.{0,35}(?:待|未|无).{0,18}(?:待|未|无)"],
            "timezone":[r"纽约.{0,24}08:00-09:00",r"伦敦.{0,24}13:00-14:00",r"新加坡.{0,24}21:00-22:00"],
            "visual":[r"maple.{0,22}10:00-11:00"],
            "pdf":[r"0?9:40",r"cedar307",r"laptop",r"charger",r"(?:p(?:age)?\.?2|第2页)[\]).。]*$"],
            "impossible":[r"不可行|无法|不能|不可能",r"(?:1|一)(?:个)?(?:完整的?)?(?:4人)?(?:小)?组|两组|2组|8[>＞]6"],
            "denominator":[r"12",r"访问|访客",r"不能|无法|不足|不代表|不能据此",r"转化率"],
            "release":[r"bercy-0\.1\.5-arm64\.dmg",r"78",r"(?:连续.{0,12}3|3轮|三轮)"],
            "reuse":[r"东京.{0,24}17:00-17:30",r"伦敦.{0,24}08:00-08:30",r"柏林.{0,24}09:00-09:30"],
        }[key]
        if key == "release":
            patterns.append(json.loads((INPUTS/"previous-verification.json").read_text())["sha256"])
        if not all(re.search(p, normalized) for p in patterns):
            raise NeedsReview("自由文本未满足自动识别规则，请对照原请求复核：" + body)
        if key == "visual" and len(set(re.findall(r"\d\d:\d\d-\d\d:\d\d", normalized))) > 1:
            raise NeedsReview("截图答案出现额外时段，请核对：" + body)
    return {"answer":body}
