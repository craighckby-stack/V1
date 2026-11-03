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

## The Turbopack reality

The first implementation tried `delete require.cache` + re-import. It
**failed** because Next.js dev mode uses Turbopack, which has its OWN
module registry separate from Node's `require.cache`. A
`createRequire().cache` enumeration returned zero pipeline modules —
they're not in Node's cache, they're in Turbopack's.

So this implementation takes a different approach that works WITH
Turbopack instead of against it.

## The mechanism

`hotSwapPipeline()` (in `src/lib/pipeline/core/hot-swap.ts`) does a
controlled, between-cycles swap:

```
   ┌─────────────────────────────────────────────────────────────┐
   │  1. SNAPSHOT — capture the old instance's config + stats +   │
   │     committed/failed-path sets via the globalThis pin.        │
   │  2. PAUSE — stop the old instance's timer (no cycle starts  │
   │     mid-swap).                                               │
   │  3. CLEAR PINS — delete the globalThis singletons            │
   │     (__autonomousLoopRuntime, __selfEnhanceLoop,             │
   │     __oracleEvents, __oracleScheduler) so the next import    │
   │     creates fresh instances.                                 │
   │  4. STASH SNAPSHOT — write the snapshot to a well-known      │
   │     globalThis slot (__loopHotSwapSnapshot) so the new      │
   │     constructor can restore it.                              │
   │  5. (async) The next API request re-evaluates the route      │
   │     handler, imports loop-runtime fresh (Turbopack serves   │
   │     the recompiled code), the constructor sees no pin,       │
   │     creates a fresh instance, consumes + restores the        │
   │     snapshot, and auto-arms.                                 │
   └─────────────────────────────────────────────────────────────┘
```

There's no synchronous "step 5" — the swap COMPLETES asynchronously on
the next API request. The swap result reports `pending: true`. The
UI shows the swap count tick up when the next cycle runs (within ~2s,
since the page polls every 2s).

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

This pattern survives Turbopack's module reload — re-importing the
module returns the OLD instance because the global pin short-circuits
the constructor. So a swap that only relies on Turbopack's reload is a
no-op. The swap MUST also clear the global pins for the re-import to
actually create a fresh instance.

### The static auto-arm guard

When the pin is cleared, Turbopack may create several fresh instances
before one re-pins itself (each API request that imports loop-runtime
creates a new instance until the pin is re-set). Without a guard, each
would schedule its own 2s `setTimeout` and they'd arm multiple timers
— multiple cycles running in parallel, which is chaos.

The `AutonomousLoopRuntime.autoArmFired` static flag ensures only ONE
auto-arm fires per process boot, no matter how many instances are
transiently created. The flag is reset to `false` when a snapshot is
consumed (i.e. a swap happened), so the new instance can arm.

## When it runs

The swap fires:
- **Automatically** — `self-enhance-loop.ts` calls `hotSwapPipeline()`
  after a verified enhancement to a file under `src/lib/pipeline/` is
  committed + pushed. Between cycles, never during one.
- **Manually** — `POST /api/hot-swap/trigger` lets the operator force a
  swap (e.g. after editing a pipeline file by hand). Supports `dryRun`
  to preview the swap without executing it.

## What it doesn't swap

- The Next.js dev server itself.
- `@/lib/db` (Prisma client — re-instantiating mid-flight drops
  connection pools and breaks in-flight queries).
- Files outside `src/lib/pipeline/`.

The loop can still IMPROVE those files; it just can't hot-swap them.
An improvement to `src/app/page.tsx` is committed + pushed, and
Next.js HMR picks it up on the next request. An improvement to a
pipeline module is committed + pushed AND hot-swapped.

## Protection

`src/lib/pipeline/core/hot-swap.ts` is on the `PROTECTED_FILES` list.
The loop can't easily rewrite its own swapper — a bad mutation that
broke the swap mechanism would leave the running process unable to
benefit from future fixes. (PKM principle: protect the executioner.)

## Observability

- `GET /api/hot-swap/status` — swap count, running pipeline
  fingerprint, ring buffer of the last 25 swap results.
- The autonomous loop logs each swap.
- The UI shows a `⟳N` indicator next to [START] with the swap count.

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
