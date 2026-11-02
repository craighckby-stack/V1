"""LOOP Build Record — narrative content, chapters 7-8."""

# Constants for security verification
AUDIT_CHECKLIST = [
    "Branch claims: verify against the remote API. Local remote-tracking refs are a cache, and a cache can be stale while looking authoritative.",
    "Loop-running claims: the status route is the primary source; the console is a view of it, not an independent witness.",
    "Server-running claims: check which process owns the port before believing the log's startup line (5.3).",
    "Persistence claims: after any restart, compare the DB row against the state file — the file is the source of truth (6.2).",
    "Cost claims: a single-file cycle is roughly 15,000 tokens; whole-tree scans are an order of magnitude more (6.4). If the quota is draining faster than that model predicts, the allowlist or the retry path has regressed."
]

SECURITY_VERIFICATION_STEPS = [
    "Verify the self-heal path after a machine restore: the state file should re-seed the DB rows, and the push-target status route should answer with the configured repository and branch counter intact (5.1).",
    "Verify that git remote -v shows a clean URL with no credentials (3.4).",
    "Check which process owns the port before believing the log's startup line (5.3).",
    "Compare the DB row against the state file after any restart — the file is the source of truth (6.2)."
]

# Type annotations for structured content
ContentSection = tuple[str, list]
ChapterContent = list[ContentSection]

CH7: ChapterContent = [
    ("h1", "Chapter 7 — Operator's Manual"),
    ("p", "This chapter is the day-to-day manual: how to start the system, run the loop, read the "
          "dashboard, and — the part that earns its place — audit a system that reports its own state. "
          "Everything here is written against the shipped configuration at the derivation commit."),
    ("h2", "7.1 Starting and stopping"),
    ("bullet", [
        "The dev server runs on port 3000, started detached with output to dev.log, exactly one instance. "
        "A second instance fails on the port; that error is visible in the log, which is the first thing "
        "to read on any start (4.3).",
        "The only user-visible route is the dashboard at the root path. Everything else is API surface.",
        "Stop with SIGKILL to the whole tree — never a bare kill of the front process (5.3). If anything "
        "behaves oddly across a restart, delete .next before the next start.",
        "After a machine restore, verify the self-heal path once: the state file should re-seed the DB "
        "rows, and the push-target status route should answer with the configured repository and branch "
        "counter intact (5.1).",
    ]),
    ("h2", "7.2 Running the loop"),
    ("p", "START begins the continuous loop; STOP interrupts within a second, including mid-cooldown; "
          "TRIGGER runs a single cycle on demand; RESCAN rebuilds the task list. The CONFIG panel holds "
          "the GitHub push target: PAT, repository, branch, and the auto-create option. The token is "
          "stored in the 0600 state file and the DB cache, injected per-push through the environment, and "
          "never written into git configuration — verify occasionally that git remote -v shows a clean "
          "URL with no credentials (3.4). The saturation panel lists each allowlisted file with its "
          "no-growth count out of three, an unlock button per locked file, and PASS COMPLETE when every "
          "target has declared itself done."),
    ("h2", "7.3 Reading the dashboard"),
    ("bullet", [
        "The cooldown chip appears when the rate-limit gate is active and counts down against the "
        "absolute end time — if it ticks, the gate is healthy; if the console freezes with no chip, "
        "investigate (5.4).",
        "Console lines are color-coded by level; the stream auto-scrolls with a jump-to-latest control, "
        "and the buffer survives display hot-swaps because it lives outside the component (3.5).",
        "'Branch for this mutation: loop-NN' in the console is the branch counter state; the number "
        "survives restarts through the persistence layer.",
        "A 429 line in the console is quota, not an outage, in this environment (5.6) — the correct "
        "response is patience or a different allowlist, not a provider change.",
    ]),
    ("h2", "7.4 The audit checklist"),
    ("p", "The system reports its own state, and at least once it reported state that was not true "
          "(5.2). The audit that caught it generalizes, and takes minutes:"),
    ("numbered", AUDIT_CHECKLIST),
    ("h2", "7.5 What to expect, honestly"),
    ("p", "In this environment the LLM quota is the binding constraint. A healthy session looks like: a "
          "cycle starts, scans one file, pins the ratchet, and either produces an accepted mutation or a "
          "correctly-classified no-growth. A quota-starved session looks like a countdown chip and a "
          "console that logs a pause every sixty seconds — which is the designed behavior, not a hang. "
          "The operator's leverage is the allowlist and the unlock button; the system's leverage is the "
          "gates. Neither substitutes for the audit checklist above, which is the one component that has "
          "caught every real failure so far."),
]

CH8: ChapterContent = [
    ("h1", "Chapter 8 — The Reproducibility Test"),
    ("p", "The final question for this record: can the system be rebuilt by a different frontier model, "
          "from a specification alone? The repository carries a 607-line build prompt "
          "(gemini-build-prompt.md) that specifies the entire system with exactly one intentional delta — "
          "the LLM provider layer is Gemini instead of the original endpoint. Everything else is specified "
          "as it shipped: the pipeline stages, the rate-limit gate, the saturation locks, the persistence "
          "ordering, the API surface, the dashboard, and ten acceptance criteria. The prompt was handed to "
          "a current frontier model in a single shot, at zero temperature, with maximum output length, "
          "under an explicit instruction against abbreviation."),
    ("h2", "8.1 The result"),
    ("p", "The build failed, and it failed in a specific, repeatable way. The model could hold the full "
          "607-line specification in input, but could not emit the roughly 40 interdependent strict-"
          "TypeScript files in one output window. It compressed — 'existing code' ellipses, abbreviated "
          "files, skipped tests — and one abbreviation anyw
// ... (truncated)