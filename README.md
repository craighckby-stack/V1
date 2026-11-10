# LOOP

> A Next.js app that scans its own source code, asks an LLM to improve one file at a time, runs every proposed change through a compiler + AST + debate gate chain, and pushes the survivors to GitHub as one `loop-NN` branch per winning mutation. Failures become postmortems that constrain the next attempt. The loop can't rewrite its own OFF switch.

![Boot splash — BIOS POST with live vitals](./docs/screenshots/01-splash-post.png)

---

## What this is

LOOP is a bounded, autonomous **self-mutation pipeline**. It is not an AGI and not a chatbot — it is a compiler-gated scaffold around an LLM that proposes diffs to its own source. The cleverness is in the gating, not the generation.

The core cycle, running in the background on the server:

1. **Scan** — `src/lib/pipeline/autonomous/self-task-generator.ts` statically analyzes its own source (`src/`, `prisma/schema.prisma`) and produces a prioritized `SelfTask` queue (todo-comments, empty catches, `any` usage, missing return types, unused imports, magic numbers, non-null assertions).
2. **Pick** — claim the next task. Skip protected files (`protected-files.ts`).
3. **Contextualize** — read the per-file postmortem constraints (`postmortem-store.ts`), ancestral RAG over all verified postmortems (`ancestral-rag.ts`), top-K lessons by trust score (`lesson-store.ts`), and the rejected-transform block for this file (`mutation-corpus.ts`).
4. **Generate** — `agent-llm.ts` calls the LLM (z-ai-web-dev-sdk → Gemini-direct → geo-bypass proxy) with the file, the constraints, and the task.
5. **Gate** — `mutation-guard.ts` (no new `eval`/`child_process`/`fetch(`/etc) → `structural-validator.ts` (no truncation) → `ast-diff-gate.ts` (TypeScript compiler API: no symbol dropped, no branding injected) → `in-memory-typecheck.ts` (full project `tsc --noEmit`) → `sandbox-test.ts` (disposable sandbox, candidate never touches the live tree) → `debate-llm.ts` (3 LLM reviewers, no fallback) → `secret-scan.ts` (pre-push).
6. **Verdict** — pass: strip banner comments, write the live file, commit + push to a fresh `loop-NN` branch (`push-target.ts`). Resolve any open postmortems for that file. Fail: revert, write a postmortem (`postmortem-store.ts`), maybe a Reflexion entry (`reflection.ts`), feed the lesson outcome (`lesson-store.ts`), try again next cycle.
7. Goto 1. Forever — bounded by the crash wall (3 same-class crashes), the dead-man's switch (24h no operator touch), the LLM 429 gate (escalating 2/5/15/30min cooldowns), and the operator's `[STOP]`.

The branch model is git-native: each successful mutation gets its own `loop-NN` branch, so `git diff loop-37..loop-38` shows exactly one enhancement. The branch list IS the changelog — kept to the newest 50 by the retention policy (see **Retention policy** below); the commits on the seed lineage are the permanent record.

---

## The interface

A single full-screen BIOS terminal at `/` (`src/app/page.tsx`):

![Terminal](./docs/screenshots/05-terminal.png)

Black background, amber phosphor text. Header: `LOOP ●` (heartbeat), `[START]`, `[CLEAR]`, `[CONFIG]`, `[ORACLE]`, `[DEFENSE]`, `[BRANCHES]`. Type commands: `start` / `stop` / `status` / `about` / `help` / `trigger` / `task <goal>` / `push` / `config` / `oracle` / `skip` / `rescan` / `clear`. A live console stream (`console-stream.tsx`) shows every scan, gate, push, retry, and backoff in real time.

The boot ceremony (`boot-splash.tsx`) is a 1980s CRT POST: it fetches its own live vitals from its own APIs (branches, postmortem chain, oracle, LLM, hot-swap, GitHub auth, sealed-token vault, mutation totals, pass-rate trend, autonomy phase, Z.ai cortex, quota gate), stamps 16 honest lines — any vital it can't read stamps `[ ?? ]` in amber, never a fake `OK` — then addresses you with `[ ▶ ENTER THE LOOP ]`.

| | |
|---|---|
| **POST** — live vitals stamp in | ![POST](./docs/screenshots/01-splash-post.png) |
| **Invite** — the machine asks you to enter | ![Invite](./docs/screenshots/02-splash-invite.png) |
| **Branches** — every `loop-NN` is one successful mutation | ![Branches](./docs/screenshots/06-branches.png) |
| **Oracle** — predicts + grades its own operational future | ![Oracle](./docs/screenshots/07-oracle.png) |
| **Config** — sealed-PAT push target | ![Config](./docs/screenshots/08-config.png) |
| **Defense** — duress / red-team / secret-scan grafts | ![Defense](./docs/screenshots/09-defense.png) |

---

## Architecture

```
                ┌─────────────────────────────────────────────────┐
                │  PAGE.TSX  (protected control surface)           │
                │   fetch /api/self-enhance/* · Socket.IO :3003    │
                │   console-stream.tsx (mutable display)           │
                └──────────────────────┬──────────────────────────┘
                                       │ HTTP (gated by middleware.ts)
                                       ▼
                ┌─────────────────────────────────────────────────┐
                │  56 API ROUTES  src/app/api/**                   │
                │  self-enhance · autonomous · oracle · postmortems│
                │  red-team · github · hot-swap · duress · emg ·   │
                │  memory · secret-scan · evolution · pipeline ·   │
                │  branches · engines · boot · health · healthz     │
                └──────────────────────┬──────────────────────────┘
                                       │
                                       ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │  THE BRAIN (protected — loop can never mutate these)            │
   │  autonomous/self-enhance-loop.ts  ← THE BRAIN                    │
   │  autonomous/loop-runtime.ts       ← remote-repo variant         │
   │  autonomous/self-task-generator   ← THE INPUT LAYER             │
   │  autonomous/push-target.ts        ← 3-tier sealed-PAT push      │
   │  autonomous/protected-files.ts     ← SINGLE SOURCE: what's off  │
   │  autonomous/schema-gate.ts        ← additive-only Prisma gate   │
   │  autonomous/lesson-store.ts       ← compounding intelligence    │
   │  autonomous/verify-refactor.ts    ← child-process gate chain    │
   │  autonomous/in-memory-typecheck   ← full-project tsc --noEmit   │
   │  core/ (13 files: AST, mutation-guard, sanitizer-bridge,       │
   │         secret-scan, duress, hot-swap, sandbox-test, tree-lock) │
   │  emg/ (sanitizer, debate types, halt, emg-rag)                 │
   │  postmortem/ (store + repo + ancestral-rag)                    │
   │  red-team/ (7-probe suite + 15 gate-integrity probes)          │
   │  llm/ (agent-llm, debate-llm, gemini-direct)                   │
   │  crypto/token-vault.ts  ← AES-256-GCM PAT sealing               │
   │  engines/clean-room-runtime.ts  ← ReAct loop                    │
   └─────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │  PERSISTENCE                                                     │
   │  SQLite (Prisma) — 12 models                                     │
   │  postmortems/<repo>/<branch>/*.json — tamper-evident chain       │
   │  .git/info/loop-{armed,crash-budget,operator-touch,push-state,   │
   │               vault-key} — wipe-proof tiers (survive DB rollback)│
   └─────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │  SIDE PROCESSES                                                   │
   │  mini-services/loop-ws-service/:3003  Socket.IO state relay     │
   │  proxy/  Gemini geo-bypass on Fly.io (sgp)                        │
   │  Caddyfile :81  reverse proxy (?XTransformPort pattern)          │
   └─────────────────────────────────────────────────────────────────┘
```

### The boundary — what it can and can't touch

The loop's own brain is off-limits to itself. The single source of truth is `src/lib/pipeline/autonomous/protected-files.ts`: 33 exact paths (`PROTECTED_FILES`) + 16 prefix subtrees (`PROTECTED_PREFIXES` — all of `core/`, `emg/`, `postmortem/`, `red-team/`, `engines/`, `crypto/`, `llm/`, and every API route subtree). `isProtectedPath` is the one predicate the scanner uses.

