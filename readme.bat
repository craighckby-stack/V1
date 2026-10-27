@echo off
rem ==========================================================================
rem  readme.bat  —  the one file the system cannot eat
rem ==========================================================================
rem
rem  This file is .bat because the system's self-task-generator scans only
rem  .ts files under src/lib/pipeline. A .bat at the repo root is invisible
rem  to the autonomous loop. This is the user's fixed statement about a
rem  system that otherwise writes itself.
rem
rem ==========================================================================
rem  WHAT THE SYSTEM IS
rem ==========================================================================
rem
rem  A constrained self-mutation pipeline. Three layers:
rem
rem    1. Mutation engine   An LLM proposes code changes to its own source.
rem                         The weakest layer. Intelligence is outsourced.
rem
rem    2. Verification gate  tsc typecheck + truncation detection + banner
rem                         stripping + postmortem constraint injection +
rem                         a protected-files list. This is the real
rem                         engineering. Every rule in the gate came from a
rem                         real failure (see worklog.md).
rem
rem    3. Proof layer       git push to GitHub. The commit history IS the
rem                         audit log. If it isn't on GitHub, it didn't
rem                         happen.
rem
rem  The framework (constrained mutation + audit) is the asset.
rem  Self-enhancement is just the first customer.
rem
rem ==========================================================================
rem  WHAT THE SYSTEM DOES
rem ==========================================================================
rem
rem  - Scans its own TypeScript source (src/lib/pipeline) via static AST
rem    analysis. NO LLM, NO user input. Finds: todo comments, empty catches,
rem    any-usage, missing return types, magic numbers, non-null assertions.
rem  - Queues findings as prioritized SelfTasks in SQLite (deduped by
rem    kind+file+line).
rem  - Claims a task, applies a fix, verifies in-memory with the TypeScript
rem    checker, writes the live file, pushes to GitHub.
rem  - Two execution paths:
rem      deterministic  - checker-inferred return types, ZERO LLM calls.
rem      llm            - focused single-issue prompt, whole-file output,
rem                        brace-balance truncation guard, in-memory verify.
rem    429 rate limit defers LLM tasks; deterministic tasks keep the loop
rem    working through limits.
rem
rem ==========================================================================
rem  THE POINT OF THE SYSTEM
rem ==========================================================================
rem
rem  The system defines its own input. It does NOT take goals from users.
rem
rem  This is the core principle. Chat mode (Direction 1 in DIRECTIONS.md) was
rem  built and then removed because it violated this - it made the user the
rem  input source. The rebuild (see worklog.md, Task ID: system-defined-input)
rem  replaced user goals with a static self-scan: the system finds its own
rem  work, in its own source, with zero LLM and zero user input.
rem
rem  The interesting question is not "can it enhance itself" (it can, badly)
rem  but "what is a real feedback signal" - typecheck proves compilable, not
rem  better. See DIRECTIONS.md for the open directions.
rem
rem ==========================================================================
rem  FUTURE CHAT MODE — THE PROOF IT MUST PASS
rem ==========================================================================
rem
rem  Chat mode (Direction 1) was built and removed. It made the user the
rem  input source, violating the core principle. This section is the
rem  constraint any future chat mode must satisfy before it ships. It is a
rem  fixed guardrail, not a speculation — speculation lives in DIRECTIONS.md.
rem
rem  THE TEST
rem  Any chat feature must prove, before it ships, that it does NOT make
rem  the user the source of new work. The system's input remains its own
rem  static self-scan. The user may shape, veto, or review — never inject.
rem
rem  COMPLIANT DESIGNS (would pass the test)
rem
rem  - Veto / reorder: user can skip or prioritize tasks the system already
rem    queued, but cannot add new ones. (The current 'skip' command is this.)
rem  - Execution refinement: user can shape HOW the system executes a task
rem    it already defined (prompt tone, fix strategy), but not WHAT task.
rem  - Post-hoc review: user tags commits good/bad/regression; those tags
rem    become postmortem constraints fed back into the gate. The user is a
rem    feedback signal, not an input source. (This is the design
rem    DIRECTIONS.md says the system is missing — a real signal that's not
rem    the LLM's own output.)
rem
rem  FORBIDDEN (would fail the test)
rem
rem  - User goal injection. Any design where the user types a goal and the
rem    system works on it. This is what was removed. It is the trap.
rem
rem  THE PROOF REQUIRED
rem  Before any chat mode ships, it must demonstrate:
rem    1. With the chat interface present, the system still produces the
rem       same self-defined task queue as with it absent.
rem    2. No user input string becomes a task target.
rem    3. Removing the chat interface changes no behavior of the loop.
rem  If all three hold, the chat feature is interface, not input — and it
rem  passes.
rem
rem ==========================================================================
rem  INVARIANTS  (the system is structurally prevented from changing these)
rem ==========================================================================
rem
rem  - Protected files (the gate refuses to modify these, so the system
rem    cannot rewrite its own gate or its own input layer):
rem      src/lib/pipeline/autonomous/loop-runtime.ts
rem      src/lib/pipeline/autonomous/self-enhance-loop.ts
rem      src/lib/pipeline/autonomous/self-task-generator.ts
rem      src/lib/pipeline/autonomous/loop-event-bus.ts
rem      src/lib/pipeline/llm/agent-llm.ts
rem      src/lib/pipeline/llm/debate-llm.ts
rem
rem  - The gate: tsc typecheck scoped to project code (excludes examples/
rem    and skills/ reference folders), truncation guard, banner strip,
rem    postmortem constraint injection from past failures.
rem
rem  - Token-safe push: GitHub PAT lives in the local SQLite DB (untracked),
rem    injected per-push via GIT_CONFIG_* env vars. Never in git config,
rem    never in the remote URL, never on the command line.
rem
rem ==========================================================================
rem  WHERE THE TRUTH LIVES
rem ==========================================================================
rem
rem  This file is the fixed point. It drifts only when the user edits it.
rem  Current behavior lives in git log - read the commits.
rem
rem    Live system (push = proof):
rem      https://github.com/craighckby-stack/V1
rem
rem    Forward-looking directions (where it could go, will drift):
rem      DIRECTIONS.md
rem
rem    Audit log of work done (every task, every incident, every postmortem):
rem      worklog.md
rem
rem ==========================================================================
rem  KNOWN INCIDENTS
rem ==========================================================================
rem
rem  - Token leak (commit c0752e7, since purged): db/custom.db containing a
rem    GitHub PAT was briefly committed and pushed when a stash reverted
rem    .gitignore. Purged from history via filter-branch + gc --prune=now,
rem    force-pushed clean. RECOMMEND USER REGENERATE the PAT - it was
rem    briefly public.
rem
rem  - "rea" era (~7,000 garbage commits on a helper-evolution branch, since
rem    removed): an earlier 6-stage pipeline ran with an ineffective gate
rem    and produced noise. The current gate was rebuilt from those failures.
rem
rem ==========================================================================
rem  HOW TO RUN
rem ==========================================================================
rem
rem    bun run dev        Next.js dev server, port 3000 (the terminal UI)
rem    bun run lint       ESLint
rem    bun run db:push    sync Prisma schema to SQLite
rem
rem  The autonomous loop runs server-side. The terminal UI at
rem  src/app/page.tsx is the only user-visible route.
rem
rem ==========================================================================
rem  WHY .bat AND NOT .md
rem ==========================================================================
rem
rem  A .md README would be readable by the system's own text-based tooling
rem  and could become a target for "enhancement." Making this a .bat (an
rem  extension the self-task-generator's .ts-only scanner cannot ingest)
rem  keeps it permanently user-owned. The format is the guardrail.
rem
rem ==========================================================================
