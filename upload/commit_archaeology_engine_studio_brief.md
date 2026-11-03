# Commit Archaeology Engine — Google AI Studio Build Brief

**Project:** Commit Archaeology Engine (CAE)
**Target platform:** Google AI Studio (Gemini-powered hosted app)
**Companion to:** EMG Core — Ephemeral Mind Gem (`craighckby-stack/EMG-Tests`)
**Status:** Reference implementation complete as local CLI; this brief proposes the Studio-hosted evolution.

---

## 1. Problem

A developer with several years of commit history has, in effect, a private corpus of every mistake they have ever made and every recovery they have ever engineered. That corpus is currently inert. `git log` will print it, but it will not:

- Tell you which commits were failures and which were successes.
- Pair each failure with the commit that later fixed it.
- Surface cross-commit patterns: architectural hotspots, recurring problem classes, skill growth over time.
- Produce a portable artifact another LLM (or another developer, or your future self) can read to avoid repeating the same mistakes.

EMG Core already solves this *inside* an active mutation cycle — it writes structured postmortems to `docs/POSTMORTEMS.md` at the moment of failure, with machine-copied compiler evidence and generalized negative constraints. But that loop only covers code EMG itself touches. The rest of a developer's history — commits made before EMG existed, commits to repos EMG never ran on, manual commits in editors — is invisible to it.

CAE closes that gap. It treats git history as the input corpus and produces three deliverables: a complete record of what worked, a complete record of what didn't (with each failure linked to its fix), and an emergent-idea digest that no single commit could surface alone.

---

## 2. What it does

Given a git repository and an author handle, CAE produces three markdown files:

### `CORRECT.md`
Full content of every commit that worked — subject, body, file list, complete diff. Each entry is a self-contained block you can read top to bottom. This is the positive corpus: "here is code I wrote that did not get reverted, was not self-described as broken, and was not immediately patched by the next commit."

### `WRONG.md`
Full content of every commit that didn't work, with the failure reason and a link to the commit that fixed it. Three detection paths run in order:

1. **Reverted** — a later commit body contains `This reverts commit <hash>`. The reverted commit is wrong; the revert itself is correct (it is the fix).
2. **Self-identified failure** — the commit subject matches `wip`, `broken`, `attempt`, `didn't work`, `failed`, `fixup`, `squash`, `hotfix`, `rollback`, `hacky`, `kludge`, etc.
3. **Immediate fix** — the next commit touches overlapping files and has `fix` / `fixes` / `bugfix` / `patch` in its subject. The earlier commit is wrong; the fix is correct.

For each wrong commit, the file records `**Fixed by:** <short-hash>` so the reader can jump to the corresponding entry in `CORRECT.md` and see exactly how the recovery was structured. This is the central affordance: every failure is paired with its recovery.

### `stuff.md`
Emergent ideas that no single commit could surface. Two layers:

**Deterministic (always produced):**
- Most-touched files (architectural hotspots)
- Files with iterative wrong → correct cycles (hard-won lessons)
- Recurring keywords in commit subjects (themes)
- Long gaps between commits to the same file (hard problems revisited)
- Largest commits by file count (big refactors)
- Burst days (sessions with the most commits)

**LLM-surfaced (Gemini-powered):** A compact one-line-per-commit digest is sent to Gemini with instructions to find cross-commit patterns — recurring failure classes, skill growth visible across time, surprising solutions worth highlighting, architectural decisions that kept causing problems. The prompt explicitly forbids inventing facts not present in the data and forbids marketing adjectives, so the output reads as neutral observation rather than LLM prose.

---

## 3. Why Gemini specifically

CAE's LLM workload has three properties that make Gemini the right fit:

**Long-context diff analysis.** A real commit history can produce digests of 10,000+ characters. Gemini's context window accommodates the full digest in a single call, so the model sees the entire history at once and can draw connections between commits made months apart. Chunked calls into a shorter-context model would miss exactly the cross-commit patterns the digest is meant to surface.

**Generative pattern-finding, not classification.** The LLM pass is not asking "is this commit good or bad" (that is handled deterministically). It is asking "what does this body of work reveal that no single commit reveals." That is an open-ended generative task, which is what Gemini is built for.

**Cost and speed for batch runs.** A developer with 1,000 commits runs this once a quarter. `gemini-2.0-flash` is cheap enough and fast enough that the LLM pass completes in seconds and costs pennies per run. That makes CAE practical to run repeatedly as a habit, not a one-time event.

**Pluggable by design.** The reference implementation supports `--llm gemini` (default), `--llm deepseek`, and `--llm none`. The Studio-hosted version standardizes on Gemini but the underlying dispatch is provider-agnostic.

---