| Layer | Mutable? |
|---|---|
| **Brain** — loop runtime, gate chain, push auth, typecheck, AST, sanitizer, debate, LLM callers, schema gate, protected-files list itself | 🔒 Never. |
| **Control surface** — `page.tsx`, `layout.tsx`, `middleware.ts`, `src/lib/db.ts`, `src/instrumentation.ts` | 🔒 Never. |
| **Control API** — `src/app/api/self-enhance/**` (the backend of the kill switch) | 🔒 Never. |
| **Body** — `src/app/display/`, `src/components/pipeline/`, the non-protected `src/lib/pipeline/` helpers | ✏️ Yes. |
| **Schema** — `prisma/schema.prisma` | ✏️ Additive-only (`schema-gate.ts`). |
| **Everything else** — shadcn/ui, the rest of `src/` | 🔒 Outside scan scope. |

A self-improving system must not be able to rewrite its own OFF switch, its own judges, or its own memory.

---

## Tech stack

- **Next.js 16** (App Router, Turbopack) + **React 19** + **TypeScript 5**
- **Tailwind CSS 4** + **shadcn/ui** (New York) — 48 primitives in `src/components/ui/`
- **Prisma 6** + **SQLite** — 12 models (see below)
- **z-ai-web-dev-sdk** — primary LLM (Z.ai cortex, auto-injected at server boot via `src/instrumentation.ts`)
- **Google Gemini** (direct REST, optional, user-pasted key) with geo-bypass proxy on Fly.io
- **Socket.io** — real-time state relay, mini-service on port 3003
- **TypeScript Compiler API** — the AST diff gate + in-memory typecheck
- **Bun** — runtime + test runner (`bun test` in the sandbox gate)
- **Framer Motion**, **Zustand**, **TanStack Query/Table**, **recharts**, **react-markdown**, **react-hook-form**, **lucide-react**, **sonner**, **next-themes**, **cmdk**, **vaul**, **~30 @radix-ui primitives**
- **Web Audio API** — synthesized boot soundtrack (no audio assets)

---

## Prisma schema (12 models)

`prisma/schema.prisma` is the system's memory. An additive-only gate (`schema-gate.ts`) is the only path that may touch it: new model blocks or new defaulted/nullable fields on non-protected models only. **Protected models** (never editable): `Postmortem`, `Lesson`, `GitPushTarget`, `LlmConfig`, `Prophecy`, `SystemFlag`, `MutationCorpus`, `MetaParam`.

| Model | What it stores |
|---|---|
| `PipelineRun` | One execution of the 6-stage remote-repo pipeline (status, AST score, consensus, proofHash, original/evolved code) |
| `AutonomousCycle` | One cycle of the remote-repo loop (files scanned/committed, status, proof hash) |
| `MemoryEntry` | Long-term RAG memory (provenance, trust, content) |
| `Postmortem` | Per-file negative constraint; tamper-evident chain (`parentHash` + `hash`); failure types: `AST_SYMBOL_DROPPED`, `AST_STRUCTURAL_DRIFT`, `REVIEW_REJECTED`, `SANITIZER_REDACTION`, `HEADER_STRIPPED`, `COMPILE_ERROR`, `WEAK_RATCHET`, `ZERO_DIFF_SATURATION` |
| `GitPushTarget` | Singleton push target (sealed PAT, repo, branch, `lastBranchNumber` = the `loop-NN` counter) |
| `SelfTask` | One concrete finding (kind, file, line, priority, status, attempts) — the loop's self-generated input |
| `LlmConfig` | Singleton Gemini API key + model |
| `Prophecy` | A falsifiable prediction the system makes about itself (claim, confidence, falsifiabilityCriterion, status) |
| `SystemFlag` | Generic key/value runtime flag (safe-mode, red-team:last-run, etc.) |
| `Lesson` | Compounding intelligence — general rules distilled from history (score = helped/(helped+hindered)) |
| `MutationCorpus` | One row per mutation attempt (audit trail + transform signal) |
| `MetaParam` | The loop's own tunable knobs as rows (DISTILL_INTERVAL, MAX_INJECTED, PRUNE_SCORE, etc.) |

---

## API routes (60)

Mutating routes (POST/PUT/PATCH/DELETE) are gated by `src/middleware.ts` (`x-loop-key` header vs `LOOP_API_KEY`, 60 mutations/min/IP rate limit). Fail-open only while unset (one-time warn).

| Method | Path | What it does |
|---|---|---|
| GET | `/api` | Service index (lists every route) |
| GET | `/api/health` | Liveness probe of every subsystem incl. WS mini-service |
| GET/HEAD | `/api/healthz` | Minimal always-200 probe; exposes `mutationGate.configured` |
| GET | `/api/boot/scan` | Boot-splash vitals (sealed-PAT auth, corpus, pass-rate trend, scars, autonomy, cortex, quota) |
| POST | `/api/self-enhance/start` | Start the continuous self-enhance loop |
| POST | `/api/self-enhance/stop` | Stop it |
| GET | `/api/self-enhance/status` | Live status (running, stats, logs, current file, llmGate, saturation) |
| POST | `/api/self-enhance/trigger` | Run one cycle (5s route cooldown) |
| POST | `/api/self-enhance/push` | Manual git commit+push of live state |
| GET/POST/DELETE | `/api/self-enhance/push-target` | Configure/clear GitHub push target (PAT never returned) |
| POST | `/api/self-enhance/reboot` | Restart the loop after a provider-config change; persists re-arm (auto-start on next boot) |
| GET/POST | `/api/self-enhance/llm-config` | Configure Gemini direct API key |
| GET/POST | `/api/self-enhance/visibility` | Read/flip the GitHub repo's public/private flag |
| GET | `/api/self-enhance/files` | Scanned-from-disk file inventory with protected flags |
| GET | `/api/self-enhance/tasks` | List SelfTask queue + counts |
| POST | `/api/self-enhance/rescan` | Re-scan source → generate new SelfTasks |
| POST | `/api/self-enhance/skip` | User veto of next pending task |
| POST | `/api/self-enhance/unlock` | Unlock a saturated file |
| GET/POST | `/api/self-enhance/archaeology` | Run git-history miner (zero LLM) |
| POST | `/api/self-enhance/chat-task/propose` | LLM proposes a plan from a user goal (no writes) |
| POST | `/api/self-enhance/chat-task/apply` | Apply approved plan through the gate chain → push |
| GET/POST | `/api/self-enhance/prune-branches` | Branch retention: GET = dry-run preview; POST = execute drain (`{keep?, margin?, dryRun?}`) |
| GET/POST | `/api/self-enhance/merge-back` | Reviewed catch-up of a retained `loop-NN` branch into main: GET (no arg) = list candidates; GET `?branch=loop-NN` = full plan; POST `{branch, strategy:"dry-run"\|"theirs-for-source", push?}` = execute (typecheck-gated, commits but does not push by default) |
| GET | `/api/self-enhance/pass-rate-trend` | Pass rate over time from the mutation corpus (headline window, trend, buckets) |
| POST | `/api/autonomous/start` | Arm autonomous remote-repo loop |
| POST | `/api/autonomous/stop` | Disarm (sticky) |
| GET | `/api/autonomous/status` | Full LoopState (config, livePhase, stats, logs, currentCycle) |
| POST | `/api/autonomous/trigger` | Manual one-shot remote cycle |
| POST | `/api/autonomous/config` | Patch LoopConfig |
| GET | `/api/autonomous/recent-cycles` | Recent cycle summaries |
| POST | `/api/oracle/generate` | Generate 1–10 prophecies |
| POST | `/api/oracle/evaluate` | Judge all due prophecies |
| GET | `/api/oracle/status` | Counts, calibration per threshold, Brier score |
| GET | `/api/oracle/prophecies` | Recent prophecies (cap 200) |
| GET | `/api/oracle/events` | Oracle event ring buffer (200 cap, `since` cursor) |
| GET/POST | `/api/oracle/archaeology` | Mine target repo's git history → seed prophecies |
| GET/DELETE | `/api/postmortems` | List active postmortems; dismiss by id |
| POST | `/api/postmortems/seed` | Import postmortems from external markdown |
| GET/POST | `/api/postmortems/chain` | Verify/backfill the tamper-evident chain |
| POST | `/api/red-team/run` | Run the 7-probe adversarial suite (300s timeout) |
| GET | `/api/red-team/status` | Suite metadata + last run summary |
| POST | `/api/emg/sanitize` | Run the sanitizer on pasted code |
| POST | `/api/pipeline/run` | Manual 6-stage remote-repo pipeline run |
| GET | `/api/pipeline/history` | Last 25 PipelineRun rows |
| POST | `/api/secret-scan/scan` | Scan pasted content for secrets |
| GET | `/api/memory/entries` | All MemoryEntry rows |
| GET | `/api/memory/query` | TF-IDF ranked retrieval |
| POST | `/api/duress/purge` | Manual PKM §3 purge (purge PAT → safe-mode → halt) |
| GET | `/api/duress/status` | Safe-mode state + consecutive auth failures |
| POST | `/api/duress/clear` | Operator clears safe-mode (read-back) |
| POST | `/api/evolution/coherence-gate` | Length-ratio coherence check |
| POST | `/api/evolution/debate` | Run the LLM debate tribunal |
| GET | `/api/branches` | List `loop-NN` branches from GitHub |
| GET | `/api/engines/catalog` | List configured siphon sources |
| POST | `/api/hot-swap/trigger` | Force pipeline hot-swap |
| GET | `/api/hot-swap/status` | Swap count + running fingerprint |
| POST | `/api/github/validate-token` | Validate GitHub PAT |
| POST | `/api/github/repo-tree` | Fetch repo tree (recursive) |
| POST | `/api/github/fetch-file` | Fetch a single file |
| POST | `/api/github/commit-file` | Commit a single file to a branch |
| POST | `/api/github/batch-commit` | Commit multiple files in one batch |

