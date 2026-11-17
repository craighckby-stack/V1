# File List — Restricted vs Mutable

Generated from the live tree. Reflects `PROTECTED_FILES` + `PROTECTED_PREFIXES` in 
`src/lib/pipeline/autonomous/protected-files.ts` and `SCAN_SCOPES` in 
`src/lib/pipeline/autonomous/saturation.ts`.

As of: 2026-11-17 (after operator tightening — SATURATION_THRESHOLD 3→2, self-model skip 0.5→0.4).


## Summary

| Category | Count |
|---|---|
| Files in scan scope (what the loop can see) | 202 |
| **Mutable** (the loop can enhance these) | **82** |
| Protected — exact-listed (specific files) | 35 |
| Protected — by directory prefix (whole subtrees) | 85 |
| Protected exact-listed but outside scan scope | 1 |
| **Total restricted (in + out of scope)** | **121** |

**Scan scopes** (where the loop looks for files to mutate):
- `src/lib/pipeline/**/*.ts`
- `src/app/**/*.{ts,tsx}`
- `src/components/pipeline/**/*.tsx`
- `prisma/schema.prisma` (special: additive-only schema gate, not the standard tsc/AST/debate chain)

**Focus mode** (`TARGET_FILES` in `saturation.ts`): currently empty → full-scope mode. 
If you add paths to `TARGET_FILES`, the loop only mutates those files (surgical focus). 
The list below is the full-scope picture.

---

# Restricted (Protected) Files

The loop must NEVER modify these. The protected-files boundary is the off-switch — 
a self-improving system that could rewrite its own gates, push path, or control surface 
is one "reasonable cleanup" away from having no oversight.

## A. Exact-listed protected files (in scan scope)

These are named individually in `PROTECTED_FILES`. They live inside the scan scopes 
but are explicitly fenced off.

### src/app/ (root app files) (2)

- `src/app/layout.tsx` — page shell / metadata
- `src/app/page.tsx` — the control surface (STOP/START/CLEAR/CONFIG buttons, command input)

### src/components/pipeline/ (LOOP display panels) (3)

- `src/components/pipeline/api-unlock.tsx` — auth-prompt UI (the 401 → API key gate)
- `src/components/pipeline/boot-splash.tsx` — click-intercept entry ceremony
- `src/components/pipeline/pipeline-stages.tsx` — dead display code (never imported)

### src/lib/pipeline/autonomous/ (loop runtime, gates, self-model) (26)

- `src/lib/pipeline/autonomous/arch-context.ts`
- `src/lib/pipeline/autonomous/archaeology.ts`
- `src/lib/pipeline/autonomous/chat-task.ts`
- `src/lib/pipeline/autonomous/code-analysis.ts`
- `src/lib/pipeline/autonomous/goal-engine.ts`
- `src/lib/pipeline/autonomous/in-memory-typecheck.ts` — the typecheck gate
- `src/lib/pipeline/autonomous/lapse-detector.ts`
- `src/lib/pipeline/autonomous/lesson-store.ts`
- `src/lib/pipeline/autonomous/lessons-markdown.ts`
- `src/lib/pipeline/autonomous/loop-runtime.ts`
- `src/lib/pipeline/autonomous/merge-back.ts`
- `src/lib/pipeline/autonomous/meta-params.ts` — the tunable knob table
- `src/lib/pipeline/autonomous/meta-tuner.ts` — the loop can never rewrite its own tuner
- `src/lib/pipeline/autonomous/mutation-corpus.ts`
- `src/lib/pipeline/autonomous/protected-files.ts` — the protection list (protects itself)
- `src/lib/pipeline/autonomous/push-target.ts` — push auth path
- `src/lib/pipeline/autonomous/retention.ts`
- `src/lib/pipeline/autonomous/route-cooldown.ts`
- `src/lib/pipeline/autonomous/saturation.ts` — the lockout mechanism + scan scope definition
- `src/lib/pipeline/autonomous/schema-gate.ts`
- `src/lib/pipeline/autonomous/self-enhance-loop.ts` — the loop orchestrator itself
- `src/lib/pipeline/autonomous/self-model.ts` — bandit target-selection policy
- `src/lib/pipeline/autonomous/self-task-generator.ts`
- `src/lib/pipeline/autonomous/structural-validator.ts`
- `src/lib/pipeline/autonomous/task-executor.ts`
- `src/lib/pipeline/autonomous/verify-refactor.ts` — the verifier