## 4. Reference implementation (already working)

A local Python CLI exists at `/home/z/my-project/scripts/commit_history_split.py`. It is the canonical source of truth for behavior — the Studio app should match its detection logic, output format, and search/filter semantics exactly.

### CLI surface

```bash
# Basic run — produces CORRECT.md, WRONG.md, stuff.md in --out dir
python3 commit_history_split.py \
  --author craighckby-stack \
  --repo /path/to/clone \
  --out ./logs

# Search-filtered run — only commits matching a term
python3 commit_history_split.py \
  --author craighckby \
  --repo ./Tt \
  --search auth --search-field subject

# Regex search across all fields, with DeepSeek instead of Gemini
python3 commit_history_split.py \
  --author craighckby \
  --repo ./Tt \
  --llm deepseek \
  --search '^fix:' --search-regex --search-field subject

# No LLM at all (deterministic only)
python3 commit_history_split.py \
  --author craighckby \
  --repo ./Tt \
  --llm none
```

### Detection logic (deterministic, no LLM)

```python
REVERT_HASH_PATTERN = re.compile(
    r"This reverts commit ([0-9a-f]{7,40})", re.IGNORECASE
)
FAILURE_WORDS = re.compile(
    r"\b(wip|broken|attempt|trying|fixup|squash|didn'?t work|did not work|"
    r"failed|failure|revert|undo|rollback|hotfix|hacky|kludge)\b",
    re.IGNORECASE,
)
FIX_PATTERN = re.compile(r"\b(fix|fixes|fixed|bugfix|patch)\b", re.IGNORECASE)
```

- Commits are fetched oldest-first via two `git log` passes (metadata, then file lists), with full `git show` diffs.
- Revert detection runs first and marks the revert itself as `is_revert = True` so it is excluded from self-failure detection (the word "Revert" in its subject would otherwise match `FAILURE_WORDS`).
- Self-failure detection runs second.
- Immediate-fix detection runs last and can attach `fixed_by` to commits already flagged wrong by an earlier detector.

### Pluggable LLM dispatch

```python
def call_llm(prompt: str, provider: str, api_key: str,
             model: str | None = None) -> str:
    if provider == "gemini":
        return call_gemini(prompt, api_key, model=model or "gemini-2.0-flash")
    if provider == "deepseek":
        return call_deepseek(prompt, api_key, model=model or "deepseek-chat")
    raise ValueError(f"Unknown LLM provider: {provider}")
```

API keys resolve in order: `--llm-key` flag → env var (`GEMINI_API_KEY` / `DEEPSEEK_API_KEY`) → interactive prompt (suppressed with `--no-prompt-key`).

---

## 5. Example I/O walkthrough

### Input

A repo with this commit sequence by author `craighckby`:

```
[2026-09-13] 42f941a8  add feature: auth middleware          (1 file)
[2026-09-13] 34b1ec41  wip: trying inline jwt validation     (1 file)
[2026-09-13] 7689035e  fix: extract jwt validation into middleware  (1 file)
[2026-09-13] a1b2c3d4  add server scaffold                   (1 file)
[2026-09-13] 234ab33d  attempt: try express middleware chain (1 file)
[2026-09-13] 5e4e56be  fix: reorder middleware registration  (1 file)
[2026-09-13] f7e8d9c0  document auth flow                   (1 file)
[2026-09-13] b3a4c5d6  add config loader                    (1 file)
```

### Detection results

| Hash       | Subject                                     | Verdict | Fixed by  | Reason                                   |
|------------|---------------------------------------------|---------|-----------|------------------------------------------|
| `42f941a8` | add feature: auth middleware                | OK      | —         | —                                        |
| `34b1ec41` | wip: trying inline jwt validation           | WRONG   | `7689035e`| Self-identified WIP; followed by fix     |
| `7689035e` | fix: extract jwt validation into middleware | OK      | —         | —                                        |
| `a1b2c3d4` | add server scaffold                         | OK      | —         | —                                        |
| `234ab33d` | attempt: try express middleware chain       | WRONG   | `5e4e56be`| Self-identified attempt; followed by fix |
| `5e4e56be` | fix: reorder middleware registration        | OK      | —         | —                                        |
| `f7e8d9c0` | document auth flow                          | OK      | —         | —                                        |
| `b3a4c5d6` | add config loader                           | OK      | —         | —                                        |

### `WRONG.md` (excerpt)

