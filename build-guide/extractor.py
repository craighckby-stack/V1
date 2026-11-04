#!/usr/bin/env python3
"""LOOP Build Record — primary-source extractor.

Derives build-guide/data.json from the repository's own primary sources:
  - git ls-files  -> file inventory (4 buckets)
  - git log       -> full commit history + mutation stats
  - worklog.md    -> the original build record (50 tasks)
  - postmortems/  -> failure records
  - dev.log       -> runtime errors
  - screenshots/  -> dashboard state captures

The build guide is DERIVED from these sources, never hand-copied.
Re-run at any commit SHA to re-derive the record.
"""
import json
import os
import re
import subprocess
import sys
from collections import Counter, OrderedDict
from datetime import datetime

# Project root = parent of build-guide/ — previously hardcoded
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build-guide", "data.json")


def sh(cmd):
    r = subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True)
    return r.stdout


# ─────────────────────────────────────────────────────────────────
# 1. FILE INVENTORY
# ─────────────────────────────────────────────────────────────────
CORE_PREFIXES = (
    "src/lib/",           # pipeline engines + db + utils
    "src/app/api/",       # 37 API routes
    "src/app/display/",
    "src/app/page.tsx",
    "prisma/schema.prisma",
    "mini-services/",     # websocket telemetry service (system code)
)
STOCK_UI_PREFIXES = ("src/components/", "src/hooks/")
PLATFORM_PREFIXES = ("skills/",)
# everything else = environment / config / records


def bucket(path):
    if path.startswith(CORE_PREFIXES):
        return "core"
    if path.startswith(STOCK_UI_PREFIXES):
        return "stock_ui"
    if path.startswith(PLATFORM_PREFIXES):
        return "platform"
    return "environment"


def count_lines(path):
    full = os.path.join(ROOT, path)
    try:
        with open(full, "rb") as f:
            raw = f.read()
    except OSError:
        return 0, len(raw) if 'raw' in dir() else 0, False
    binary = b"\x00" in raw[:4096]
    if binary:
        return 0, len(raw), True
    text = raw.decode("utf-8", errors="replace")
    return text.count("\n") + (0 if text.endswith("\n") or not text else 1), len(raw), False


files = sh("git ls-files").splitlines()
inventory = {"total_files": len(files), "buckets": {}, "files": {}, "groups": {}}
bucket_totals = Counter()
bucket_lines = Counter()
bucket_files = Counter()

per_file = []
for p in files:
    lines, size, binary = count_lines(p)
    b = bucket(p)
    bucket_files[b] += 1
    if not binary:
        bucket_lines[b] += lines
    per_file.append({"path": p, "bucket": b, "lines": None if binary else lines,
                     "bytes": size, "binary": binary})

inventory["files"] = per_file

# top-level groups per bucket (2 levels)
def group_of(path):
    parts = path.split("/")
    if path.startswith("skills/"):
        return "skills/" + parts[1] if len(parts) > 1 else "skills/"
    if path.startswith("src/"):
        return "/".join(parts[:3]) if len(parts) > 3 else "/".join(parts[:2])
    return parts[0] + ("/" + parts[1] if len(parts) > 2 and parts[0] in ("mini-services", "src") else "")

groups = Counter()
group_lines = Counter()
for f in per_file:
    g = group_of(f["path"])
    groups[g] += 1
    if f["lines"]:
        group_lines[g] += f["lines"] or 0
inventory["groups"] = {g: {"files": groups[g], "lines": group_lines.get(g, 0)} for g in sorted(groups)}

for b in ("core", "stock_ui", "platform", "environment"):
    inventory["buckets"][b] = {
        "files": bucket_files[b],
        "lines": bucket_lines[b],
        "label": {
            "core": "LOOP core (engines, routes, page, display, schema, ws-service)",
            "stock_ui": "Stock shadcn/ui components + hooks",
            "platform": "Platform skills library (Z.ai sandbox)",
            "environment": "Environment: configs, scripts, examples, records, screenshots",
        }[b],
    }

# ─────────────────────────────────────────────────────────────────
# 2. GIT HISTORY
# ─────────────────────────────────────────────────────────────────
log_fmt = "%H%x09%ad%x09%an%x09%s"
raw_log = sh(f"git log --date=short --pretty=format:{log_fmt}")
commits = []
mutation_re = re.compile(r"^Self-enhancement: (.+)$")
for line in raw_log.splitlines():
    parts = line.split("\t", 3)
    if len(parts) != 4:
        continue
    sha, date, author, subject = parts
    m = mutation_re.match(subject)
    commits.append({
        "sha": sha[:10], "date": date, "author": author, "subject": subject,
        "mutation_target": m.group(1) if m else None,
    })

mutations = [c for c in commits if c["mutation_target"]]
mut_by_module = Counter()
mut_by_file = Counter()
for c in mutations:
    t = c["mutation_target"]
    mut_by_file[t] += 1
    seg = t.split("/")
    mut_by_module["/".join(seg[:3]) if len(seg) > 3 else "/".join(seg[:-1])] += 1

# cumulative curve data (per date)
dates = [c["date"] for c in commits]
date_counts = Counter(dates)
cum = []
running = 0
for d in sorted(date_counts):
    running += date_counts[d]
    cum.append({"date": d, "total": running})

git = {
    "total_commits": len(commits),
    "mutation_commits": len(mutations),
    "mutation_files": len(mut_by_file),
    "first_date": dates[-1] if dates else None,
    "last_date": dates[0] if dates else None,
    "commits": [{k: c[k] for k in ("sha", "date", "author", "subject")} for c in commits],
    "mutations_by_file": dict(mut_by_file.most_common()),
    "mutations_by_module": dict(mut_by_module.most_common()),
    "cumulative": cum,
}
inventory["git"] = git