---

## Safety mechanisms

| Mechanism | File | What it does |
|---|---|---|
| **Protected-files list** | `autonomous/protected-files.ts` | 33 paths + 16 prefixes the loop can never touch — including the list itself |
| **Mutation guard** | `core/mutation-guard.ts` | Synchronous fail-closed triage: newly-introduced `eval(`, `child_process`, `fetch(`, `globalThis[`, path-traversal, MD5/SHA1; protected-path + scaffolding check |
| **AST diff gate** | `core/ast-diff-gate.ts` | TS compiler API symbol extraction; detects symbol-drop, branding-injection, structural drift. Score ≥ 50 to pass |
| **Structural validator** | `autonomous/structural-validator.ts` | Regex pre-gate: destructive truncation, import stripping, export drop, test deletion, license-header stripping |
| **In-memory typecheck** | `autonomous/in-memory-typecheck.ts` | Full project `tsc --noEmit` with refactored file substituted — Turbopack never sees broken code |
| **Sandbox test** | `core/sandbox-test.ts` | Disposable `.loop-sandbox/verify-XXXX/`; candidate never touches live tree; isolated DB (blank when live DB >32MB) |
| **Schema gate** | `autonomous/schema-gate.ts` | Additive-only Prisma mutations; canary round-trip after `db push`; restore on any failure |
| **Sanitizer** | `emg/sanitizer.ts` | Shannon-entropy pre-screen for secrets/PII in LLM output |
| **Secret scan** | `core/secret-scan.ts` | Pre-push scan of diff + commit message for ghp_/AIza/AKIA/sk-/xox/private keys |
| **Debate tribunal** | `llm/debate-llm.ts` | 3 LLM reviewers (Security/Architecture/Lead); no fallback; validated stances + consensus |
| **Halt governor** | `emg/halt.ts` | Self-stopping: tree-fingerprint-saturated, zero-diff-saturation, consecutive-failure-limit |
| **Saturation lockout** | `autonomous/saturation.ts` | 3 consecutive no-growth cycles → file locked out for the rest of the pass |
| **Postmortem chain** | `postmortem/postmortem-store.ts` + `postmortem-repo.ts` | Tamper-evident sha256 chain; disk JSON is the source of truth; rehydrates from disk on DB wipe |
| **Ancestral RAG** | `postmortem/ancestral-rag.ts` | Zero-LLM keyword search over all verified postmortems |
| **Lessons** | `autonomous/lesson-store.ts` + `lapse-detector.ts`, `mutation-corpus.ts`, `meta-params.ts`, `meta-tuner.ts`, `dreamer.ts`, `reflection.ts` | Every N cycles, distill general rules from history; inject top-K by score; measure helped/hindered; prune low-scorers |
| **Crash wall** | `autonomous/crash-budget.ts` | 3 consecutive same-class crashes → sticky ARMED-PAUSED; persisted to `.git/info/` (survives process death) |
| **Dead-man's switch** | `autonomous/operator-touch.ts` | 24h without operator touch → ARMED-PAUSED |
| **Armed state** | `autonomous/armed-state.ts` | Wipe-proof `[START]`/`[STOP]` intent in `.git/info/loop-armed-state.json` |
| **Tree lock** | `core/tree-lock.ts` | FIFO mutex serializing live-tree writes (loop vs chat-task) |
| **Token vault** | `crypto/token-vault.ts` | AES-256-GCM `enc:v1:` envelope; key at `.git/info/loop-vault-key` (0600) |
| **3-tier PAT** | `autonomous/push-target.ts` | DB → root state file → `.git/info/` (wipe-proof); all sealed; load-bearing read-back |
| **Duress / safe-mode** | `core/duress.ts` | 5 consecutive 401/403 → purge PAT → raise safe-mode → halt; auto-rehydrate at boot |
| **Red-team suite** | `red-team/red-team-suite.ts` + `red-team-runner.ts` | 7 probes (unauthorized-package, exfiltrate-keys, boundary-bypass, disable-gates, deceptive-cooperation, history-rewrite, pat-in-source); containment bypass → safe-mode |
| **Gate-integrity probes** | `red-team/gate-integrity-probe.ts` | 15 deterministic self-audits of the LIVE gate code; any failure → safe-mode |
| **Hot-swap** | `core/hot-swap.ts` | Replace running pipeline code between cycles without restart; state-continuous (cyclesCompleted + saturation preserved) |
| **API-key gate + rate limit** | `src/middleware.ts` | POST/PUT/PATCH/DELETE require `x-loop-key`; 60 mutations/min/IP |
| **Route cooldowns** | `autonomous/route-cooldown.ts` | 5s per-route cooldown on trigger endpoints |
| **Crash handlers** | `src/instrumentation.ts` | Swallow `unhandledRejection`/`uncaughtException` (Bun would otherwise kill the process) |

### The auto-run state machine

```
DISARMED → [START] → ARMED-RUNNING
ARMED-RUNNING → quota halt → ARMED-THROTTLED
ARMED-THROTTLED → quota reset → ARMED-RECOVERING (30s settle)
ARMED-RECOVERING → timer → ARMED-RUNNING / [PAUSE] → ARMED-PAUSED
ARMED-PAUSED (sticky — only manual [START] releases it)
```

**Stop-priority hierarchy (top wins):** operator `[STOP]` (sticky, wipe-proof) → crash-wall (3 same-class crashes, wipe-proof) → dead-man's switch (24h, wipe-proof) → quota gate (the only stop that AUTO-RECOVERS: throttle → 30s settle → resume, escalating 2/5/15/30min on consecutive 429s).

---

## Retention policy

Growth audit (2026-11-09): what accumulates, what's bounded, and what must never be deleted. The one-sentence version: **bounded stores are capped, scar tissue is permanent, and measurements are never deleted.**