```markdown
## 2026-09-13 -- wip: trying inline jwt validation (`34b1ec41`)

**Reason:** Self-identified as WIP/broken/failed in commit subject; fixed by 7689035e
**Fixed by:** `7689035e` (see CORRECT.md)

**Files:**
- `app.py`

**Commit message:**

\`\`\`
wip: trying inline jwt validation
\`\`\`

**Diff:**

\`\`\`diff
commit 34b1ec4188c0482721348164f35bff40fba47914
Author: craighckby <...>
Date:   Sun Sep 13 08:46:32 2026 +0000

    wip: trying inline jwt validation

diff --git a/app.py b/app.py
...
\`\`\`

---
```

### `stuff.md` (deterministic section)

```markdown
## Deterministic patterns

**Most-touched files (likely architectural hotspots):**
- `app.py` — 3 commits
- `server.ts` — 3 commits

**Files with iterative wrong->correct cycles (hard-won lessons):**
- `app.py` — 1 failed-and-fixed cycles
- `server.ts` — 1 failed-and-fixed cycles

**Recurring themes in commit subjects:**
- `middleware` — 4 commits
- `auth` — 2 commits
- `jwt` — 2 commits
- `validation` — 2 commits

**Burst days (most commits in a single day):**
- 2026-09-13 — 8 commits
```

### `stuff.md` (Gemini section, abridged)

```markdown
## LLM-surfaced patterns (Gemini)

- **Middleware is the architectural battleground.** Four of eight commits touch middleware, and both failure cycles (`34b1ec41` → `7689035e` and `234ab33d` → `5e4e56be`) are about middleware placement. Future work in this area should start from the extracted-middleware pattern established in `7689035e`, not from inline approaches.

- **Auth and validation cluster together.** Every commit touching `jwt` also touches `validation`, suggesting these should be treated as a single subsystem rather than separate concerns.

- **Skill trajectory visible.** The first failure (`34b1ec41`) was an inline approach; the fix (`7689035e`) extracted it. The second failure (`234ab33d`) was a registration-order issue, not an architectural one — a less fundamental mistake. The author's failure mode shifted from architectural to mechanical within a single session.
```

---

## 6. Proposed Google AI Studio implementation

The Studio app is a thin hosted wrapper around the same detection logic, with Gemini as the LLM provider. Three operating modes mirror the reference CLI:

### Mode 1: Paste-in (anonymous, no auth)

User pastes the output of `git log --author=X --pretty=format:... -p` into a textarea. The app parses, detects, and returns the three .md files as downloadable text. No GitHub token, no persistence, no account. This is the demo-mode entry point — anyone can try it with their own history in 30 seconds.

### Mode 2: GitHub-connected (token auth)

User provides a GitHub Personal Access Token (scoped `repo:read`). The app clones the specified repo server-side, runs the analysis, and returns the three files. Token is held in memory only; no persistence. This is the production path for analyzing real private repos.

### Mode 3: Scheduled (opt-in persistence)

User connects a GitHub account once and schedules a recurring run (weekly / monthly / on-push to a configured branch). Results are written back to the repo's `docs/` folder as `CORRECT.md`, `WRONG.md`, `stuff.md`, committed by the app, and surfaced in a Studio dashboard. This is the long-term value path — the postmortem ledger grows automatically as the developer works.

### Component layout

