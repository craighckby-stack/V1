"""LOOP Build Record — narrative content, chapters 1-4.

Block types consumed by generate.py:
  ("h1", text) / ("h2", text) / ("h3", text)
  ("p", text)                      — body paragraph, <b> markup allowed
  ("bullet", [items])
  ("callouts", [(big, label), ...]) — stat strip (max 4)
  ("quote", text)
  ("figure", filename, caption)    — build-guide/charts/ or build-guide/capture/
  ("table", dict)                  — {"cols": [...], "rows": [[...]], "caption": str}
Placeholders like {mutations} are substituted from data.json stats at build time.
No literal braces are used in prose. No emoji, no arrows, no CJK.
"""

CH1 = [
    ("h1", "Chapter 1 — What LOOP Is"),
    ("p", "LOOP is an autonomous self-improvement system. It runs inside a Next.js 16 application, and its "
          "single visible surface is a dashboard at the root route: a live console streaming the state of a loop "
          "that runs in the server process. Each cycle of that loop scans an allowlist of the project's own "
          "source files, asks a large language model to enhance one of them, and then subjects the proposal to "
          "a sequence of mechanical gates that no proposal can talk its way past: an AST diff gate that rejects "
          "any mutation dropping an exported symbol, a ratchet test floor pinned before the LLM is ever called, "
          "and a two-reviewer debate that can reject or defer. If every gate endorses the change, the system "
          "writes the file, commits it, and pushes the commit to its own repository. The accepted mutation "
          "becomes a new loop-NN branch on GitHub. That branch is the proof of work: the system's evolution, "
          "timestamped and independently verifiable by anyone."),
    ("p", "The important property is not that the system improves code. It is that <b>nothing becomes real "
          "without passing the gates</b>. The LLM proposes; the machinery disposes. Across the recorded life of "
          "this instance the loop completed {commits} commits, of which {mutations} were accepted self-enhancement "
          "mutations touching {mutation_files} distinct source files, and every one of those {mutations} had to "
          "survive the same gate stack. The rejections — the proposals that were caught — are at least as "
          "valuable as the acceptances, and the one surviving postmortem record in Appendix F shows the gates "
          "rejecting a plausible-looking refactor for exactly the right reasons."),
    ("callouts", [
        ("1,317", "tracked files"),
        ("{commits}", "commits in 6 days"),
        ("{mutations}", "accepted mutations"),
        ("{mutation_files}", "files improved"),
    ]),
    ("p", "What LOOP is not: a product. It is a single research instance. It does not scale horizontally, it "
          "depends on one sandbox environment, and its LLM access is a single endpoint with a quota. Its value "
          "is not in deployment but in its <b>record</b>: the git history is a complete, replayable account of a "
          "program improving itself under supervision, and the postmortem and worklog records capture how it "
          "was grown, including the parts that were tried and removed. This document is the guide to that "
          "record — how the system was built, how it failed, how it was fixed, and what it would take to build "
          "another one."),
    ("h2", "1.1 The cycle in one paragraph"),
    ("p", "A running cycle looks like this from the inside. The scanner filters the project tree down to the "
          "TARGET_FILES allowlist (in this configuration: exactly one file, the display component "
          "src/app/display/console-stream.tsx). For one candidate file the loop pins a characterization test "
          "snapshot (the ratchet floor) before spending a single token on the LLM. Then it sends the file to "
          "the LLM under a strict output contract and parses the returned code. The AST diff gate compares "
          "exported symbols before and after; any dropped export is an immediate rejection, no matter how good "
          "the prose justification sounds. Survivors go to the debate: a Security reviewer and an Architecture "
          "reviewer each read the diff, and either can reject or defer the proposal. Only when both endorse "
          "does the loop write the file, commit it, and push. If the LLM endpoint answers 429, a rate-limit "
          "gate pauses the entire loop — whole cycles, not just the current call — and the dashboard shows a "
          "live countdown of the cooldown window."),
    ("h2", "1.2 The three artifacts that matter"),
    ("bullet", [
        "<b>The git history.</b> {commits} commits, {mutations} of them accepted mutations, each a verified "
        "small step. It is the only part of the system that an outside party can verify without trusting "
        "anyone's word.",
        "<b>The failure records.</b> The worklog (Appendix E, 1,783 lines) is the original build record — 50 "
        "tasks across five agents. The postmortem record (Appendix F) is what the system wrote about its own "
        "rejections. The failure catalog in Chapter 5 is what the operator observed on top of that.",
        "<b>The portable spec.</b> gemini-build-prompt.md (607 lines, in the repository root) specifies the "
        "entire system for reproduction with one intentional delta: a different LLM provider. Chapter 8 "
        "reports what happened when that spec was handed to another frontier model.",
    ]),
    ("p", "The rest of this document is organized as follows. Chapter 2 dissects the repository — what the "
          "1,317 files actually are, because 81 percent of them are not the system. Chapter 3 specifies the "
          "system as shipped, including the four subsystems added late in its life: the rate-limit gate, the "
          "saturation locks, the persistence layer, and the hot-swappable display. Chapter 4 is the build "
          "order — the staged method that works, and why one-shot generation does not. Chapter 5 is the "
          "failure catalog: every incident, in order, with symptoms, diagnosis, and fix. Chapter 6 is the "
          "decisions log — every removed bit and the reason it died. Chapter 7 is the operator's manual, "
          "including how to audit a system that reports things that are not true. Chapter 8 reports the "
          "reproducibility test. The appendices carry the primary sources verbatim: the full core source, "
          "the inventories, the complete commit history, the original worklog, the postmortem, and the "
          "dashboard states."),
]