### src/lib/pipeline/core/ (gate chain) (1)

- `src/lib/pipeline/core/hot-swap.ts` — a gate

### src/lib/pipeline/llm/ (LLM wrappers) (3)

- `src/lib/pipeline/llm/agent-llm.ts`
- `src/lib/pipeline/llm/debate-llm.ts`
- `src/lib/pipeline/llm/gemini-direct.ts`

## B. Prefix-protected files (whole subtrees)

These files are protected because they live under a directory in `PROTECTED_PREFIXES`. 
Listing each individually would be brittle — prefix protection closes that gap. 
Adding a new route under one of these subtrees is automatically protected.

### src/app/api/autonomous/ (API route) (6)

- `src/app/api/autonomous/config/route.ts`
- `src/app/api/autonomous/recent-cycles/route.ts`
- `src/app/api/autonomous/start/route.ts`
- `src/app/api/autonomous/status/route.ts`
- `src/app/api/autonomous/stop/route.ts`
- `src/app/api/autonomous/trigger/route.ts`

### src/app/api/branches/ (API route) (1)

- `src/app/api/branches/route.ts`

### src/app/api/duress/ (API route) (3)

- `src/app/api/duress/clear/route.ts` — safe-mode / purge control
- `src/app/api/duress/purge/route.ts` — safe-mode / purge control
- `src/app/api/duress/status/route.ts` — safe-mode / purge control

### src/app/api/github/ (API route) (5)

- `src/app/api/github/batch-commit/route.ts`
- `src/app/api/github/commit-file/route.ts`
- `src/app/api/github/fetch-file/route.ts`
- `src/app/api/github/repo-tree/route.ts`
- `src/app/api/github/validate-token/route.ts`

### src/app/api/health/ (API route) (1)

- `src/app/api/health/route.ts`

### src/app/api/healthz/ (API route) (1)

- `src/app/api/healthz/route.ts`

### src/app/api/hot-swap/ (API route) (2)

- `src/app/api/hot-swap/status/route.ts` — a gate
- `src/app/api/hot-swap/trigger/route.ts` — a gate

### src/app/api/oracle/ (API route) (7)

- `src/app/api/oracle/archaeology/route.ts`
- `src/app/api/oracle/evaluate/route.ts`
- `src/app/api/oracle/events/ingest/route.ts`
- `src/app/api/oracle/events/route.ts`
- `src/app/api/oracle/generate/route.ts`
- `src/app/api/oracle/prophecies/route.ts`
- `src/app/api/oracle/status/route.ts`

### src/app/api/pipeline/ (API route) (2)

- `src/app/api/pipeline/history/route.ts`
- `src/app/api/pipeline/run/route.ts`

### src/app/api/postmortems/ (API route) (3)

- `src/app/api/postmortems/chain/route.ts`
- `src/app/api/postmortems/route.ts`
- `src/app/api/postmortems/seed/route.ts`

### src/app/api/red-team/ (API route) (2)

- `src/app/api/red-team/run/route.ts`
- `src/app/api/red-team/status/route.ts`

### src/app/api/secret-scan/ (API route) (1)

- `src/app/api/secret-scan/scan/route.ts` — a gate

### src/app/api/self-enhance/ (API route) (21)