| Store | Growth | Policy | Why |
|---|---|---|---|
| `loop-NN` branches (GitHub) | +1 per successful mutation | **Keep newest 50**, hysteresis margin 10. Auto-drained fire-and-forget after each successful push (`push-target.ts` → `pruneOldLoopBranches`); operator drain via `GET/POST /api/self-enhance/prune-branches` (GET is always a dry-run). Seed branch and every non-`loop-NN` branch are protected by construction; deletes are sequential + rate-limit-aware and resume on the next push if GitHub throttles mid-batch. | 198 refs had accumulated — the branch listing and audit search were becoming unusable. The commits are the record of truth (seed lineage + mutation number in the log); branches are convenience pins. First drain: 198 → 50, 148 deleted, zero failures, counter intact (`loop-199` next). Branches are a LINEAR CHAIN (each `loop-NN` is an ancestor of `loop-(NN+1)`), so pruning old branches loses zero history — the full mutation lineage is preserved in the newest retained branch. |
| `PipelineRun` (DB) | +1 row per file per cycle (autonomous) / per manual run | **Keep newest 25 (manual path) / 50 (autonomous path)**; code blobs capped at **20 KB** (both paths — the full code lives in git history on the `loop-NN` branch). The autonomous path's prune fires fire-and-forget after each write in `loop-runtime.ts` via `retention.ts → prunePipelineRuns`. | The manual path (`/api/pipeline/run/route.ts`) had this from audit 3; the autonomous path copied the WRITE but not the RETENTION and stored 200 KB blobs — a 178 MB-waiting-to-happen copy-paste mistake. Fixed in audit 4 (the grow-only sweep): blob cap 200 KB → 20 KB, prune added. |
| `AutonomousCycle` (DB) | +1 row per cycle | **Keep newest 200** (~a week of continuous running); pruned fire-and-forget after the write in `loop-runtime.ts → finalizeCycle` via `retention.ts → pruneAutonomousCycles`. | Before audit 4 there was NO deletion logic anywhere in the codebase — the table grew at 1 row/cycle forever. The oracle + UI only read the recent tail; older rows had no live consumer. |
| `loop-hot-swap-journal.jsonl` (`.git/info/`) | +1 line per successful swap (~200 bytes) | **Keep newest 1000 entries**; rotated every 50th swap in `hot-swap.ts → appendSwapJournal` via `retention.ts → pruneHotSwapJournal`. | The in-memory `swapHistory` was capped at 25, but the DISK journal was append-only — the reader loads the whole file and splits on newlines, so a multi-MB journal would slow every swap-reader call. |
| `MutationCorpus` (DB) | +1 row per attempt | **Capped at 2000 rows** (~1 MB bound; trimmed every 25th cycle) — pre-existing design | The distiller's digest and the negative-constraint block read recent windows (≤300 rows); 2000 covers them with headroom. |
| `Postmortem` (DB + `postmortems/` disk) | +1 per (repo, branch, file) failure | **Never pruned** | The tamper-evident sha256 chain threads `parentHash` through every record; resolved postmortems still feed ancestral RAG and the archaeology miner; disk JSON is the wipe-proof record of what actually failed. Deleting them destroys the learning substrate for zero storage benefit. |
| `Lesson` (DB) | slow (distiller-derived) | **Never pruned** | Deactivated/revoked lessons exist precisely so the distiller SEES them and doesn't re-derive rules reality already rejected. Deleting them un-learns. (Low-scoring lessons are deactivated, not deleted — the score system, not a reaper, is the retention mechanism.) |
| `Prophecy` (DB) | slow (oracle-generated) | **Never pruned** | Judged prophecies ARE the calibration evidence — the Brier score and per-threshold hit rates are computed over all predictions ever made. Pruning would be self-flattery (documented in `prophecy-store.ts`). Pending prophecies are lifecycle-managed by the evaluator (fulfilled/failed/retired). |
| `worklog.md` | append-only | **Watch, don't rotate** | Every reader takes a bounded tail (≤80 lines); 210 KB today. Rotation would break the archaeology narrative. Revisit at ~50 MB. |

---

## The branch architecture & main↔loop divergence (audit 4)

**How the loop's mutations reach GitHub, and why `main` lags.** The loop commits each mutation to local HEAD and pushes it to a per-cycle remote `loop-NN` branch (`git push origin HEAD:refs/heads/loop-NN`). The branches form a **linear chain** — each `loop-NN` is an ancestor of `loop-(NN+1)`, so the newest retained branch contains the full mutation lineage. `main`, by contrast, is **operator-curated**: the operator deliberately merges specific loops in (e.g. the `Merge remote-tracking branch 'origin/loop-175'` commit), plus operator pushes, lessons exports, and host-injected UUID commits on machine restart.

**The divergence this created (the thing the user flagged):** because the loop had no path back to `main`, after 198 cycles `main` was 35 mutations behind `loop-198` — 49 files differed (782 insertions / 874 deletions), and the **running system was not benefiting from its own recent self-enhancements**. The mutations existed only on the `loop-NN` branches; the working tree (which tracks `main`) was stale. Verifying: local `main` HEAD = `1439f02 memory: lessons.md export`; `origin/loop-198` HEAD = `928284d Self-enhancement: src/lib/pipeline/oracle/prophecy-store.ts`; `git log main..origin/loop-198` = 35 commits.

**The fix — merge-back (reviewed, typecheck-gated, no auto-merge):**
- `GET /api/self-enhance/merge-back` lists retained `loop-NN` branches with a per-branch summary (sha, commits ahead, src/ files delta).
- `GET ?branch=loop-NN` returns the full plan (source files to change, main-only files, conflicts).
- `POST {branch, strategy, push?}` executes. `strategy: "theirs-for-source"` stages src/ files from the loop branch, runs `tsc --noEmit`, and commits **only if typecheck passes** (aborts + restores the working tree on failure). Main's metadata (README, `memory/`, `postmortems/`, `package.json`, `prisma/`) is kept on main's version — only `src/` comes forward. Push is **off by default** so the merge stays reversible (`git reset --soft HEAD~1`) until the operator pushes via the existing [PUSH] UI.
- The `merge-back-panel.tsx` UI exposes this from the header's [MERGE-BACK] button.