CH2 = [
    ("h1", "Chapter 2 — Anatomy of the Repository"),
    ("p", "The first thing anyone sees in this repository is a number: 1,317 tracked files. That number is "
          "misleading, and understanding why is the fastest way to understand the system. A naive file count "
          "suggests a codebase far too large for its purpose. In reality four-fifths of the repository is the "
          "room the machine lives in, not the machine. The repository has four distinct layers, and only one "
          "of them is LOOP."),
    ("figure", "fig1-anatomy-donut.png",
     "Figure 1 — Repository anatomy by tracked file count. The platform skills library is 79 percent of the "
     "repository; the LOOP core is 6 percent."),
    ("table", {
        "cols": ["Layer", "Files", "Lines", "What it is"],
        "ratios": [0.22, 0.10, 0.13, 0.55],
        "rows": [
            ["LOOP core", "{core_files}", "{core_lines:,}", "The system: pipeline engines, 37 API routes, the page, the display component, the Prisma schema, the WebSocket telemetry service"],
            ["Stock shadcn/ui", "{stock_files}", "7,709", "Vendored UI kit and hooks. Reinstallable with one command; the loop never scans it"],
            ["Platform skills", "{platform_files}", "{platform_lines:,}", "The Z.ai sandbox's own skills library. Environment, not product. The loop never touches it"],
            ["Environment", "{env_files}", "mixed", "Configs, boot scripts, the worklog, the 607-line spec, 44 tracked screenshots, the Caddyfile, and one tracked .env (see 6.7)"],
        ],
        "caption": "Table 1 — The four layers. File counts and line counts are derived at build time from git ls-files.",
    }),
    ("p", "The percentages: the platform layer is {platform_files} files (79 percent of the repository, "
          "256,359 lines), the environment layer is {env_files} files, the stock UI kit is {stock_files} files, "
          "and the LOOP core — the actual subject of this document — is {core_files} files and {core_lines:,} "
          "lines. The lesson generalizes to any repo built on a platform that tracks its own libraries: count "
          "the layers before estimating anything. The page-count estimate for this very document was wrong "
          "twice for exactly this reason, first as 100 pages (counting only narrative) and then as 390 "
          "(over-counting the platform layer as if it were system code)."),
    ("h2", "2.1 What the loop actually scans"),
    ("p", "The scan stage is not a walk over the repository. It is a walk over an allowlist — TARGET_FILES in "
          "src/lib/pipeline/autonomous/saturation.ts. In the shipped configuration the allowlist contains "
          "exactly one path, src/app/display/console-stream.tsx, so a cycle scans one file, not 1,317. This is "
          "a cost decision as much as a safety one: a single-file cycle costs roughly 15,000 tokens, while a "
          "whole-tree scan would start above 100,000 and grow with the platform layer. An empty allowlist "
          "disables the loop entirely — the safest failure mode the design could choose, and a deliberate one."),
    ("p", "The allowlist also draws the engine/display boundary that Chapter 3 depends on. Files under "
          "src/app/display are hot-swappable presentation; files under src/lib/pipeline are the engine, and "
          "the engine does not hot-swap — it evolves between generations via committed mutations. The single "
          "allowlisted file sits on the display side of that line, which is why the running system can accept "
          "a mutation to it and show the change in the browser roughly a hundred milliseconds later, with no "
          "restart and no redeploy."),
    ("h2", "2.2 The environment layer is part of the record"),
    ("p", "Most of the environment layer would be deletable without harming the system, and a fresh build "
          "would not restore most of it. Three parts of it are load-bearing for the record and are treated as "
          "primary sources throughout this document: worklog.md (1,783 lines, the original build log across 50 "
          "tasks), gemini-build-prompt.md (607 lines, the reproduction spec), and the screenshots directory "
          "(44 PNG captures, including the incident states reproduced in Appendix G). The Caddyfile and the "
          ".zscripts boot scripts document how the sandbox hosts the system — the single exposed port, the "
          "XTransformPort gateway convention, the per-service ports. And one file in this layer is a known "
          "defect: .env is tracked by git in this repository, which matters because the sandbox auto-commits "
          "at session boundaries; that decision is recorded, not silently fixed, and is discussed in 6.7."),
]