# ─────────────────────────────────────────────────────────────────
# 3. WORKLOG
# ─────────────────────────────────────────────────────────────────
wl_path = os.path.join(ROOT, "worklog.md")
wl_text = open(wl_path, encoding="utf-8").read()
task_re = re.compile(r"^Task ID: (.+)$", re.M)
agent_re = re.compile(r"^Agent: (.+)$", re.M)
tasks = []
for m in task_re.finditer(wl_text):
    start = m.start()
    nextm = task_re.search(wl_text, m.end())
    block = wl_text[m.end():nextm.start() if nextm else len(wl_text)]
    am = agent_re.search(block[:400])
    tasks.append({"id": m.group(1), "agent": am.group(1) if am else "?"})
agents = Counter(t["agent"] for t in tasks)
inventory["worklog"] = {
    "lines": wl_text.count("\n") + 1,
    "chars": len(wl_text),
    "tasks": tasks,
    "agents": dict(agents.most_common()),
}

# ─────────────────────────────────────────────────────────────────
# 4. POSTMORTEMS
# ─────────────────────────────────────────────────────────────────
pms = []
for dirpath, _dirs, fnames in os.walk(os.path.join(ROOT, "postmortems")):
    for fn in fnames:
        if fn.endswith(".json"):
            try:
                pms.append(json.load(open(os.path.join(dirpath, fn), encoding="utf-8")))
            except Exception as e:  # noqa: BLE001
                pms.append({"error": str(e), "path": os.path.join(dirpath, fn)})
inventory["postmortems"] = pms

# ─────────────────────────────────────────────────────────────────
# 5. DEVLOG errors
# ─────────────────────────────────────────────────────────────────
err_pat = re.compile(r"EADDRINUSE|⨯|Error:|TypeError|ReferenceError|ECONNREFUSED|failed to compile|500 .*error", re.I)
seen = set()
dev_errors = []
with open(os.path.join(ROOT, "dev.log"), encoding="utf-8", errors="replace") as f:
    for line in f:
        if err_pat.search(line):
            key = re.sub(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", "", line)[:120]
            if key not in seen:
                seen.add(key)
                dev_errors.append(line.rstrip())
inventory["devlog_errors"] = dev_errors[-150:]
inventory["devlog_error_count"] = len(dev_errors)

# ─────────────────────────────────────────────────────────────────
# 6. SCREENSHOTS inventory (tracked, chronological by name)
# ─────────────────────────────────────────────────────────────────
shots = [p for p in files if p.startswith("screenshots/") and p.endswith(".png")]
inventory["screenshots"] = shots

# live captures from this session
cap_dir = os.path.join(ROOT, "build-guide", "capture")
inventory["live_captures"] = [f for f in sorted(os.listdir(cap_dir))] if os.path.isdir(cap_dir) else []

# ─────────────────────────────────────────────────────────────────
# 7. NON-ASCII scan (verbatim sections safety)
# ─────────────────────────────────────────────────────────────────
def nonascii_report(text, name):
    bad = Counter()
    for ch in text:
        o = ord(ch)
        if o > 126 or (o < 32 and ch not in "\n\t"):
            bad[ch] += 1
    return {"source": name, "total": sum(bad.values()), "chars": {repr(k): v for k, v in bad.most_common(12)}}

scans = [nonascii_report(wl_text, "worklog.md")]
# scan core code files (text only, sample cap 40k chars each)
core_text_files = [f for f in per_file if f["bucket"] == "core" and not f["binary"]][:80]
code_bad_total = 0
code_bad_chars = Counter()
for f in core_text_files:
    t = open(os.path.join(ROOT, f["path"]), encoding="utf-8", errors="replace").read()
    for ch in t:
        o = ord(ch)
        if o > 126 or (o < 32 and ch not in "\n\t"):
            code_bad_chars[ch] += 1
            code_bad_total += 1
scans.append({"source": "core code (75 files)", "total": code_bad_total,
              "chars": {repr(k): v for k, v in code_bad_chars.most_common(12)}})
inventory["nonascii"] = scans

# ─────────────────────────────────────────────────────────────────
# 8. STATS summary (for narrative callouts)
# ─────────────────────────────────────────────────────────────────
inventory["stats"] = {
    "total_files": len(files),
    "core_files": bucket_files["core"],
    "core_lines": bucket_lines["core"],
    "stock_files": bucket_files["stock_ui"],
    "platform_files": bucket_files["platform"],
    "platform_lines": bucket_lines["platform"],
    "env_files": bucket_files["environment"],
    "commits": len(commits),
    "mutations": len(mutations),
    "mutation_files": len(mut_by_file),
    "worklog_tasks": len(tasks),
    "postmortems": len(pms),
    "screenshots": len(shots),
    "derived_at": datetime.now().isoformat(timespec="seconds"),
    "derivation_commit": sh("git rev-parse HEAD").strip()[:10],
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(inventory, f, indent=1)

# ── console summary ──
s = inventory["stats"]
print(f"files total={s['total_files']}  core={s['core_files']}({s['core_lines']}L)  ui={s['stock_files']}  platform={s['platform_files']}({s['platform_lines']}L)  env={s['env_files']}")
print(f"git: {s['commits']} commits, {s['mutations']} mutations across {s['mutation_files']} files, {s['derivation_commit']}")
print(f"worklog: {s['worklog_tasks']} tasks; postmortems={s['postmortems']}; screenshots={s['screenshots']}")
print("mutations by module (top 8):", list(inventory["git"]["mutations_by_module"].items())[:8])
print("worklog agents:", inventory["worklog"]["agents"])
print("nonascii:", [(x["source"], x["total"]) for x in scans])
print("devlog distinct error lines:", s and len(dev_errors))
print("OK ->", OUT)