- `src/app/api/self-enhance/archaeology/route.ts`
- `src/app/api/self-enhance/chat-task/apply/route.ts`
- `src/app/api/self-enhance/chat-task/propose/route.ts`
- `src/app/api/self-enhance/files/route.ts`
- `src/app/api/self-enhance/goals/route.ts`
- `src/app/api/self-enhance/llm-config/route.ts`
- `src/app/api/self-enhance/merge-back/route.ts`
- `src/app/api/self-enhance/pass-rate-trend/route.ts`
- `src/app/api/self-enhance/prune-branches/route.ts`
- `src/app/api/self-enhance/push-target/route.ts` — push auth path
- `src/app/api/self-enhance/push/route.ts`
- `src/app/api/self-enhance/reboot/route.ts`
- `src/app/api/self-enhance/rescan/route.ts`
- `src/app/api/self-enhance/skip/route.ts`
- `src/app/api/self-enhance/start/route.ts`
- `src/app/api/self-enhance/status/route.ts`
- `src/app/api/self-enhance/stop/route.ts`
- `src/app/api/self-enhance/tasks/route.ts`
- `src/app/api/self-enhance/trigger/route.ts`
- `src/app/api/self-enhance/unlock/route.ts`
- `src/app/api/self-enhance/visibility/route.ts`

### src/lib/pipeline/core/ (gate chain) (18)

- `src/lib/pipeline/core/ast-diff-gate.ts` — a gate
- `src/lib/pipeline/core/async-spawn.ts`
- `src/lib/pipeline/core/atomic-file.ts`
- `src/lib/pipeline/core/binaryShield.ts`
- `src/lib/pipeline/core/duress.ts` — safe-mode / purge control
- `src/lib/pipeline/core/exclusion-patterns.ts`
- `src/lib/pipeline/core/gate-runner.ts` — a gate
- `src/lib/pipeline/core/hash.ts`
- `src/lib/pipeline/core/mutation-guard.test.ts` — a gate
- `src/lib/pipeline/core/mutation-guard.ts` — a gate
- `src/lib/pipeline/core/paths.ts`
- `src/lib/pipeline/core/prompt-scrub.ts`
- `src/lib/pipeline/core/sandbox-test.ts`
- `src/lib/pipeline/core/secret-scan.ts` — a gate
- `src/lib/pipeline/core/siphon.ts`
- `src/lib/pipeline/core/test-gate-journal.ts`
- `src/lib/pipeline/core/tree-lock.ts`
- `src/lib/pipeline/core/unified-pipeline.ts`

### src/lib/pipeline/emg/ (sanitizer/halt/RAG) (4)

- `src/lib/pipeline/emg/debate.ts`
- `src/lib/pipeline/emg/emg-rag.ts`
- `src/lib/pipeline/emg/halt.ts`
- `src/lib/pipeline/emg/sanitizer.ts`

### src/lib/pipeline/engines/ (proposal engines) (1)

- `src/lib/pipeline/engines/clean-room-runtime.ts`

### src/lib/pipeline/postmortem/ (scar memory) (3)

- `src/lib/pipeline/postmortem/ancestral-rag.ts`
- `src/lib/pipeline/postmortem/postmortem-repo.ts`
- `src/lib/pipeline/postmortem/postmortem-store.ts`

### src/lib/pipeline/red-team/ (integrity probes) (4)

- `src/lib/pipeline/red-team/gate-integrity-probe.ts`
- `src/lib/pipeline/red-team/red-team-runner.ts`
- `src/lib/pipeline/red-team/red-team-suite.ts`
- `src/lib/pipeline/red-team/test-attacker.ts`

## C. Exact-listed protected files (outside scan scope)

These are in `PROTECTED_FILES` but not under any scan scope — the loop never even sees them. 
Listed for completeness; the protection is belt-and-suspenders.

### src/lib/ (other libs) (1)

- `src/lib/db.ts` — the database client

---

# Mutable Files

