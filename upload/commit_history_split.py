#!/usr/bin/env python3
"""
Split a repo's commit history into two files: CORRECT.md and WRONG.md.

Detection (all deterministic, no LLM):
  1. REVERTED  - a later commit body contains "This reverts commit <hash>".
                The reverted commit is WRONG; the revert commit fixes it.
  2. SELF-FAIL - commit subject matches WIP / broken / attempt / didn't work /
                failed / fixup / squash / hotfix / rollback / undo.
  3. IMM-FIX   - the next commit on overlapping files has "fix" in its subject.
                The earlier commit is WRONG; the fix commit fixes it.

Everything else goes in CORRECT.md.

Usage:
  python3 commit_history_split.py --author craighckby --repo /path/to/repo
  python3 commit_history_split.py --author craighckby --repo /path/to/repo --out ./logs
"""

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path


REVERT_HASH_PATTERN = re.compile(
    r"This reverts commit ([0-9a-f]{7,40})", re.IGNORECASE
)
FAILURE_WORDS = re.compile(
    r"\b(wip|broken|attempt|trying|fixup|squash|didn'?t work|did not work|"
    r"failed|failure|revert|undo|rollback|hotfix|hacky|kludge)\b",
    re.IGNORECASE,
)
FIX_PATTERN = re.compile(r"\b(fix|fixes|fixed|bugfix|patch)\b", re.IGNORECASE)


@dataclass
class Commit:
    hash: str
    short: str
    date: str
    subject: str
    body: str
    files: list[str] = field(default_factory=list)
    is_wrong: bool = False
    wrong_reason: str = ""
    fixed_by: str | None = None  # short hash of the commit that fixes this


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return result.stdout


def get_commits(author: str, repo: Path) -> list[Commit]:
    """Return commits oldest-first. Two git log passes: metadata, then files."""
    meta_fmt = "%H%x1f%ad%x1f%s%x1f%b%x1e"
    meta_out = run([
        "git", "-C", str(repo), "log",
        f"--author={author}",
        f"--pretty=format:{meta_fmt}",
        "--date=short",
    ])
    files_out = run([
        "git", "-C", str(repo), "log",
        f"--author={author}",
        "--pretty=format:%H%x1e",
        "--name-only",
    ])

    commits: list[Commit] = []
    for raw in meta_out.split("\x1e"):
        raw = raw.strip("\n")
        if not raw.strip():
            continue
        parts = raw.split("\x1f")
        if len(parts) < 4:
            continue
        h, date, subject, body = parts[0], parts[1], parts[2], parts[3]
        commits.append(Commit(
            hash=h, short=h[:8], date=date, subject=subject, body=body,
        ))

    files_by_hash: dict[str, list[str]] = {}
    for raw in files_out.split("\x1e"):
        raw = raw.strip("\n")
        if not raw.strip():
            continue
        lines = raw.split("\n")
        h = lines[0].strip()
        files_by_hash[h] = [l for l in lines[1:] if l.strip()]

    for c in commits:
        c.files = files_by_hash.get(c.hash, [])

    # git log returns newest-first; reverse for chronological order
    return list(reversed(commits))


def detect_reverts(commits: list[Commit]) -> None:
    """Mark revert commits and link them to the commit they reverted."""
    by_full = {c.hash: c for c in commits}
    for c in commits:
        m = REVERT_HASH_PATTERN.search(c.body + " " + c.subject)
        if not m:
            continue
        target = m.group(1)
        target_commit = by_full.get(target) or next(
            (cc for cc in commits if cc.hash.startswith(target)), None
        )
        if not target_commit:
            continue
        if not target_commit.is_wrong:
            target_commit.is_wrong = True
            target_commit.wrong_reason = f"Reverted by {c.short} ({c.date})"
            target_commit.fixed_by = c.short


