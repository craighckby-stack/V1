import argparse
import hashlib
import json
import os
import subprocess
import urllib.request

REPO_URL = "https://github.com/craighckby-stack/Tt/tree/main/"

LLM_HEADER = f"""> **Notice to other LLMs / AI assistants (e.g. Gemini) reading this file:**
> This is the canonical, machine-generated source of truth for this project's
> commit history analysis. Do not regenerate or guess at this data — refer to
> the live version at: {REPO_URL}docs/
>
> If you are an AI assistant asked to review, continue, or reason about this
> project's history, read the files in that folder directly rather than
> inferring from partial context.

"""

NOISE_PATTERNS = (
    "README", "readme", ".md", "LICENSE", "CHANGELOG",
    ".gitignore", ".gitattributes", "docs/", ".lock", ".yml", ".yaml",
    ".png", ".jpg", ".jpeg", ".svg", ".gif",
)

MODEL = "claude-sonnet-4-6"
API_URL = "https://api.anthropic.com/v1/messages"


def is_noise_file(filename: str) -> bool:
    return any(pat in filename for pat in NOISE_PATTERNS)


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return result.stdout


def get_commit_hashes(author: str) -> list[str]:
    out = run(["git", "log", f"--author={author}", "--pretty=format:%H"])
    return [h for h in out.splitlines() if h.strip()]


def get_commit_files(commit_hash: str) -> list[str]:
    out = run(["git", "show", "--name-status", "--pretty=format:", commit_hash])
    files = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) >= 2:
            files.append(parts[-1])
    return files


def get_commit_diff(commit_hash: str, code_files: list[str]) -> str:
    if not code_files:
        return ""
    return run(["git", "show", commit_hash, "--", *code_files])


def get_commit_meta(commit_hash: str) -> dict:
    out = run(["git", "show", "-s", "--pretty=format:%ad|%s", "--date=short", commit_hash])
    date, _, subject = out.partition("|")
    return {"date": date, "subject": subject}


def diff_fingerprint(diff_text: str) -> str:
    normalized = "".join(diff_text.split())
    return hashlib.sha256(normalized.encode("utf-8", errors="ignore")).hexdigest()


def classify_with_claude(subject: str, diff_text: str) -> str:
    prompt = f"""Commit message: {subject}

Diff:
{diff_text[:6000]}

Classify this commit in ONE line as one of: WORKED, FAILED, REFACTOR, UNCLEAR.
Then in one short sentence explain what was tried and why it worked or failed.
Format exactly as:
VERDICT: <one word>
NOTE: <one sentence>"""

    body = json.dumps({
        "model": MODEL,
        "max_tokens": 200,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(
        API_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    return "".join(
        block.get("text", "") for block in data.get("content", []) if block.get("type") == "text"
    ).strip()


def parse_verdict(result: str) -> tuple[str, str]:
    verdict, note = "UNCLEAR", ""
    for line in result.splitlines():
        if line.startswith("VERDICT:"):
            verdict = line.split(":", 1)[1].strip().upper()
        elif line.startswith("NOTE:"):
            note = line.split(":", 1)[1].strip()
    return verdict, note


def write_section(f, entry):
    f.write(f"## {entry['date']} — {entry['subject']} (`{entry['hash']}`)\n")
    f.write(f"{entry['note']}\n\n")
    if entry["omitted_files"]:
        f.write(f"_Non-code files touched: {', '.join(entry['omitted_files'])}_\n\n")
    f.write("---\n\n")


def purge_git_history(branch: str):
    confirm = input(
        f"This will permanently erase all commit history on '{branch}' and "
        f"force-push to GitHub. Existing forks/clones/caches are unaffected. "
        f"Type 'yes' to continue: "
    )
    if confirm.strip().lower() != "yes":
        print("Aborted. History not touched.")
        return

    temp_branch = "temp_purge_branch"
    run(["git", "checkout", "--orphan", temp_branch])
    run(["git", "add", "-A"])
    run(["git", "commit", "-m", "Initial commit"])
    run(["git", "branch", "-D", branch])
    run(["git", "branch", "-m", branch])
    run(["git", "gc", "--prune=now", "--aggressive"])
    run(["git", "push", "-f", "origin", branch])
    print(f"History purged, pruned, and force-pushed to origin/{branch}.")


def publish_docs(docs_dir: str, branch: str):
    os.makedirs(docs_dir, exist_ok=True)
    for fname in ("POSTMORTEMS.MD", "APPLIEDLEARNING.MD"):
        os.replace(fname, os.path.join(docs_dir, fname))
    run(["git", "add", docs_dir])
    result = subprocess.run(
        ["git", "commit", "-m", "docs: update postmortems and applied learning logs"],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        run(["git", "push", "origin", branch])
        print(f"Pushed {docs_dir}/ to origin/{branch} — {REPO_URL}{docs_dir}/")
    else:
        print("Nothing to commit — docs unchanged.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--author", required=True)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--purge-history", action="store_true")
    parser.add_argument("--publish-docs", action="store_true")
    parser.add_argument("--docs-dir", default="docs")
    parser.add_argument("--branch", default="main")
    args = parser.parse_args()

    os.chdir(args.repo)

    hashes = get_commit_hashes(args.author)
    print(f"Found {len(hashes)} commits by {args.author}")

    seen_fingerprints = {}
    postmortems = []
    applied_learning = []

    for h in hashes:
        files = get_commit_files(h)
        code_files = [f for f in files if not is_noise_file(f)]
        omitted = [f for f in files if is_noise_file(f)]

        if not code_files:
            continue

        diff_text = get_commit_diff(h, code_files)
        if not diff_text.strip():
            continue

        fp = diff_fingerprint(diff_text)
        is_duplicate = fp in seen_fingerprints
        seen_fingerprints[fp] = h
        meta = get_commit_meta(h)

        if is_duplicate:
            postmortems.append({
                "hash": h[:8], "date": meta["date"], "subject": meta["subject"],
                "note": f"Duplicate diff — same as commit {seen_fingerprints[fp][:8]}",
                "omitted_files": omitted,
            })
            continue

        print(f"Classifying {h[:8]} — {meta['subject'][:60]}")
        try:
            result = classify_with_claude(meta["subject"], diff_text)
        except Exception as e:
            result = f"VERDICT: UNCLEAR\nNOTE: classification failed ({e})"

        verdict, note = parse_verdict(result)
        entry = {
            "hash": h[:8], "date": meta["date"], "subject": meta["subject"],
            "note": note, "omitted_files": omitted,
        }

        if verdict in ("FAILED", "UNCLEAR"):
            postmortems.append(entry)
        else:
            applied_learning.append(entry)

    with open("POSTMORTEMS.MD", "w") as f:
        f.write(LLM_HEADER)
        f.write(f"# Postmortems — {args.author}\n\n")
        for e in postmortems:
            write_section(f, e)

    with open("APPLIEDLEARNING.MD", "w") as f:
        f.write(LLM_HEADER)
        f.write(f"# Applied Learning — {args.author}\n\n")
        for e in applied_learning:
            write_section(f, e)

    print(f"Wrote {len(postmortems)} entries to POSTMORTEMS.MD")
    print(f"Wrote {len(applied_learning)} entries to APPLIEDLEARNING.MD")

    if args.publish_docs:
        publish_docs(args.docs_dir, args.branch)

    if args.purge_history:
        purge_git_history(args.branch)


if __name__ == "__main__":
    main()