The loop is allowed to enhance these. Each proposed change still passes the full gate chain 
(mutation-guard → structural validator → AST symbol-retention → full-project typecheck → 
sandboxed tests → 3-way LLM debate → secret-scan) before it lands. ~50% of proposals are reverted 
by a gate; only the survivors commit.

### prisma/ (database schema — additive-only gate) (1)

- `prisma/schema.prisma` — special: additive-only schema gate (not the standard tsc/AST/debate chain)

### src/app/api/boot/ (API route) (2)

- `src/app/api/boot/scan/route.test.ts`
- `src/app/api/boot/scan/route.ts`

### src/app/api/emg/ (API route) (2)

- `src/app/api/emg/sanitize/route.test.ts`
- `src/app/api/emg/sanitize/route.ts`

### src/app/api/engines/ (API route) (2)

- `src/app/api/engines/catalog/route.test.ts`
- `src/app/api/engines/catalog/route.ts`

### src/app/api/evolution/ (API route) (2)

- `src/app/api/evolution/coherence-gate/route.ts`
- `src/app/api/evolution/debate/route.ts`

### src/app/api/memory/ (API route) (4)

- `src/app/api/memory/entries/route.test.ts`
- `src/app/api/memory/entries/route.ts` — RAG memory (intentionally unprotected — pure data/utility)
- `src/app/api/memory/query/route.test.ts`
- `src/app/api/memory/query/route.ts` — RAG memory (intentionally unprotected — pure data/utility)

### src/app/api/route.test.ts/ (API route) (1)

- `src/app/api/route.test.ts`

### src/app/api/route.ts/ (API route) (1)

- `src/app/api/route.ts`

### src/app/api/self-model/ (API route) (2)

- `src/app/api/self-model/route.test.ts` — bandit target-selection policy
- `src/app/api/self-model/route.ts` — bandit target-selection policy

### src/app/display/ (terminal display layer) (2)

- `src/app/display/console-stream.test.tsx`
- `src/app/display/console-stream.tsx`

### src/components/pipeline/ (LOOP display panels) (31)

- `src/components/pipeline/api-unlock.test.tsx` — auth-prompt UI (the 401 → API key gate)
- `src/components/pipeline/ast-inspector-modal.test.tsx`
- `src/components/pipeline/ast-inspector-modal.tsx`
- `src/components/pipeline/branches-panel.tsx`
- `src/components/pipeline/current-cycle.test.tsx`
- `src/components/pipeline/current-cycle.tsx`
- `src/components/pipeline/debate-chamber.test.tsx`
- `src/components/pipeline/debate-chamber.tsx`
- `src/components/pipeline/defense-panel.tsx`
- `src/components/pipeline/gemini-panel.tsx`
- `src/components/pipeline/header-bar.test.tsx`
- `src/components/pipeline/header-bar.tsx`
- `src/components/pipeline/log-stream.test.tsx`
- `src/components/pipeline/log-stream.tsx`
- `src/components/pipeline/loop-control-panel.tsx`
- `src/components/pipeline/manual-runner.tsx`
- `src/components/pipeline/memory-bank.test.test.tsx`
- `src/components/pipeline/memory-bank.test.tsx`
- `src/components/pipeline/memory-bank.tsx`
- `src/components/pipeline/merge-back-panel.tsx`
- `src/components/pipeline/nvidia-panel.tsx`
- `src/components/pipeline/oracle-panel.tsx`
- `src/components/pipeline/oracle-task-feed-panel.test.tsx`
- `src/components/pipeline/oracle-task-feed-panel.tsx`
- `src/components/pipeline/pipeline-stages.test.tsx` — dead display code (never imported)
- `src/components/pipeline/postmortem-panel.test.tsx`
- `src/components/pipeline/postmortem-panel.tsx`
- `src/components/pipeline/recent-cycles.tsx`
- `src/components/pipeline/scramble.test.tsx`
- `src/components/pipeline/scramble.tsx`
- `src/components/pipeline/self-model-panel.tsx` — bandit target-selection policy