```
┌─────────────────────────────────────────────────────────────┐
│                    Studio Web Frontend                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Repo input   │  │ Search filter│  │ LLM provider pick│  │
│  │ (paste/URL)  │  │ (term/regex) │  │ (Gemini default) │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Results viewer (three tabs)               │ │
│  │   CORRECT.md   │   WRONG.md   │   stuff.md             │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Studio Backend (Node)                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Git ingest  │→ │ Detector    │→ │ Markdown renderer   │  │
│  │ (clone or   │  │ (determinis │  │ (CORRECT/WRONG/stuff│  │
│  │  paste parse│  │  tic 3-path)│  │ )                   │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│                         │                                   │
│                         ▼                                   │
│                ┌─────────────────┐                          │
│                │ Gemini dispatch │ (stuff.md LLM section)   │
│                │ (generative)    │                          │
│                └─────────────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

### API surface (proposed)

| Endpoint             | Method | Purpose                                                      |
|----------------------|--------|--------------------------------------------------------------|
| `/api/analyze`       | POST   | Accept repo URL or pasted log; return three .md files         |
| `/api/search`        | POST   | Re-filter an already-analyzed corpus by search term           |
| `/api/llm/refresh`   | POST   | Re-run only the Gemini pass on an existing analysis           |
| `/api/export`        | POST   | Return the three files as a .zip or individual downloads      |
| `/api/github/connect`| POST   | Exchange a GitHub PAT for a session-scoped analysis capability|
| `/api/schedule`      | POST   | Configure recurring runs (Mode 3)                             |

### LLM integration specifics

- **Model:** `gemini-2.0-flash` default, `gemini-2.5-pro` available for larger corpuses.
- **Prompt template:** Frozen in the reference implementation; the Studio app uses the same template verbatim to keep outputs reproducible.
- **Temperature:** 0.4 (low — we want neutral observation, not creative writing).
- **Max output tokens:** 1500 (forces concise output; if more is needed, the deterministic section carries the load).
- **Failure handling:** If the Gemini call fails (network, quota, malformed response), `stuff.md` is still written with the deterministic section intact and a clear `_(LLM pass skipped: <reason>)_` note in the LLM section.

---

## 7. Connection to EMG Core

CAE is not a replacement for EMG Core's postmortem ledger — it is the *retrospective complement* to it.

| Aspect                | EMG Core                                   | CAE                                            |
|-----------------------|--------------------------------------------|------------------------------------------------|
| **When it runs**      | Inside an active mutation cycle            | On demand, against full git history            |
| **What it sees**      | Mutations EMG itself proposed and rejected | Every commit the developer made, by any tool   |
| **Failure evidence**  | Machine-copied compiler / linter output    | Commit subject + diff + revert linkage         |
| **Constraint format** | `Symptom` / `EVIDENCE` / `CONSTRAINT`      | `Reason` / `Fixed by` / paired recovery diff   |
| **Output location**   | `docs/POSTMORTEMS.md` in the active repo   | Three standalone .md files                      |
| **LLM role**          | Generates mutations to be verified         | Surfaces cross-commit patterns in `stuff.md`    |

A developer using both gets a complete picture: EMG catches failures *as they happen during automated refactoring*, with exact line/column evidence. CAE catches failures *across all manual commits*, with the recovery strategy attached. The two ledgers can be concatenated or cross-referenced — every EMG postmortem is a special case of a CAE wrong-commit, with richer evidence.

Future integration: CAE's `stuff.md` could be ingested by EMG as an additional constraint source, so EMG's mutation proposals are guided not just by per-failure postmortems but by cross-commit patterns like "this developer's middleware code fails 3x more often than average; prefer simpler middleware shapes when proposing changes."

---

## 8. What we want from Google AI Studio

1. **Hosting for the three-mode web app described in section 6**, with Gemini as the default LLM provider. The reference CLI already proves the detection logic; the Studio app is primarily a hosted UI plus a GitHub-connected execution path.

2. **Generous Gemini quota for the LLM pass.** A typical analysis runs one Gemini call per repo per run, with a digest of 5,000–15,000 chars and a 1,500-token response. That is well within free-tier limits for individual users; scheduled-mode users would need a higher ceiling.

3. **Optional GitHub OAuth integration** for Mode 3 (scheduled runs against private repos). This is the path that turns CAE from a one-time analysis tool into a persistent learning ledger — the same role `docs/POSTMORTEMS.md` plays in EMG, but covering all of a developer's history rather than only EMG-touched code.

4. **Listing in the AI Studio app gallery** (if/when this ships), tagged under "developer tools" and "personal knowledge management." The target user is the same developer profile that adopts EMG: someone who treats their own past mistakes as a training corpus for their future self.

---

## 9. Out of scope (explicitly)

To keep the build focused, the following are explicitly out of scope for the first Studio release:

- **Multi-author analysis.** `--author` filters to one author; cross-author commit correlation is not supported.
- **Live git push / history rewriting.** Unlike an earlier (abandoned) version of the CLI, the Studio app does not offer to purge git history, force-push, or modify the source repo in any way. It only reads.
- **Real-time analysis.** Runs are batch, on-demand or scheduled. There is no streaming "as you commit" mode.
- **Embedding-based similarity.** Failure pairing is via revert-detection, subject-pattern matching, and file overlap — not semantic similarity. Embeddings are a possible v2 but not in v1.

---

## 10. Next steps

1. **Confirm the Studio app shape** (Mode 1 only for v1? Modes 1+2? All three?) — this determines auth complexity.
2. **Port the Python detection logic to the Studio backend.** The reference implementation is ~470 lines of Python; a Node port for the Studio backend is roughly equivalent in size and complexity, or the Python can be invoked as a subprocess if the Studio runtime permits.
3. **Lock the Gemini prompt template.** The reference prompt is in `find_llm_ideas` in the CLI; it should be frozen before the Studio app ships so outputs are reproducible across runs.
4. **Decide on persistence.** Mode 1 (paste-in) needs no persistence. Mode 3 (scheduled) needs a small store for GitHub tokens, schedules, and last-run state. Mode 2 can go either way.
5. **Ship Mode 1 first as a demo**, gather feedback on output quality, then expand.

---

*Reference implementation: `/home/z/my-project/scripts/commit_history_split.py`*
*Companion project: EMG Core — `craighckby-stack/EMG-Tests`*