CH3 = [
    ("h1", "Chapter 3 — The System As Shipped"),
    ("p", "This chapter specifies the system as it exists at the derivation commit — the frozen state that "
          "the appendices reproduce verbatim. Four subsystems were added late, each in response to a failure "
          "recorded in Chapter 5: the rate-limit gate (5.4), the saturation locks (5.5), the persistence layer "
          "(5.1), and the hot-swappable display. They are not features; they are scar tissue, and each one "
          "exists because the system without it failed in a documented way."),
    ("h2", "3.1 The six-stage enhancement pipeline"),
    ("p", "One candidate file passes through six stages. (1) Scan: the allowlist filter, described above. "
          "(2) Pin: the ratchet snapshot — a characterization test written for the file before the LLM is "
          "called, establishing the behavioral floor that any mutation must not break. (3) Enhance: the LLM "
          "call, under an output contract that requires a strict envelope; anything outside the contract is "
          "unparseable and treated as no code. (4) Gate: the AST diff — if the proposal drops an exported "
          "symbol that the original had, it is rejected with 'no symbol changes' discipline, regardless of "
          "any prose the model attached. (5) Debate: two reviewers, Security and Architecture, read the diff "
          "independently; either can reject or defer, and the surviving postmortem (Appendix F) shows a "
          "REQUIRES_REWRITE verdict from this stage in action. (6) Commit and push: on full endorsement the "
          "file is written, committed, and pushed; the branch number increments to loop-NN and the counter "
          "survives restarts through the persistence layer."),
    ("figure", "fig2-growth-curve.png",
     "Figure 2 — Cumulative commits by day, October 24 to 29, 2026. {commits} commits in six days, "
     "flat early while the stack was being assembled, then steady as the loop began mutating itself."),
    ("h2", "3.2 The rate-limit gate"),
    ("p", "The LLM endpoint is quota-limited, and the system treats 429 responses as a first-class state, not "
          "an error. When a 429 is observed, the gate activates for a cooldown window that escalates with "
          "consecutive hits: 2 minutes, then 5, then 15, then 30. Two properties were engineered into this "
          "design after the original behavior proved wasteful. First, the pause is whole-cycle: when the gate "
          "is active at cycle start, the cycle does not run at all — it does not even scan files — so a "
          "single 429 burns one cooldown window instead of eighteen retries inside one cycle. Second, the "
          "cooldown is anchored to an absolute end time (endsAtMs) which the countdown chip in the dashboard "
          "reads directly; the UI ticks down client-side and cannot drift, and STOP interrupts the pause "
          "within a second. During the live verification for this document, the gate escalated from level 1 "
          "to level 2 across cycles and the chip displayed the countdown correctly in both states — those "
          "captures are in Appendix G."),
    ("h2", "3.3 Saturation and the single-file lock"),
    ("p", "A file that yields three consecutive no-growth cycles is locked. 'No growth' is a classification, "
          "not a guess: outcomes are sorted into growth (an accepted enhancement), no-growth (rejections, "
          "skips, empty LLM returns, debate deferrals on substance), and neutral (quota deferrals, "
          "unavailability, stops). Only the no-growth class advances the counter; neutral outcomes — the "
          "gate holding the loop back during a cooldown — advance nothing, so a quota-starved system does "
          "not slowly lock all of its own files while waiting. When a file locks, the dashboard shows it in "
          "the saturation panel with its count frozen at the threshold, and an unlock button clears the "
          "lock through a dedicated API route. When every allowlisted file declares itself done, the panel "
          "reports PASS COMPLETE. The design argument behind replaceable locks instead of permanent ones "
          "is decision 6.1 in Chapter 6."),
    ("h2", "3.4 Persistence: file-first, self-healing"),
    ("p", "All durable state lives twice: in the SQLite database and in plain files on the filesystem, and "
          "the ordering of writes is the whole design. The push target (repository, token, branch, branch "
          "counter) lives in .loop-push-state.json at mode 0600 — the file holds a secret, so it is never "
          "committed, never world-readable, and written atomically through a temporary file and rename. The "
          "database is treated as a cache of the file, not the other way around: writes go to the file first "
          "and the database second, deletes go to the file first and the database second, and on startup the "
          "file re-seeds any missing database rows. This ordering is not an optimization; it is the fix for "
          "the incident that destroyed the configuration twice (5.1). The token is never placed in git "
          "configuration: authenticated pushes inject the credential per-process through GIT_CONFIG_PARAMETERS "
          "in the environment, so the token never appears in git remote output, error text, or command lines."),
    ("h2", "3.5 Engine freeze, display hot-swap"),
    ("p", "Files under src/lib/pipeline are the engine and are frozen within a running generation; they "
          "evolve only through committed mutations between generations. Files under src/app/display are "
          "presentation and hot-swap live through Turbopack HMR — the running browser swaps the component "
          "in roughly 100 milliseconds without losing the log buffer, because the buffer lives in a Zustand "
          "store outside the component. The git history proves the boundary: display mutations appear in the "
          "running terminal without any server restart, and one of them (a null-safety fix) is running in "
          "the live instance at this moment. The allowlist of 3.1 deliberately targets the display side: "
          "that is why LOOP can demonstrate its own evolution in front of you."),
    ("figure", "fig3-mutations-by-file.png",
     "Figure 3 — Accepted mutations by file (top 12 after normalizing annotated subjects). "
     "binaryShield.ts leads at 16 accepted mutations; the display component, the only allowlisted target, "
     "has 2."),
    ("h2", "3.6 Real-time telemetry"),
    ("p", "The dashboard is fed by two channels: a one-second TanStack Query poll of the status API, and a "
          "WebSocket mini-service on its own port (loop-ws-service) for push telemetry. The gateway "
          "convention of the sandbox exposes a single port externally, so browser connections are made "
          "through the gateway path with the service port in the XTransformPort query parameter; the "
          "convention is documented in the Caddyfile and the examples directory, and the service source is "
          "part of Appendix A. The console component caps its buffer at 500 lines, color-codes by level, "
          "auto-scrolls with a jump-to-latest control, and keeps history across hot-swaps via the store "
          "mentioned in 3.5."),
]