### src/lib/pipeline/ (other) (2)

- `src/lib/pipeline/api/github-helpers.test.ts`
- `src/lib/pipeline/api/github-helpers.ts`

### src/lib/pipeline/autonomous/ (loop runtime, gates, self-model) (16)

- `src/lib/pipeline/autonomous/armed-state.test.ts`
- `src/lib/pipeline/autonomous/armed-state.ts`
- `src/lib/pipeline/autonomous/crash-budget.test.ts`
- `src/lib/pipeline/autonomous/crash-budget.ts`
- `src/lib/pipeline/autonomous/dreamer.test.ts`
- `src/lib/pipeline/autonomous/dreamer.ts`
- `src/lib/pipeline/autonomous/loop-event-bus.test.ts`
- `src/lib/pipeline/autonomous/loop-event-bus.ts`
- `src/lib/pipeline/autonomous/loop-stats.ts`
- `src/lib/pipeline/autonomous/loop-worker-client.test.ts`
- `src/lib/pipeline/autonomous/loop-worker-client.ts`
- `src/lib/pipeline/autonomous/operator-touch.test.ts`
- `src/lib/pipeline/autonomous/operator-touch.ts`
- `src/lib/pipeline/autonomous/reflection.ts`
- `src/lib/pipeline/autonomous/saturation.test.ts` — the lockout mechanism + scan scope definition
- `src/lib/pipeline/autonomous/self-enhance-armed-state.ts`

### src/lib/pipeline/crypto/ (token vault) (2)

- `src/lib/pipeline/crypto/token-vault.test.ts`
- `src/lib/pipeline/crypto/token-vault.ts`

### src/lib/pipeline/llm/ (LLM wrappers) (1)

- `src/lib/pipeline/llm/nvidia-direct.ts`

### src/lib/pipeline/oracle/ (prophecy engine) (11)

- `src/lib/pipeline/oracle/commit-archaeology.ts`
- `src/lib/pipeline/oracle/oracle-auto.test.ts`
- `src/lib/pipeline/oracle/oracle-auto.ts`
- `src/lib/pipeline/oracle/oracle-events.ts`
- `src/lib/pipeline/oracle/oracle-scheduler.ts`
- `src/lib/pipeline/oracle/oracle-task-feed.test.ts`
- `src/lib/pipeline/oracle/oracle-task-feed.ts`
- `src/lib/pipeline/oracle/prophecy-evaluator.ts`
- `src/lib/pipeline/oracle/prophecy-generator.ts`
- `src/lib/pipeline/oracle/prophecy-store.test.ts`
- `src/lib/pipeline/oracle/prophecy-store.ts`

---

# Notes

- **The protection list is the off-switch.** `protected-files.ts` protects itself — the loop can 
  never add or remove its own protection. Only an operator can edit it.

- **Sweep-in hazard:** the loop commits with `git add -A`, so any uncommitted operator edit in 
  the working tree can be swept into a loop-authored commit (seen with commit `dca1bd89`). 
  Commit operator edits separately before the loop's next cycle.

- **`prisma/schema.prisma` is mutable but special.** It goes through the additive-only schema gate, 
  not the standard tsc/AST/debate chain. The loop can add models/fields but not remove them.

- **`src/components/ui/` is excluded entirely** (vendored shadcn primitives — third-party code the loop 
  has no business polishing). It is not in any scan scope.

- **`TARGET_FILES` (focus mode) is empty.** When non-empty, the loop only mutates files in that list. 
  Edit `saturation.ts` to use focus mode.

- **Why so much is restricted.** The 120 in-scope protected files vs 82 mutable reflects the audit 
  history (audits 3, 5, 6, 7): every gate, every control-surface route, every PAT-using endpoint, 
  the entire defense surface got protected. The mutable surface is the logic + display + 
  non-control routes — where the loop's defensive hardening has value.