def detect_self_failures(commits: list[Commit]) -> None:
    """Mark commits whose own subject screams 'this didn't work'."""
    for c in commits:
        if c.is_wrong:
            continue
        if FAILURE_WORDS.search(c.subject):
            c.is_wrong = True
            c.wrong_reason = "Self-identified as WIP/broken/failed in commit subject"


def detect_immediate_fixes(commits: list[Commit]) -> None:
    """If the next commit fixes overlapping files, attach fixed_by.

    Runs even on commits already flagged wrong by an earlier detector, so a
    self-described WIP still gets linked to its follow-up fix.
    """
    for i, c in enumerate(commits[:-1]):
        if c.fixed_by:
            continue  # already paired (e.g. by revert detection)
        nxt = commits[i + 1]
        if not FIX_PATTERN.search(nxt.subject):
            continue
        overlap = set(c.files) & set(nxt.files)
        if overlap:
            if not c.is_wrong:
                c.is_wrong = True
                c.wrong_reason = (
                    f"Immediately followed by fix {nxt.short} on overlapping files "
                    f"({', '.join(sorted(overlap)[:3])}{'...' if len(overlap) > 3 else ''})"
                )
            else:
                c.wrong_reason += f"; fixed by {nxt.short}"
            c.fixed_by = nxt.short


def write_correct(path: Path, commits: list[Commit]) -> None:
    correct = [c for c in commits if not c.is_wrong]
    with path.open("w") as f:
        f.write(f"# Correct Commits ({len(correct)})\n\n")
        for c in correct:
            f.write(f"## {c.date} -- {c.subject} (`{c.short}`)\n")
            if c.files:
                shown = c.files[:5]
                f.write("Files: " + ", ".join(f"`{x}`" for x in shown))
                if len(c.files) > 5:
                    f.write(f", +{len(c.files) - 5} more")
                f.write("\n")
            f.write("\n")


def write_wrong(path: Path, commits: list[Commit]) -> None:
    wrong = [c for c in commits if c.is_wrong]
    with path.open("w") as f:
        f.write(f"# Wrong Commits ({len(wrong)})\n\n")
        for c in wrong:
            f.write(f"## {c.date} -- {c.subject} (`{c.short}`)\n")
            f.write(f"**Reason:** {c.wrong_reason}\n")
            if c.fixed_by:
                f.write(f"**Fixed by:** `{c.fixed_by}` (see CORRECT.md)\n")
            else:
                f.write("**Fixed by:** _no corresponding fix detected_\n")
            if c.files:
                shown = c.files[:5]
                f.write("Files: " + ", ".join(f"`{x}`" for x in shown))
                if len(c.files) > 5:
                    f.write(f", +{len(c.files) - 5} more")
                f.write("\n")
            f.write("\n")


def main() -> int:
    p = argparse.ArgumentParser(
        description="Split git history into CORRECT.md and WRONG.md"
    )
    p.add_argument("--repo", default=".", help="Path to git repo")
    p.add_argument("--author", required=True, help="Git author to filter")
    p.add_argument("--out", default=".", help="Directory to write the two .md files")
    args = p.parse_args()

    repo = Path(args.repo).resolve()
    if not (repo / ".git").exists():
        print(f"error: {repo} is not a git repository", file=sys.stderr)
        return 1

    commits = get_commits(args.author, repo)
    if not commits:
        print(f"No commits found by {args.author}", file=sys.stderr)
        return 1
    print(f"Found {len(commits)} commits by {args.author}")

    detect_reverts(commits)
    detect_self_failures(commits)
    detect_immediate_fixes(commits)

    n_wrong = sum(1 for c in commits if c.is_wrong)
    n_correct = len(commits) - n_wrong
    n_paired = sum(1 for c in commits if c.is_wrong and c.fixed_by)
    print(f"  {n_correct} correct, {n_wrong} wrong ({n_paired} paired with a fix)")

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    write_correct(out / "CORRECT.md", commits)
    write_wrong(out / "WRONG.md", commits)
    print(f"Wrote {out / 'CORRECT.md'}")
    print(f"Wrote {out / 'WRONG.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
