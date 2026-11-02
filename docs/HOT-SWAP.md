# Hot-Swap Architecture — how LOOP replaces its own running code

> *"A self-improving system that has to be manually restarted to benefit
> from its own improvements isn't autonomous. It's a demo."*

This document explains how LOOP swaps its own running pipeline code
into the live Node process between cycles, without restarting the
server. This is the mechanism that makes the system **fully
autonomous** — a verified improvement to a pipeline module is
committed, pushed, AND loaded into the running process so the very
next cycle uses it.

---

## The problem

LOOP improves its own source files. When the loop improves, say,
`src/lib/pipeline/postmortem/postmortem-store.ts`, the new code is on
disk and on GitHub. But a running Node process holds references to the
modules it imported at boot. The running process is STILL using the
old `postmortemStore` singleton from `require.cache`.

Without a swap, the improvement is academic — it lives on GitHub but
the live system doesn't benefit from it until a manual restart. That
defeats the point of an autonomous self-improving system.

## The mechanism

`hotSwapPipeline()` (in `src/lib/pipeline/core/hot-swap.ts`) does a
controlled, between-cycles swap:

```
   ┌─────────────────────────────────────────────────────────────┐
   │  1. PAUSE — stop the running loop's timer (no cycle starts  │
   │     mid-swap). Set a re-entry guard.                        │
   │  2. SNAPSHOT — capture the loop's config + stats so the     │
   │     new instance resumes where the old one left off.        │
   │  3. INVALIDATE — delete require.cache for every module under │
   │     src/lib/pipeline/. Free the entire pipeline subtree.    │
   │  4. CLEAR GLOBALS — the singletons (autonomousLoopRuntime,  │
   │     selfEnhanceLoop, oracleEvents, oracleScheduler) are     │
   │     pinned on globalThis so they survive delete require.    │
   │     cache. We MUST clear those pins or step 5 returns the   │
   │     OLD instance.                                          │
   │  5. RE-IMPORT — require() loop-runtime fresh. This creates │
   │     a brand-new AutonomousLoopRuntime singleton wired to    │
   │     freshly-imported pipeline modules (which now carry the  │
   │     improved code).                                        │
   │  6. RESTORE — copy the snapshot into the new instance so    │
   │     cycle numbering, stats, and config survive the swap.    │
   │  7. RESUME — start the new instance's timer. The next      │
   │     cycle uses the new code.                               │
   └─────────────────────────────────────────────────────────────┘
```

### Why the global pins matter

The loop runtime uses a singleton pattern:

```ts
const globalForLoop = globalThis as unknown as {
  __autonomousLoopRuntime?: AutonomousLoopRuntime;
};
export const autonomousLoopRuntime =
  globalForLoop.__autonomousLoopRuntime ?? new AutonomousLoopRuntime();
if (!globalForLoop.__autonomousLoopRuntime) {
  globalForLoop.__autonomousLoopRuntime = autonomousLoopRuntime;
}
```

This pattern survives `delete require.cache` — re-importing the module
returns the OLD instance because the global pin short-circuits the
constructor. So a swap that only invalidates the cache is a no-op. The
swap MUST also clear the global pins (`__autonomousLoopRuntime`,
`__selfEnhanceLoop`, etc.) for the re-import to actually create a fresh
instance.

### Why we use `createRequire()` not `require()`

Turbopack (Next.js's bundler) statically analyzes `require(...)` calls
and tries to bundle the target. For a hot-swap that re-imports an
absolute file path at runtime, this static analysis fails — Turbopack
can't resolve `/home/z/my-project/src/lib/pipeline/autonomous/loop-runtime.ts`
as a bundlable module.

`createRequire(import.meta.url)` gives us a real Node `require()`
that Turbopack can't see into (it's a runtime value, not a static
call), so the hot-swap can re-import arbitrary paths without breaking
the bundler.

## When it runs

The swap fires:
- **Automatically** — `self-enhance-loop.ts` calls `hotSwapPipeline()`
  after a verified enhancement to a file under `src/lib/pipeline/` is
  committed + pushed. Between cycles, never during one.
- **Manually** — `POST /api/hot-swap/trigger` lets the operator force a
  swap (e.g. after editing a pipeline file by hand). Supports `dryRun`
  to preview the swap without executing it.

## What it doesn't swap

- The Next.js dev server itself (Turbopack handles UI HMR separately).
- `@/lib/db` (Prisma client — re-instantiating mid-flight drops
  connection pools and breaks in-flight queries).
- Files outside `src/lib/pipeline/`.

The loop can still IMPROVE those files; it just can't hot-swap them.
An improvement to `src/app/page.tsx` is committed + pushed, and
Next.js HMR picks it up on the next request. An improvement to a
pipeline module is committed + pushed AND hot-swapped.

## Fallback

If step 5 (RE-IMPORT) throws — the new code is broken on import — the
swap falls back:
- Records a critical postmortem (filePath=`system:hot-swap`,
  failureType=`COMPILE_ERROR`).
- The old instance was stopped in step 1 and the global pin was cleared
  in step 4, so there is no running loop. The postmortem tells the
  operator: fix the broken code on disk, then trigger a manual swap or
  restart the dev server.

The fallback is the "honest degradation" path: the system would rather
halt with a clear postmortem than silently keep running broken code.
A broken-on-import file is rare (the in-memory typecheck + AST gate +
debate tribunal already verified the code before commit) but possible
(a runtime-only error the typecheck can't see, like a missing
dependency).

## Protected

`src/lib/pipeline/core/hot-swap.ts` is on the `PROTECTED_FILES` list.
The loop can't easily rewrite its own swapper — a bad mutation that
broke the swap mechanism would leave the running process unable to
benefit from future fixes. The loop can still improve the swapper's
dependencies; it just can't edit the swapper directly. (PKM principle:
protect the executioner.)

## Observability

- `GET /api/hot-swap/status` — swap count, running pipeline
  fingerprint, ring buffer of the last 25 swap results.
- The autonomous loop logs each swap:
  `[AUTONOMOUS] [SUCCESS] HOT-SWAP: N module(s) reloaded (Xms) — next
  cycle uses the new code`.

## The full autonomous loop

With hot-swap + auto-arm + continuous mode + recovery probe, the
system is genuinely fully autonomous:

1. **Boot** — server starts, the loop's constructor arms the scheduler
   2s later (deferred so duress safe-mode rehydrate settles first).
2. **Cycle** — fetch tree → select files → for each: read, check
   postmortem + ancestral RAG, ask the LLM, verify in-memory, run the
   tribunal, commit + push.
3. **Swap** — after a verified push of a pipeline file, hot-swap the
   module subtree. Next cycle uses the new code.
4. **Recover** — if a cycle crashes, the continuous loop survives
   (defensive try/catch). If safe-mode or governor halts the loop, a
   60s recovery probe re-checks and auto-resumes when conditions clear.
5. **Never stop** — the only ways to permanently stop the loop are:
   operator presses [STOP], safe-mode is raised and never cleared, or
   the process is killed.

No [START] button needed. No manual restart to benefit from
improvements. No human in the loop.
