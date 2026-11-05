# LOOP

> A program that rewrites its own source code, gates every mutation through a real compiler, and pushes the proof to GitHub — one `loop-NN` branch per successful mutation.

![Boot splash — BIOS POST with live vitals](./docs/screenshots/01-splash-post.png)

---

## What this actually is

LOOP is a Next.js app that runs a continuous loop in the background:

1. **Scan** its own source files (the ones it's allowed to touch).
2. **Pick** one file to improve.
3. **Read the postmortems** for that file (if it has failed before) and inject them into the LLM prompt as constraints.
4. **Ask an LLM** to improve the file.
5. **Gate** the result: TypeScript compiler, AST diff (no symbols dropped), sanitizer (no branding stripped), debate tribunal.
6. **Verdict**: pass → commit + push to a fresh `loop-NN` branch, resolve any open postmortems. Fail → revert, write a postmortem, try again next cycle.
7. Goto 1. Forever.

It is not AGI. It is not dangerous. It is a bounded, compiler-gated pipeline that safely applies an LLM's proposed edits to its own source code. The clever part is the gating, not the generation.

---

## What it looks like

### The boot ceremony (cold boot)

The system boots like a 1980s CRT terminal. It fetches its own live vitals from its own APIs while the phosphor warms up, stamps a BIOS-style POST, then addresses you:

| | |
|---|---|
| **POST** — live vitals stamp in one by one | ![POST screen](./docs/screenshots/01-splash-post.png) |
| **Invite** — the machine asks you to enter | ![Invite](./docs/screenshots/02-splash-invite.png) |

The POST is honest: any vital it can't read stamps `[ ?? ]` in amber. It never fakes an `OK`. Press ENTER and you're in the terminal — splash → system, nothing in between.

### The 15 POST lines (cold boot)

The cold-boot POST stamps 15 checks in order. The first 8 are the original machine vitals; the last 7 are the boot/scan group — appended after the sealed-PAT vault landed, so every entry reports the live machine state:

| # | Line | What it reports |
|---|---|---|
| 1 | CHECKING OBSERVER | HUMAN AT TERMINAL 0 |
| 2 | MUTATION LEDGER | `N ON REMOTE · NEXT loop-NN` (from `/api/branches`) |
| 3 | POSTMORTEM CHAIN | `N VERIFIED · 0 BROKEN` (chain integrity) |
| 4 | PROPHECY ENGINE | `N SEEDED · N PENDING` |
| 5 | LLM CORTEX | `READY` or `THROTTLED — SEE API QUOTA LINE` |
| 6 | HOT-SWAP BAY | swaps this boot |
| 7 | UPLINK | the configured `owner/repo` |
| 8 | CYCLE COUNTER | `N COMPLETED` |
| 9 | **Z.AI CORTEX** | the auto-injected provider connection — `AUTO-INJECTED · VERIFIED (Nms PING)`. The SDK handshake + one-shot ping happens at **SERVER BOOT** (the Next.js instrumentation hook fires `warmZaiCortex()` before the first HTTP request), so the splash reads a connection that already exists, not one it has to wait for. |
| 10 | **API QUOTA** | the shared 429 gate. When the gate is active: `THROTTLED L{1-4} — QUOTA READY IN MM:SS` with a **live countdown** ticking every second against a client-anchored end time. When open: `AVAILABLE — NO 429 GATE ON FILE`. |
| 11 | **GITHUB AUTH** | the sealed PAT auto-connect — `AUTHENTICATED AS <login>`. The server opens the sealed token from the vault (zero operator input) and asks GitHub `GET /user`. |
| 12 | **TOKEN VAULT** | `AES-256-GCM · SEALED AT REST` (or `PLAINTEXT — KEY MISSING` if the vault key isn't seeded). |
| 13 | **MUTATION TOTALS** | `N SUCCEEDED · N FAILED` — succeeded from the branch ledger, failed from the wipe-proof disk scar count. |
| 14 | **HOT-SWAP LOG** | `N LIFETIME · M THIS BOOT` — the lifetime counter is **wipe-proof**: a disk journal in `.git/info/` is the source of truth, the DB is a mirror. A sandbox DB rollback can't erase it. |
| 15 | **AUTONOMY** | the live loop's derived phase — `LIVE — SELF-DRIVEN` / `ARMED — THROTTLED — QUOTA READY IN MM:SS` / `ARMED — RECOVERING — RESUME IN MM:SS` / `ARMED — PAUSED — MANUAL [START] REQUIRED` / `DISARMED — PRESS [START]` (see the auto-run state machine below). |

### Warm boot shows the same vitals

Warm boots (already entered this browser session) used to show one `SESSION RESUMED` line and nothing else — every reload read as "not updated". Now the warm POST appends the **same 7 boot/scan lines** after the SESSION RESUMED line. One definition, two ceremonies, same bytes on every entry — the live machine state is never a cold-boot-only show. Force the full cold POST with `?boot=force`.

### The terminal

After the splash, you get the actual interface:

![Terminal](./docs/screenshots/05-terminal.png)

Black background, white text, red only when something breaks. The header: `LOOP ●` (heartbeat), `[START]`, `[CLEAR]`, `[CONFIG]`, `[ORACLE]`, `[DEFENSE]`, `[BRANCHES]`.

Type commands:
- `start` — kick off the loop. Renders a live activity snapshot, then the stream takes over.
- `stop` — halt.
- `status` — current snapshot, including the next branch number.
- `about` — the elevator pitch.
- `clear` — wipe the console.
- `config` — open the git config modal.

A live stream scrolls in real time: every scan, gate, push, retry, and backoff appears as it happens. Even when the LLM is rate-limiting and a single call takes ~150s of retries, you see each retry fire — no silent gaps.

### The panels

| | | |
|---|---|---|
| **Branches** — every `loop-NN` branch is one successful mutation pushed to GitHub, with a link to the commit | ![Branches](./docs/screenshots/06-branches.png) |
| **Oracle** — the system predicts its own operational future and grades the answers | ![Oracle](./docs/screenshots/07-oracle.png) |
| **Config** — push target (token, repo, visibility, auto-create) | ![Config](./docs/screenshots/08-config.png) |
| **Defense** — duress, red-team, secret-scan concepts grafted from external repos | ![Defense](./docs/screenshots/09-defense.png) |

---

## The two safety mechanisms

A system that rewrites its own code is dangerous — what stops it from "improving" away its own OFF switch?

### 1. The Ratchet — tests only get stricter

Every time the loop commits an improvement to a file, it also writes **characterization tests** that pin the behaviour of that file. These tests are **write-once** — once pinned, they cannot be loosened. The system's behaviour gets increasingly locked while its implementation gets increasingly clean. It can't weaken its own pins to escape its own standards.

### 2. The Postmortem — failures only get safer

When an attempt fails, the system writes a postmortem against that exact file path: what broke (`failureType`), the evidence (machine-copied facts), and a constraint the LLM must obey next time. The next time the loop picks that file, it pulls the postmortem and injects it into the prompt:

```
--- POSTMORTEM CONSTRAINTS (this file failed 2 time(s) before) ---
FAILURE TYPE: AST_SYMBOL_DROPPED
SYMPTOM: function `parseHeader` was deleted from the output
DO NOT: remove any exported symbols; refactor in place only.
```

If the AI tries the same dumb refactor again, the gate catches it again, the `attempts` counter ticks, the constraint gets sharper. When it finally succeeds, the postmortem is marked `resolved`. The loop gets wiser about its own codebase as it runs.

---

## The branch model

Each successful enhancement pushes to its own git branch:

```
loop-01  ← first full mutation
  └─ loop-02  ← second, built on loop-01's tip
       └─ loop-03 ← third
            └─ ...loop-108 (current)
```

- **Each branch = one successful mutation.** Failed attempts don't get a branch — they go to the postmortem DB. So `loop-NN` counts wins only.
- **Git-native rollback.** `git checkout loop-37` gives you the pre-bad state. One command.
- **Git-native diff.** `git diff loop-37..loop-38` shows exactly what one cycle did: one file, one enhancement, its test pin. That's the audit trail, for free.
- **The branch list IS the changelog.**

---

## The boundary — what it can and can't touch

| Layer | Mutable? |
|---|---|
| **The brain** — loop runtime, event bus, push auth, typecheck, AST gate, sanitizer, debate tribunal, LLM callers, task generator | 🔒 Never. Permanently protected. |
| **The body** — pipeline stages, helpers, the display layer | ✏️ Yes. This is the mutation scope. |
| **The control surface** — `page.tsx`, `layout.tsx` (your STOP/START/CONFIG buttons, command input, config modal) | 🔒 Never. You always have the kill switch. |
| **Everything else** — UI components, API routes, Prisma schema | 🔒 Outside the loop's awareness. |

The system can change **how** things look. It can **never** change **what you control**. If it could rewrite its own control surface, it could remove the STOP button — this is structurally impossible.

---

## Current state (factual)

As of this README:

- **108 mutation branches** on GitHub (`loop-01` through `loop-108`), next will be `loop-109`.
- **90 postmortems** in the chain, **0 broken links** (every postmortem traces to a real commit). **91 scar files** on disk — the wipe-proof failure record that survives sandbox DB rollbacks.
- **188 files in mutation scope** — pipeline logic, UI components, API routes, and the Prisma schema (see below).
- The repo (`craighckby-stack/V1`) is **public** — commit links in the BRANCHES dialog resolve for anyone.
- **Z.ai cortex auto-injects at server boot.** The Next.js instrumentation hook (`src/instrumentation.ts`) fires `warmZaiCortex()` before the first HTTP request: `ZAI.create()` (the SDK handshake, cached in a shared globalThis slot — the SAME instance every LLM call reuses) + a one-shot 4-token ping. The splash's Z.AI CORTEX line reads a connection that already exists, not one it has to wait for.
- **The loop runs by itself when the quota allows.** When the shared 429 gate is active, the loop auto-pauses (stop is still honored within 1s) and the API QUOTA line counts down to the gate opening. When the gate clears, the loop auto-resumes — no operator input. The gate escalates 2min → 5min → 15min → 30min on consecutive 429s; one successful call de-escalates.
- **Hot-swap lifetime is wipe-proof.** A disk journal in `.git/info/` is the source of truth; the DB is a mirror. A sandbox DB rollback can't erase the lifetime count.

The system is currently running against a free-tier LLM API, which rate-limits frequently. When it does, the loop backs off honestly — each retry fires a log line in real time, the API QUOTA line counts down, and the loop auto-resumes the moment the gate opens. No fake progress.

---

## Compounding intelligence — the Lesson system

Postmortems are per-file and reactive: a scar log. Knowing `halt.ts` hates function removal doesn't help when the loop picks `sanitizer.ts`. **Lessons** are the transfer layer — general rules distilled from AGGREGATE history that inject into EVERY enhance prompt:

```
--- LEARNED LESSONS (general rules this system distilled from its own history) ---
1. Never remove error-handling branches or empty catch blocks without
   replacing them with equal-or-better handling — the debate tribunal
   rejects 'simplification' of error paths...
--- END LEARNED LESSONS ---
```

The loop is **distill → inject → measure → prune**:

1. **Distill** — every 10 cycles, one LLM pass over aggregate failure patterns (failure-type counts, most-attempted files, recent successes) extracts up to 3 general rules. Deduped against existing lessons, including PRUNED ones (a rule that already failed to transfer isn't re-derived).
2. **Inject** — top 5 lessons by trust score go into every prompt. Global, not per-file. A lesson from pipeline failures shapes a UI component mutation.
3. **Measure** — every mutation verdict feeds back: pass → `helped++`, fail → `hindered++` for exactly the lessons that were injected.
4. **Prune** — score = helped/(helped+hindered). Below 0.35 after ≥4 observations → deactivated. The lesson didn't transfer; it stops costing prompt tokens.

This is meta-learning with a real feedback signal: the system learns WHICH of its own lessons actually raise the pass rate, keeps only those, and the score proves it. That's what compounds — each surviving lesson makes future mutations more likely to succeed, measurably.

---

## The auto-run state machine

"Runs by itself" is a state machine, not a boolean. The loop's live phase is a derived value — a pure function of the armed intent, the scheduler state, the LLM quota gate, and two safety walls — and the splash's AUTONOMY line reports it honestly on every boot:

```
DISARMED → [START] → ARMED-RUNNING
ARMED-RUNNING → quota halt → ARMED-THROTTLED
ARMED-THROTTLED → quota reset → ARMED-RECOVERING (30s settle)
ARMED-RECOVERING → timer → ARMED-RUNNING / [PAUSE] → ARMED-PAUSED
ARMED-PAUSED (sticky, only manual [START] releases it)
```

| Phase | Meaning | Operator action |
|---|---|---|
| `DISARMED` | Loop off. | Press [START] to arm. |
| `ARMED-RUNNING` | A cycle is in flight, gate open. | None — watch it work. |
| `ARMED-THROTTLED` | 429 gate active; the loop auto-pauses. STOP still works within 1s. | None — the AUTONOMY line counts down to resume. |
| `ARMED-RECOVERING` | The gate just cleared; a 30s settle window runs before the next cycle (avoids the immediate re-429 of firing the instant the gate opens). | None — live countdown shown. |
| `ARMED-PAUSED` | Stopped: operator [STOP], the crash-wall, or the dead-man's switch. | **Manual [START] required** — nothing auto-resumes from here. |

### The stop-priority hierarchy (top wins)

1. **Operator [STOP]** — sticky forever: written to the wipe-proof armed-state tier; no boot, probe, or quota event re-arms after a human stop.
2. **Crash-wall** — 3 consecutive cycles throwing the SAME error class → the loop trips the wall, disarms, and persists `crashWall:true` to `.git/info/loop-crash-budget.json` so a segfault that kills the process can't silently reset the count and re-arm into the same crash loop. Different error classes reset the count (a network blip followed by a segfault is two problems, not a pattern). A clean cycle resets the budget.
3. **Dead-man's switch** — if the operator hasn't touched the system in >24h ([START]/[STOP]/config PATCH all count as touches, recorded in `.git/info/loop-operator-touch.json`), auto-arm is denied and the loop reports ARMED-PAUSED. The operator must check in at least once a day for the autonomy to keep running — a runaway loop can't quietly burn quota for days while nobody watches.
4. **Quota gate** — the only stop that AUTO-RECOVERS: throttle → 30s settle → resume, escalating 2/5/15/30min on consecutive 429s.

**Quota ≠ budget.** The quota gate is the provider's permission — it auto-resumes. A budget (hard spend cap) would be the operator's money — that would require manual re-arm. Only the quota auto-recovers; everything else is sticky by design.

---

## Security posture

Credentials never live in tracked files. The GitHub PAT is sealed at rest with AES-256-GCM (`enc:v1:` envelope); the vault key, the sealed token, the armed intent, the crash budget, and the operator-touch timestamp all live in `.git/info/` — inside the git directory itself, structurally invisible to `git add`, never tracked, never pushed. Before making this repo public, a full sweep was run:

- **The real PAT**: searched every commit on every branch (local history + remote tree) — zero occurrences.
- **Token-shaped literals**: all 596 tracked files pattern-scanned (GitHub PAT, Google/OpenAI/Anthropic/AWS/Slack keys, private key blocks, vault envelopes) — zero real credentials. The one historical `ghp_`-shaped string (an all-same-character dummy inside the red-team attack suite) was replaced with a runtime-constructed value so even secret scanners come back clean.
- **`.env` history**: ever-committed `.env` files contain only a local SQLite `DATABASE_URL` (a file path, not a credential); `.env` was untracked long ago and is gitignored now.
- **Mutating API routes**: optionally gated by `LOOP_API_KEY` (middleware, fail-open only while unset — see Quick start).

---

## Use it on z.ai

LOOP was built and runs as a [z.ai](https://z.ai) Code project — the repo you're reading is its source of truth:

- **Repo**: [github.com/craighckby-stack/V1](https://github.com/craighckby-stack/V1) — every `loop-NN` branch is one compiler-verified self-mutation, publicly auditable.
- **Live instance**: the machine runs in a z.ai Code sandbox. Open the project in z.ai Code and the terminal is right there in the preview panel — boot splash, POST diagnostics, and the [ ▶ ENTER THE LOOP ] invite.
- **Try it yourself**: clone the repo, `bun install && bun run db:push && bun run dev`, open the preview, type `start`. Configure a classic PAT with repo scope in [CONFIG] to watch it push its own mutations to your GitHub.

The first [START] is the only manual step. After that it arms itself, runs whenever the quota allows, throttles and recovers on its own, and stops for a human when the walls trip.

---

## The mutation scope — 188 files

| Scope | Files | Gate chain |
|---|---|---|
| Pipeline logic (`src/lib/pipeline/`) | 65 | ratchet pin → tsc + AST → debate → sandboxed test gate |
| Display layer (`src/app/display/`) | 1 | same |
| UI components (`src/components/`) | 64 | same |
| API routes (`src/app/api/`) | 57 | same |
| Prisma schema (`prisma/schema.prisma`) | 1 | **additive-only gate** (see below) |

Everything the system IS lives inside its own reach: the loop can enhance the components that render it, the routes that serve it, and (additively) the database that remembers for it. Churn is bounded by the saturation lockout — 3 no-growth cycles per file and it locks out until the operator unlocks it.

### The additive-only schema gate

The most dangerous thing the loop could touch is its own memory substrate. A bad schema change can destroy the postmortem DB. So schema mutations pass through the strictest gate in the pipeline:

- **Allowed**: new model blocks; new nullable/`@default()` fields on non-protected models (existing rows backfill).
- **Rejected**: any removal, rename, or type change; ANY edit to the protected memory models (Postmortem, Lesson, GitPushTarget, LlmConfig, Prophecy, SystemFlag).
- **Chain**: structural diff check → `prisma validate` → `db push` → canary round-trip (a fresh child process reads the memory tables through the regenerated client). Any step failing → the original schema is restored and re-pushed. The loop can GROW its memory but never EDIT or FORGET it.

### What stays protected

The loop's own brain (gate chain, loop runtime, push auth, LLM wrappers, the lesson store, the schema gate, the protection list itself), the UI control surface (`page.tsx` — your STOP button), the control API subtree (`api/self-enhance/**` — the backend of the kill switch), the health probe, and `src/lib/db.ts`. A self-improving system must not be able to rewrite its own OFF switch, its own judges, or its own memory.

---

## Tech stack

- **Next.js 16** (App Router, Turbopack) + **TypeScript 5**
- **Tailwind CSS 4** + **shadcn/ui** (New York)
- **Prisma ORM** + SQLite
- **Socket.io** for the real-time activity stream (mini-service on port 3003)
- **TypeScript Compiler API** for the AST diff gate
- **z-ai-web-dev-sdk** for LLM calls (server-side only) — auto-injected at **server boot** via the Next.js instrumentation hook, so the provider connection exists before the first request
- **Web Audio API** for the synthesized boot soundtrack (no audio assets — all oscillators)

---

## Quick start

```bash
bun install
bun run db:push
bun run dev

# In another terminal — the real-time stream mini-service
cd mini-services/loop-ws-service && bun run dev
```

Open the preview panel. Type `start`. Watch it work.

To configure the push target (so mutations land on GitHub), type `config` or click `[CONFIG]` and paste a classic PAT (repo scope) + `owner/repo`. The PAT is sealed at rest with AES-256-GCM the moment it lands; subsequent boots auto-connect (the server opens the vault and asks GitHub `GET /user` with zero operator input).

### Optional: API key gate

Set `LOOP_API_KEY` in `.env` to lock down mutating API routes (POST/PUT/PATCH/DELETE). The middleware (`src/middleware.ts`) gates every mutating request against the `x-loop-key` header; GET/HEAD/OPTIONS pass through untouched so polling and health checks keep working. When unset, the gate **fails open** (with a one-time console warning) so the system stays bootable — and the UI's bottom-right `API KEY NOT SET — MUTATIONS LOCKED` hint only renders when the server confirms it's actually configured to gate. Enter the key in the UI unlock panel (bottom-right) when a mutation 401s; it's stored in `localStorage` and attached to every mutating fetch from then on.

---

## Honest limitations

- **The LLM has to be reachable.** The loop depends on an external LLM endpoint. When it returns 429s, the loop backs off honestly — each retry fires a log line. If the endpoint is hard-down, every cycle completes structurally (scan → attempt → fail → next) but produces zero mutations.
- **The first attempt at any file is the dumbest.** The postmortem is written only after the first failure. Every subsequent attempt is informed.
- **The compounding is real but bounded.** The Lesson system adds measured transfer (general rules that raise the pass rate across files, with a score that proves it) — but it compounds prompt-context quality, not capability. The system gets better at making mutations that PASS; it does not get better at understanding code beyond what the LLM already understood. The ceiling is the LLM; the lessons just stop you paying for the same mistake twice.
- **The intelligence is outsourced.** The LLM does the generation; the system's actual cleverness is in the gating — TypeScript compiler, structural validator, postmortem chain, push pipeline. The system is a well-built scaffold around an LLM that proposes diffs.
- **The postmortem chain is the system vouching for itself.** "Verified" means the LLM checked its own work and the validator passed — not external verification. Same with the Oracle: it predicts its own operational outcomes, which is a neat closed loop but self-referential, not external-world modeling.
- **Push target has to be configured to see branches on GitHub.** Without a configured PAT + repo, the loop falls back to commit-only (local commits, no `loop-NN` branches on a remote).

---

## What this is not

- Not AGI. Not conscious. Not dangerous. Not a demo that stops when you stop watching.
- Not a parlour trick either — it's a real, running, bounded autonomous self-mutation experiment that has produced 108 compiler-verified patches to its own source code and pushed them to a public git history you can audit right now.

The engineering is in the gating, the persistence (3-tier state survival across sandbox restarts), and the boundary (the loop can't rewrite its own OFF switch). That's the craft. The LLM is the easy part.

---

## License

MIT. The system rewrites itself; you own what it produces.