CH4 = [
    ("h1", "Chapter 4 — The Build Order That Actually Works"),
    ("p", "The system was not generated from a specification. It was grown in stages, and each stage was "
          "verified before the next one began. This is the part of the method that transfers to any rebuild "
          "attempt, and it is the direct answer to the reproducibility failure documented in Chapter 8: a "
          "40-file strict-TypeScript system with cross-dependencies between the schema, the routes, the "
          "engine modules, and the UI cannot be emitted in one output window by a current frontier model "
          "without fatal abbreviation. Staged growth with a verification gate after every stage crosses "
          "that ceiling, because each stage fits an output window and each gate catches the abbreviation "
          "the moment it appears."),
    ("h2", "4.1 The five stages, as actually run"),
    ("numbered", [
        "<b>Schema and data layer first.</b> prisma/schema.prisma defines the six models (PipelineRun, "
        "AutonomousCycle, MemoryEntry, Postmortem, GitPushTarget, SelfTask), then db:push materializes them. "
        "Verified by inspecting the SQLite tables directly. Nothing upstream depends on guesswork after this.",
        "<b>The LLM layer second.</b> The provider interface, the serialization queue, the output contract "
        "parser, and the mock provider that obeys the same contract. Verified by running the loop with the "
        "mock: every cycle must log a clean no-growth, proving the contract plumbing end to end before any "
        "real token is spent.",
        "<b>The loop engine third.</b> The runtime singleton, the six-stage pipeline of 3.1, and the gates. "
        "Verified by feeding it the mock provider and watching rejections happen for the right reasons.",
        "<b>The API routes fourth.</b> Thirty-seven routes under src/app/api, each declaring nodejs runtime "
        "and force-dynamic. Verified by exercising each route from the browser and reading dev.log.",
        "<b>The UI last.</b> The dashboard at the single visible route, the console stream, the config "
        "panels, the saturation panel. Verified visually in the browser — the screenshots in Appendix G are "
        "that verification, capture by capture.",
    ]),
    ("p", "The order matters in both directions. Schema-first means every later stage imports a type that "
          "exists. UI-last means the thing being verified at every earlier stage is observable behavior, not "
          "a rendered promise. And the mock provider in stage 2 is not a placeholder to be deleted later; it "
          "is the calibration instrument that lets the gates be tested without spending quota, and it stays "
          "in the shipped system as the default provider."),
    ("h2", "4.2 The verification loop within each stage"),
    ("p", "Each stage ran the same three-channel check. First, the browser: the only user-visible route is "
          "the dashboard, and every claim of working had to survive a page load there. Second, dev.log: the "
          "server log is the ground truth of what actually ran, and the discipline is to read the log, not "
          "the indicator — a server that shows green output while answering 500s on a status route is a "
          "documented incident (5.3), and it was caught by reading the log. Third, lint: zero errors as a "
          "gate before moving on. These three channels disagree at the exact moments that matter, and the "
          "failure catalog in Chapter 5 is largely a record of those disagreements."),
    ("h2", "4.3 Server lifecycle: the hard-won rules"),
    ("bullet", [
        "Start the dev server detached and owned by the session: a setsid wrapper with exec, output to "
        "dev.log, run in the background. One instance only; a second instance fails on the port and the "
        "error is visible in the log.",
        "Stop it with SIGKILL to the whole process tree — a plain kill leaves node next dev children alive "
        "and the next start dies on EADDRINUSE while the old, stale server keeps answering with corrupted "
        "state (5.3).",
        "When Turbopack's cache corrupts — symptoms include phantom compile errors that persist across "
        "restarts — delete the .next directory as part of the restart, not as a last resort.",
        "After any machine-level restore, expect the database to have been recreated by the boot sequence "
        "and verify the self-heal path: the state file must re-seed the missing rows (5.1).",
    ]),
    ("p", "None of these rules are in any framework manual. They are the accumulated corrections of a "
          "week of restarts, and the worklog entries in Appendix E show them being learned one at a time, "
          "in order, each after something broke."),
]

NARRATIVE_1 = CH1 + CH2 + CH3 + CH4