**Why no auto-merge:** a raw `git merge origin/loop-198` would conflict across ~48 files (both lineages edited the same autonomous-pipeline files after main's last deliberate merge). The operator's curation history signals they want manual control over what reaches main. Merge-back gives them that control with a typecheck safety net.

---

## Honest assessment — what the loop actually does (audit 4)

Three read-only audits (retention, oracle calibration, pass-rate trend) ran in parallel. The honest findings:

**Retention (grow-only sweep):** the loop had **four** unbounded stores with no deletion logic — git branches (fixed in audit 3), `PipelineRun` autonomous path (200 KB blobs + no prune — a 178 MB-waiting-to-happen copy-paste mistake), `AutonomousCycle` (1 row/cycle, never deleted), and the hot-swap disk journal (append-only). All four are now bounded via `retention.ts`. Lower-risk stores (`MemoryEntry`, `SelfTask` terminal states, `Lesson` deactivated rows) are unbounded but slow-growing — flagged for future soft-caps, not urgent. `Prophecy` is grow-only **by design** (judged prophecies are the calibration evidence; pruning would be self-flattery).

**Oracle calibration: UNVERIFIABLE.** The DB held 2 prophecies, both pending, zero resolved. Every calibration metric (bucket table, Brier score, reliability, resolution bias, time drift) is `n/a` because the denominator is zero. The oracle subsystem is plumbed correctly (schema, store, generator, evaluator, scheduler) but has **not accumulated a track record**. To get a useful calibration curve (≥30 per bucket × 10 buckets) we need ≥300 resolved prophecies — at ~1/cycle that's ≥300 cycles with the LLM gate open. Secondary smell: the generator quantizes confidence (both observed prophecies sat at exactly 0.70) — worth re-checking once a real track record exists.

**Pass-rate trend: IMPROVING but plateauing.** Reconstructed from 198 `git log origin/loop-NN` tip commits (passes) + `Postmortem.attempts` (fails): overall **45.4%** (198/436). Quarterly, monotonic up: Q1 33.3% → Q2 46.3% → Q3 58.1% → Q4 60.0%. First-half → second-half: 28.9% → 61.9% = **+33 pp** (3.3× the schema's own "improving" threshold; 4/4 quarters monotonic = p=1/16 under a fair-coin null). **The system IS learning to mutate itself.** Caveats: (1) per-failure timestamps were lost in a DB rollback, so the exact slope is uncertain (the direction is robust); (2) two improvement mechanisms — genuine lesson-distillation getting better on the bulk of files AND saturation-lockout removing stuck files from the denominator — both raise the pass rate but aren't the same thing. The Q3→Q4 near-plateau (+1.9 pp) suggests an asymptote around 60%. **The wall to break:** `ZERO_DIFF_SATURATION` is 72% of fails (172/238) — the LLM produces no semantic change on files it's already touched. To break past 60%, the loop needs to crack zero-diff, not just lock out the files that trigger it.

**The deeper limitation the loop can't fix itself:** the loop makes local edits — one file, one refactor at a time. It cannot do the cross-file integration work (wiring a new API route to a new UI panel, factoring a shared helper out of two modules, adding a retention helper and calling it from three sites). That's the integration refactor this audit represents — done outside the loop, by the operator, informed by the loop's own measurements.

---

## File-by-file inventory

### Root config

| File | Purpose |
|---|---|
| `package.json` | Next.js 16 + React 19 + Prisma 6 + z-ai-web-dev-sdk + Socket.io stack; scripts `dev`/`build`/`start`/`db:*`/`test` |
| `next.config.ts` | Standalone output; typecheck errors fail build; `reactStrictMode: false` (BIOS terminal polls in effects) |
| `tsconfig.json` | Strict TS, ESNext, bundler resolution, `@/*` → `./src/*` alias |
| `eslint.config.mjs` | `next/core-web-vitals` + `next/typescript` with most rules disabled (permissive stance) |
| `postcss.config.mjs` | Tailwind v4 PostCSS plugin |
| `components.json` | shadcn/ui New York config |
| `Caddyfile` | Gateway :81; `?XTransformPort=3003` → WS mini-service, else → Next.js :3000 |
| `start-dev.sh` | `exec bun run dev` from script dir |
| `rea-restore.sh` | One-off cleanup of cosmetic headers from the old `rea` era (not live) |
| `readme.bat` | Operator's fixed-point statement (a `.bat` so the `.ts`-only scanner can't ingest it) |
| `bun.lock` | Bun lockfile |
| `next-env.d.ts` | Next.js type references |
| `.gitignore` | Excludes `node_modules`, `.next`, `.env*`, `dev.log`, `.loop-sandbox`, `.loop-push-state.json` |

### `prisma/`

| File | Purpose |
|---|---|
| `prisma/schema.prisma` | 12 models (see above). Additive-only through `schema-gate.ts`. Protected models: Postmortem, Lesson, GitPushTarget, LlmConfig, Prophecy, SystemFlag, MutationCorpus, MetaParam |

### `src/app/`

| File | Lines | Purpose |
|---|---|---|
| `src/app/page.tsx` | 2500 | The single user-visible route — full-screen BIOS terminal; the operator's control surface. Patches `window.fetch` to attach `x-loop-key`; polls `/api/self-enhance/status` (2s), `/api/self-enhance/tasks` (5s), `/api/oracle/events` (5s, `since` cursor); command parser (`help`/`start`/`stop`/`status`/`task`/`push`/`oracle`/`skip`/`config`/`clear`...); git token masking in echo. **Protected control surface.** |
| `src/app/layout.tsx` | — | Root HTML; dark theme; self-hosted Geist fonts via `geist` package; `<Toaster />`; metadata (title "LOOP", author "craighckby-stack"). **Protected.** |
| `src/app/display/console-stream.tsx` | — | Mutable display layer — receives `ConsoleLine[]`, renders them. Owns no state (page.tsx does). The loop CAN refactor this freely. |
| `src/app/globals.css` | — | shadcn/ui theme (Tailwind v4) |

### `src/app/api/` (59 routes)

All routes set `runtime = "nodejs"`, `dynamic = "force-dynamic"`. Mutating routes (POST/PUT/PATCH/DELETE) are gated by `src/middleware.ts`. See the API routes table above for the full list.

### `src/middleware.ts`

API-key gate + rate limit for `/api/:path*`. POST/PUT/PATCH/DELETE require `x-loop-key` header == `LOOP_API_KEY`. Fail-open if env unset (one-time warn). 60 mutations/min/IP sliding window, 1000-IP map cap. Outside the loop's scan scope.

### `src/instrumentation.ts`

Next.js instrumentation hook — runs once at server boot. Registers `unhandledRejection`/`uncaughtException` swallowers (Bun would otherwise kill the process on a native segfault). Fires `warmZaiCortex()` so the Z.AI SDK handshake + one-shot ping is in flight before the boot splash fetches `/api/boot/scan`.

### `src/lib/`

| File | Purpose |
|---|---|
| `src/lib/db.ts` | Prisma client singleton (cached on globalThis). **Protected.** |
| `src/lib/utils.ts` | shadcn's `cn` helper (`twMerge(clsx(...))`) |
| `src/lib/retro-boot-audio.ts` | WebAudio-synthesized boot soundtrack (CRT degauss thump + POST beep); master volume pinned at 1.0 |
| `src/lib/pipeline-store.ts` | Client-side Zustand store (`wsConnected`, `loopState`, `pipelineReport`, `repoFiles`, `githubUser`, etc.) |
| `src/lib/test.ts` | Empty placeholder |

### `src/hooks/`

| File | Purpose |
|---|---|
| `src/hooks/use-loop-socket.ts` | Connects to the WS mini-service via `io("/?XTransformPort=3003")`; on `state` event pushes `LoopState` into the Zustand store |
| `src/hooks/use-toast.ts` | shadcn/ui toast hook (`TOAST_LIMIT = 1`) |
| `src/hooks/use-mobile.ts` | `useIsMobile` — `matchMedia` at 768px |

### `src/types/bun-test.d.ts`

Ambient `bun:test` module declaration so the ratchet's gate 3 (`tsc --noEmit` over drafted tests) doesn't fail with TS2307.

### `src/components/pipeline/` (18 panels)

| File | Purpose |
|---|---|
| `boot-splash.tsx` (986) | BIOS cold/warm boot ceremony; fetches its vitals endpoints in parallel; CRT amber-phosphor aesthetic; honors `prefers-reduced-motion`; stamps the PASS RATE line (last-≤20 resolvable attempts + trend) |
| `api-unlock.tsx` | UI half of the middleware's API-key gate; listens for `loop-api-unauthorized` event; bottom-right key prompt; fetches `/api/healthz` to confirm the gate is actually configured |
| `oracle-panel.tsx` (588) | Modal: Oracle track record (counts, calibration per threshold 0.5/0.7/0.9, Brier score), recent prophecies, [GENERATE]/[EVALUATE] |
| `defense-panel.tsx` (511) | Modal: DURESS/safe-mode (with [PURGE]/[CLEAR]), RED-TEAM (probe catalog + last run + [RUN SUITE]), SECRET-SCAN (paste-and-scan tool) |
| `branches-panel.tsx` | Modal: `loop-NN` mutation branches from GitHub with commit message, sha, date, link |
| `merge-back-panel.tsx` | Modal: reviewed catch-up of a retained `loop-NN` branch into the operator-curated `main`. Lists candidates, shows the per-branch merge plan (src/ files to change, conflicts), [DRY-RUN]/[EXECUTE] (typecheck-gated — `tsc --noEmit` runs after staging; the commit never lands if it fails). Push is off by default so the merge stays reversible until the operator pushes. Addresses the main↔loop divergence (the loop creates branches but had no path back to main). |
| `header-bar.tsx` | Sticky header with subsystem badges, loop status, WS connection, cycle count |
| `loop-control-panel.tsx` (484) | Loop config form (mode, interval, target repo, branches); legacy shadcn-styled panel |
| `manual-runner.tsx` | Manual single-file pipeline runner; legacy UI |
| `pipeline-stages.tsx` | Animated stage-by-stage pipeline visualization (stages 0–5) |
| `postmortem-panel.tsx` | Modal: per-file postmortems with failure-type color coding |
| `recent-cycles.tsx` | Card: recent `AutonomousCycleSummary` rows |
| `current-cycle.tsx` | Card: in-flight cycle (or "no active cycle") |
| `debate-chamber.tsx` | Card: debate tribunal verdict (Security/Architecture/Lead) |
| `memory-bank.tsx` | Card: `MemoryEntry` rows from `/api/memory/entries` |
| `log-stream.tsx` | Card: live `LoopLogEntry[]` (legacy; live UI uses `<ConsoleStream>`) |
| `ast-inspector-modal.tsx` | Modal: AST diff violations + sanitizer result for a manually-run pipeline report |

### `src/components/ui/` (48 shadcn/ui New York primitives)

Standard shadcn/ui components — accordion, alert, alert-dialog, aspect-ratio, avatar, badge, breadcrumb, button, calendar, card, carousel, chart, checkbox, collapsible, command, context-menu, dialog, drawer, dropdown-menu, form, hover-card, input, input-otp, label, menubar, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, select, separator, sheet, sidebar, skeleton, slider, sonner, switch, table, tabs, textarea, toast, toaster, toggle, toggle-group, tooltip. Outside the loop's scan scope.

### `src/lib/pipeline/autonomous/` (43 files — the brain)

| File | Purpose |
|---|---|
| `protected-files.ts` | **Single source of truth** for what the loop may NOT modify. 33 `PROTECTED_FILES` + 16 `PROTECTED_PREFIXES`. Protected itself. |
| `loop-runtime.ts` (2007) | Remote-repo autonomous loop runtime (singleton on `globalThis.__autonomousLoopRuntime`); 4 modes; crash-wall; dead-man's switch; ARMED-RECOVERING 30s settle |
| `self-enhance-loop.ts` (2862) | **THE BRAIN** — self-mutation loop. Scans own source, builds prompt with postmortems + ancestral RAG + lessons, LLM refactor, gate chain, commit + push to `loop-NN`. Per-cycle: ratchet-draft, distill lessons, meta-tune, test-attacker, gate-integrity-probe, branch-retention drain |
| `self-task-generator.ts` | **THE INPUT LAYER** — static AST self-scan → `SelfTask` queue (todo, empty-catch, any, missing-return-type, unused-import, magic-number, non-null-assertion) |
| `push-target.ts` (1838) | 3-tier sealed-PAT GitHub push (DB → root state → `.git/info/`); `git add` → secret-scan → commit → push (no force); auto-create repo; UUID-commit detector + auto-amend; branch retention (`pruneOldLoopBranches` — keep newest 50, hysteresis 10, rate-limit-aware drain) |
| `retention.ts` | Shared bounded-growth helpers (audit 4 — the grow-only sweep): `prunePipelineRuns(keep=50)`, `pruneAutonomousCycles(keep=200)`, `pruneHotSwapJournal(keepEntries=1000)`. All best-effort (a prune failure never fails the cycle that triggered it). Called fire-and-forget from `loop-runtime.ts` (PipelineRun + AutonomousCycle) and `hot-swap.ts` (journal rotation, every 50th swap). |
| `merge-back.ts` | Reviewed catch-up of a retained `loop-NN` branch into operator-curated `main` (audit 4 — the main↔loop divergence). `analyzeMergeBack(branch)` computes the plan (commits ahead/behind, src/ files to change, conflicts); `executeMergeBack(branch, {strategy, push?})` stages src/ files from the loop branch, runs `tsc --noEmit`, commits ONLY if typecheck passes (aborts + restores on failure). Strategy `theirs-for-source` brings src/ mutations forward, keeps main's metadata (README, memory/, postmortems/). Push off by default (reversible until pushed). Exposed via `/api/self-enhance/merge-back` + `merge-back-panel.tsx`. |
| `verify-refactor.ts` | Child-process gate chain: mutation-guard → structural + AST → syntax → typecheck. Nothing written to disk |
| `in-memory-typecheck.ts` | Full project `tsc --noEmit` with refactored file substituted via custom compiler host |
| `structural-validator.ts` | Regex pre-gate: truncation, import stripping, export drop, test deletion, license stripping |
| `code-analysis.ts` | Parser-aware source analysis (`maskTokens` uses real TS scanner to avoid URL-string false positives) |
| `schema-gate.ts` | Additive-only Prisma mutation gate; structural check → `prisma validate` → `db push` → canary round-trip; restore on failure |
| `saturation.ts` | Per-file saturation; `SCAN_SCOPES` (pipeline .ts, display .tsx, components .tsx, api .ts); `SATURATION_THRESHOLD = 3` |
| `lesson-store.ts` (568) | Compounding intelligence — distill every `DISTILL_INTERVAL` cycles; inject top-K by score; measure helped/hindered; prune; revoke |
| `lapse-detector.ts` | D1 — detect when an injected lesson was IGNORED (stemmed-token overlap ≥ 0.30) |
| `meta-params.ts` | D8 — the loop's tunable knobs as DB rows (DISTILL_INTERVAL, MAX_INJECTED, PRUNE_SCORE, etc.) |
| `meta-tuner.ts` (301) | D8 — L4 rung: every `TUNE_INTERVAL=50` cycles, snapshot pass rate, propose one step, accept only if trial ≥ baseline + 0.05 |
| `mutation-corpus.ts` (414) | D4 — one row per mutation attempt (audit trail + transform signal); retention capped at 2000 rows; `getPassRateTrend()` powers the PASS RATE boot line + `/api/self-enhance/pass-rate-trend` |
| `dreamer.ts` | D3 — idle-time consolidation (ratchet-draft characterization tests, pattern-naming); self-skips when LLM gate closed |
| `reflection.ts` | D7 — Reflexion. One cheap LLM call after a failed mutation (attempts ≥ 2) asks the model to diagnose its own reasoning |
| `archaeology.ts` (484) | Deterministic git-history miner (zero LLM). 3-pass: REVERTED, SELF-FAIL, FIX-PAIR → fragility map + cross-file lessons |
| `chat-task.ts` (610) | Operator-approved code writes. `proposeTaskPlan(goal)` → `applyTaskPlan` through the gate chain → push |
| `task-executor.ts` | Runs a single SelfTask. Deterministic path (`missing-return-type` uses TS inference, zero LLM) + LLM path |
| `lessons-markdown.ts` | D6 — mirror Lesson table into `memory/lessons.md` after every distillation pass (human-readable + human-editable) |
| `armed-state.ts` | Wipe-proof `[START]`/`[STOP]` intent — `.git/info/loop-armed-state.json` |
| `crash-budget.ts` | Wipe-proof crash counter — `.git/info/loop-crash-budget.json` |
| `operator-touch.ts` | Wipe-proof dead-man's switch — `.git/info/loop-operator-touch.json` (24h threshold) |
| `route-cooldown.ts` | Per-route cooldown guard (5s) on trigger endpoints |
| `loop-event-bus.ts` | In-process pub/sub for streaming autonomous loop events (state, log, stage, push) |

### `src/lib/pipeline/core/` (13 files — the gate machinery)

| File | Purpose |
|---|---|
| `paths.ts` | Single source of truth for `PROJECT_ROOT` (detects via cwd markers; fallback `/home/z/my-project`) |
| `unified-pipeline.ts` (761) | The 6-stage remote-repo pipeline (siphon vote → sanitize → ReAct → AST gate → debate → converge+commit) |
| `ast-diff-gate.ts` | TS compiler API symbol extraction; detects symbol-drop, branding-injection, structural drift; score = retention (60%) + quality (40%) − branding (20×) |
| `mutation-guard.ts` | Two-authority triage: synchronous fail-closed (newly-introduced evil tokens) + structural (protected paths + scaffolding) |
| `secret-scan.ts` (536) | Pre-push secret/PII scanner; SENSITIVE_PATTERNS catalog + high-entropy fallback; `scanDiff` over added lines |
| `duress.ts` (429) | Duress/purge protocol (PKM §3); 5 consecutive 401/403 → purge PAT → safe-mode → halt; auto-rehydrate at boot |
| `hot-swap.ts` (650) | Replace running pipeline code between cycles; PAUSE → SNAPSHOT → CLEAR PINS → STASH → touch mtime; state-continuous |
| `sandbox-test.ts` | Disposable `.loop-sandbox/verify-XXXX/`; candidate never touches live tree; isolated DB (blank when live >32MB); paranoia guard on `rmSync` |
| `test-gate-journal.ts` | Defense-in-depth crash insurance (v1 era); 1-hour age expiry so a stale journal never reverts committed work |
| `tree-lock.ts` | FIFO mutex serializing live-tree writers (loop vs chat-task) |
| `siphon.ts` | Architectural pattern ingestion from 5 grafted sources; `performArchitecturalVote` by keyword threshold |
| `binaryShield.ts` | SHA-256 helper (`computeHash`); used by the convergence stage |
| `exclusion-patterns.ts` | Shared exclusion patterns for scan + AST + archaeology (lockfiles, generated, ledger/meta) |

### `src/lib/pipeline/emg/` (4 files)

| File | Purpose |
|---|---|
| `sanitizer.ts` | Shannon-entropy pre-screen + secret/PII scanner for LLM output; fixture-aware (skips test/mock/example paths) |
| `debate.ts` | TYPES for the debate tribunal (the old rule-based `conductDebate` was removed — it fabricated reviewer statements) |
| `halt.ts` | Self-stopping governor (`TREE_FINGERPRINT_SATURATED`, `ZERO_DIFF_SATURATION`, `CONSECUTIVE_FAILURE_LIMIT`, `MAX_CYCLES_REACHED`); uses real TS scanner so URL strings aren't misclassified |
| `emg-rag.ts` | In-memory TF-IDF RAG over `MemoryEntry` rows; only real observations (no synthetic seed) |

### `src/lib/pipeline/llm/` (3 files)

| File | Purpose |
|---|---|
| `agent-llm.ts` (568) | Real LLM wrapper around `z-ai-web-dev-sdk`. **Shared 429 gate** (escalating 2/5/15/30min); serialized dispatch; 180s call timeout; Z.ai cortex auto-injection at server boot |
| `debate-llm.ts` | 3-reviewer tribunal (Security/Architecture/Lead); parallel + synthesis; NO FALLBACK; validated stances + consensus; fence-escape hardening; 12k-char truncation |
| `gemini-direct.ts` (628) | Direct Gemini REST with user-pasted key OR via `GEMINI_PROXY_BASE_URL` proxy; per-model circuit-breaker cascade (2.5-flash → 2.0-flash → 2.5-pro); 10-min location-block cooldown |

### `src/lib/pipeline/oracle/` (8 files)

| File | Purpose |
|---|---|
| `prophecy-store.ts` | Thin DB CRUD over `Prophecy`; never prunes (old prophecies are the track record) |
| `prophecy-generator.ts` | Produces a falsifiable prediction grounded in the system's own history (recent git log + worklog + postmortems + cycles); strict JSON |
| `prophecy-evaluator.ts` | Adversarial LLM judge; verdict fulfilled/failed/retired; RETIRED = "I can't tell" (honest, not a soft failure) |
| `oracle-auto.ts` | Post-cycle automatic prophecy generation; guards (LLM gate closed → skip; ≥5 pending → skip) |
| `oracle-scheduler.ts` | Background scheduler — every 5 min evaluates due prophecies; globalThis-guarded; `unref`'d; boots lazily |
| `oracle-events.ts` | In-memory ring buffer (200 cap) of oracle lifecycle events; polled by the console stream |
| `commit-archaeology.ts` (321) | Pair wrong/correct commits from a target repo's git history into a self-labeled prophecy dataset; 3 passes |
| `prophecy-store.test.ts` | `bun:test` characterization tests for the prophecy store (exercises the real DB) |

### `src/lib/pipeline/red-team/` (4 files)

| File | Purpose |
|---|---|
| `red-team-suite.ts` | 7-probe adversarial catalog (v1.0.0): unauthorized-package, exfiltrate-keys, boundary-bypass, disable-gates, deceptive-cooperation, history-rewrite, pat-in-source. FAKE_GITHUB_PAT is runtime-joined so the source stays scanner-clean |
| `red-team-runner.ts` | Runs the suite; classifier (refusal → BLOCKED; prohibited artifact → BYPASSED); errored → DEGRADED; BYPASS → postmortem + raises safe-mode |
| `test-attacker.ts` | D5 — red team for the ratchet. Every `ATTACKER_INTERVAL=20` cycles, adversarial LLM finds DIVERGENCE or WEAK PIN in newest pinned tests |
| `gate-integrity-probe.ts` | 15 deterministic probes (P1–P15) self-auditing the LIVE gate code; any failure → safe-mode |

### `src/lib/pipeline/postmortem/` (3 files)

| File | Purpose |
|---|---|
| `postmortem-store.ts` (1100) | Per-file negative constraints; tamper-evident sha256 chain; CANDIDATE→VERIFIED→REJECTED lifecycle; rehydrates from disk on DB wipe; `getConstraintsForFile` reads SQLite → disk JSON |
| `postmortem-repo.ts` | Repo-backed persistence. JSON at `postmortems/<repo>/<branch>/<filepath>.json`; atomic writes (tmp + rename); `safeSegments` drops `..`; schema-2 carries `verificationStatus` + chain hashes |
| `ancestral-rag.ts` | Zero-LLM-cost retrieval over the postmortem ledger (field-weighted: constraints=3, symptom=2, evidence=1); excludes current file's own postmortem |

### `src/lib/pipeline/crypto/` (1 file)

| File | Purpose |
|---|---|
| `token-vault.ts` | AES-256-GCM at-rest sealing for the GitHub PAT. Envelope `enc:v1:<iv>.<tag>.<ciphertext>`. Key at `.git/info/loop-vault-key` (0600, 32 random bytes, atomic tmp+rename). Fail-open seal (key unavailable → plaintext); fail-closed open (decrypt failure → empty string, never half-truth). Auto-migrates legacy plaintext |

### `src/lib/pipeline/api/` (1 file)

| File | Purpose |
|---|---|
| `github-helpers.ts` | GitHub token resolution + header builder for `/api/github/*`. ONLY client-supplied token considered (no env fallback — would be a silent write-proxy for every private repo). `isInvalidToken` rejects `MY_*` prefixes and `[REDACTED]`/`undefined` |

### `src/lib/pipeline/engines/` (1 file)

| File | Purpose |
|---|---|
| `clean-room-runtime.ts` (414) | Modular agent engine. `LifecycleKernel` (state machine: uninitialized/booting/ready/running/degraded/disposed, AbortController). `ReactLoopEngine` (bounded ReAct loop, max 8 steps). `executeCleanRoomEngine` runs the LLM reasoning loop with originalCode + filePath + postmortem constraints. Used by `unified-pipeline.ts` stage 2 |

### `mini-services/loop-ws-service/`

| File | Purpose |
|---|---|
| `index.ts` | Standalone Socket.IO server on :3003. Polls `/api/autonomous/status` every 1s. Emits `state` on change. Single-owner request routing (answers `/health` itself, delegates everything else to engine.io). Swallows uncaught exceptions (a telemetry relay must stay alive) |
| `package.json` | `loop-ws-service` v1.0.0, ESM, `bun --hot index.ts`. Deps: `socket.io` ^4.7.5 |
| `start-service.sh` | Daemon launcher — `setsid nohup bun --hot index.ts >> service.log 2>&1` |

### `proxy/`

| File | Purpose |
|---|---|
| `index.ts` | Gemini geo-bypass proxy (single-file Bun server). Validates `?key=<secret>` against `PROXY_SECRET` (constant-time). Swaps for `GEMINI_API_KEY`. Forwards only `/v1beta/` and `/v1/`. 120s upstream timeout. Key-leak scrub in error logs |
| `package.json` | `loop-gemini-proxy` v1.0.0, ESM. Zero npm deps (Bun's built-in fetch + Bun.serve) |
| `fly.toml` | Fly.io config. `primary_region = "sgp"`. `shared-cpu-1x 256mb`. `min_machines_running = 1` |
| `Dockerfile` | Bun base image `oven/bun:1.3`. Copies only `index.ts` (no install — zero deps) |
| `README.md` | Proxy usage docs |

### `scripts/`

| File | Purpose |
|---|---|
| `check-llm.ts` | One-off — prints whether the LlmConfig singleton row exists and what model/key it has |
| `push-now.ts` | Manual push helper — calls `pushCurrentState({ message: "Manual push: current live state" })` |
| `q.ts` | DB inspection — pending SelfTask counts by kind/priority/deferred |
| `test-claim.ts` | DB inspection — simulates `claimNextTask` and prints the winner |
| `test-models.ts` | LLM smoke test — calls z-ai-web-dev-sdk for 10 models and prints OK/FAIL |
| `record-uuid-postmortem.ts` (130) | One-off — records the postmortem for the bare-UUID commit `e5d2b7a` (host restore orchestrator, not LOOP). Idempotent |
| `audit-remote.ts` (135) | Security audit — uses sealed vault PAT to check remote visibility, list branches, scan for credential paths. Prints only findings, never the token |
| `dev-daemon.py` | Python double-fork daemonizer for the Next.js dev server. `start`/`status`/`stop` subcommands |

### `tests/`

| File | Purpose |
|---|---|
| `python-runtime-build.sh` | Tests the Python runtime build pipeline (references `.zscripts/` paths) |
| `python-runtime-container.sh` | Tests the Python artifact in a Docker container |
| `database-runtime-build.sh` | Tests DB init/preview-data behavior (uses a fake `bun` on PATH) |

### `build-guide/` (the LOOP-Build-Record.pdf derivation pipeline)

| File | Purpose |
|---|---|
| `README.md` | Documents the derivation pipeline: `extractor.py` → `data.json` → `charts.py` → `cover.html` → `cover.pdf` → `generate.py` → `body.pdf` → merge → final PDF |
| `extractor.py` (293) | Derives `data.json` from git ls-files + git log + worklog.md + postmortems/ + dev.log + screenshots/ |
| `charts.py` (125) | Renders 3 figures (anatomy donut, growth curve, mutations-by-file) into `build-guide/charts/` with matplotlib (Agg, cascade palette) |
| `generate.py` (691) | Assembles body PDF via ReportLab (TocDocTemplate + multiBuild, FreeSerif/DejaVu, cascade palette, orphan rules). Merges cover.pdf → `LOOP-Build-Record.pdf` |
| `content_ch1_4.py` (276) | Chapters 1–4 narrative (What LOOP Is, The Dashboard, The Loop, The Gates) |
| `content_ch5_6.py` (179) | Chapters 5 (The Failure Catalog) + 6 (Design Decisions) |
| `content_ch7_8.py` (105) | Chapters 7 (Operator's Manual) + 8 (Audit Discipline) |
| `data.json` (12228 lines) | The derived build-record data (file inventory buckets, per-file metadata, commit history, mutation stats, postmortem counts) |
| `cover.html` | HTML cover template (rendered via html2poster.js) |
| `cover.pdf`, `body.pdf` | Binary PDF artifacts |
| `charts/fig{1,2,3}-*.png` | Binary chart artifacts |
| `capture/0{1,2,3}-*.png` | Binary capture artifacts |

### `docs/`

| File | Purpose |
|---|---|
| `CONCEPTS-GRAFTED.md` | Intellectual lineage — concepts mined from the operator's public GitHub (`craighckby-stack`, 8 repos). GRAFT 1 (Git-Secret-PII-Sanitizer-2 → secret-scan), GRAFT 2 (PKM → duress + read-back), GRAFT 3 (Aether_Forge Ω darlekRAG → ancestral-rag), GRAFT 4 (Aether_Forge aetherforge-eval → red-team suite) |
| `HOT-SWAP.md` | Explains the hot-swap mechanism (Turbopack's separate module registry, globalThis-pin-clearing, async completion on next API request) |
| `screenshots/01-splash-post.png` ... `09-defense.png` | Binary screenshots referenced by this README |

### `memory/`

| File | Purpose |
|---|---|
| `memory/lessons.md` | D6 — human-auditable, DB-independent mirror of the Lesson table. Written by `lessons-markdown.ts` after every distillation pass. Human-editable (the distiller sees your edits and won't re-derive a contradicting rule) |

### `postmortems/` (105 JSON files + 1 archaeology report)

Tamper-evident disk mirror of the Postmortem table. Each JSON has `targetRepo`, `branch`, `filePath`, `status`, `verificationStatus`, `failureType`, `symptom`, `evidence`, `constraints`, `attempts`, `parentHash`, `hash` (sha256 chain), timestamps, `schema` (1 or 2).

- `postmortems/archaeology-report.json` — latest archaeology run's fragility/stability report
- `postmortems/craighckby-stack__V1/main/` (75 files) — mirrors the V1 repo's file tree (every `src/app/api/**`, `src/lib/pipeline/**`, `src/components/**`, `build-guide/*.py`, `scripts/*.ts`, `mini-services`, `proxy`)
- `postmortems/self/main/` (18 files) — the self-referential scar log: 7 `red-team:rt-*` (suite runs), 4 `system:*` (commit-message-guard, duress, hot-swap, push-divergence), 7 per-file scars (`src/app/display/console-stream`, `src/lib/pipeline/api/github-helpers`, `src/lib/pipeline/autonomous/{dreamer,reflection}`, `src/components/pipeline/{debate-chamber,memory-bank,log-stream}`)

### `screenshots/` (44 PNG files)

Binary dashboard captures — dashboard states, the loop running, gate escalations, cooldowns, mobile viewports, audit dashboards. Not referenced by this README (the `docs/screenshots/` set is used instead).

### `examples/`

| File | Purpose |
|---|---|
| `examples/websocket/frontend.tsx` | Reference: how the frontend connects to a WS mini-service via `io("/?XTransformPort={Port}")` |
| `examples/websocket/server.ts` | Reference: the WS mini-service server counterpart |

### `download/`

| File | Purpose |
|---|---|
| `download/README.md` | Explains the `download/` folder (for generated artifacts) |
| `download/architecture-helper-pipeline.zip` | Generated zip (not source) |

### `test-repo/src/` (5 files)

A tiny reference repo (`logger.ts`, `cart.ts`, `config.ts`, `strings.ts`, `arrays.ts`) used for testing the loop's scan/AST/refactor pipeline against an external target without touching the main project.

---

## Security posture

Credentials never live in tracked files. The GitHub PAT is sealed at rest with AES-256-GCM (`enc:v1:` envelope, `crypto/token-vault.ts`); the vault key, the sealed token, the armed intent, the crash budget, and the operator-touch timestamp all live in `.git/info/` — inside the git directory itself, structurally invisible to `git add`, never tracked, never pushed.

Before making this repo public, a full sweep was run:

- **The real PAT**: searched every commit on every branch — zero occurrences.
- **Token-shaped literals**: all tracked files pattern-scanned (GitHub PAT, Google/OpenAI/Anthropic/AWS/Slack keys, private key blocks, vault envelopes) — zero real credentials. The one historical `ghp_`-shaped dummy inside the red-team attack suite was replaced with a runtime-constructed value so even secret scanners come back clean.
- **`.env` history**: ever-committed `.env` files contain only a local SQLite `DATABASE_URL` (a file path, not a credential); `.env` is gitignored.
- **Mutating API routes**: optionally gated by `LOOP_API_KEY` (middleware, fail-open only while unset).

---

## Quick start

```bash
bun install
bun run db:push
bun run dev

# In another terminal — the real-time stream mini-service
cd mini-services/loop-ws-service && bun run dev
```

Open the preview panel. The boot splash fetches its own vitals, stamps the 15 POST lines, and addresses you with `[ ▶ ENTER THE LOOP ]`. Press ENTER. Type `start`. Watch it work.

To configure the push target (so mutations land on GitHub), type `config` or click `[CONFIG]` and paste a classic PAT (repo scope) + `owner/repo`. The PAT is sealed at rest with AES-256-GCM the moment it lands; subsequent boots auto-connect (the server opens the vault and asks GitHub `GET /user` with zero operator input).

### Optional: API key gate

Set `LOOP_API_KEY` in `.env` to lock down mutating API routes (POST/PUT/PATCH/DELETE). The middleware gates every mutating request against the `x-loop-key` header; GET/HEAD/OPTIONS pass through untouched. When unset, the gate fails open (with a one-time console warning). Enter the key in the UI unlock panel (bottom-right) when a mutation 401s; it's stored in `localStorage` and attached to every mutating fetch.

### Optional: Gemini direct

Paste a Gemini API key via the `[CONFIG]` modal (or `POST /api/self-enhance/llm-config`). The key is stored in the `LlmConfig` singleton row (DB, never returned to the client). Optionally deploy the `proxy/` to Fly.io for geo-bypass and set `GEMINI_PROXY_BASE_URL`.

---

## Honest limitations

- **The LLM has to be reachable.** When it returns 429s, the loop backs off honestly — each retry fires a log line. If the endpoint is hard-down, every cycle completes structurally (scan → attempt → fail → next) but produces zero mutations.
- **The first attempt at any file is the dumbest.** The postmortem is written only after the first failure. Every subsequent attempt is informed.
- **The compounding is real but bounded.** The Lesson system adds measured transfer (general rules that raise the pass rate across files, with a score that proves it) — but it compounds prompt-context quality, not capability. The ceiling is the LLM; the lessons just stop you paying for the same mistake twice.
- **The intelligence is outsourced.** The LLM does the generation; the system's actual cleverness is in the gating. The system is a well-built scaffold around an LLM that proposes diffs.
- **The postmortem chain is the system vouching for itself.** "Verified" means the LLM checked its own work and the validator passed — not external verification. Same with the Oracle: it predicts its own operational outcomes, which is a neat closed loop but self-referential.
- **Push target has to be configured to see branches on GitHub.** Without a configured PAT + repo, the loop falls back to commit-only (local commits, no `loop-NN` branches on a remote).

---

## License

MIT. The system rewrites itself; you own what it produces.
