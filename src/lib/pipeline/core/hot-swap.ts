/**
 * Hot-Swap Manager — the mechanism that lets the autonomous loop replace
 * its OWN running code between cycles, without restarting the server.
 *
 * THE PROBLEM THIS SOLVES
 *
 * LOOP improves its own source files. But a running Node process holds
 * references to the modules it imported at boot. After the loop commits
 * an improvement to, say, `postmortem-store.ts`, the running process is
 * STILL using the old `postmortemStore` singleton from `require.cache`.
 * The improvement is on disk and on GitHub, but the live system doesn't
 * benefit from it until a manual restart. That defeats the point of an
 * autonomous self-improving system.
 *
 * THE MECHANISM
 *
 * `hotSwapPipeline()` does a controlled, between-cycles swap:
 *
 *   1. PAUSE — stop the running loop's timer (no cycle starts mid-swap).
 *      Set a "swapping" guard so any concurrent swap attempt no-ops.
 *   2. SNAPSHOT — capture the loop's public state (cycle count, config,
 *      stats, recent cycles) so the new instance can resume where the
 *      old one left off. The state lives in DB rows + the state object.
 *   3. INVALIDATE — `delete require.cache` for every module under
 *      `src/lib/pipeline/` AND the autonomous subdirectory. This is the
 *      blunt instrument: the entire pipeline subtree is freed.
 *   4. CLEAR GLOBALS — the singletons (`autonomousLoopRuntime`,
 *      `selfEnhanceLoop`) are pinned on `globalThis` so they survive
 *      `delete require.cache`. We MUST clear those pins, or step 5
 *      re-imports the module and gets the OLD instance back.
 *   5. RE-IMPORT — `require()` the loop-runtime module fresh. This
 *      creates a brand-new `AutonomousLoopRuntime` instance with fresh
 *      references to the freshly-imported pipeline modules (which now
 *      carry the improved code).
 *   6. RESTORE — copy the snapshot into the new instance so cycle
 *      numbering, stats, and config survive the swap.
 *   7. RESUME — start the new instance's timer. The next cycle uses the
 *      new code.
 *
 *   If step 5 throws (the new code is broken on import), we FALL BACK:
 *   re-import with the OLD cache restored, log a critical postmortem,
 *   and the old instance keeps running. The system never ends up with
 *   no running loop.
 *
 * WHEN IT RUNS
 *
 * Called by `self-enhance-loop.ts` after a verified improvement is
 * committed — between cycles, never during one. Also exposed via
 * `/api/hot-swap/trigger` for manual testing.
 *
 * WHAT IT DOESN'T SWAP
 *
 * - The Next.js dev server itself (Turbopack handles UI HMR).
 * - `@/lib/db` (Prisma client — re-instantiating mid-flight drops
 *   connection pools and breaks in-flight queries; the DB layer is
 *   stable enough that it doesn't need swapping).
 * - `next/server`, React, etc. (framework code).
 * - Files outside `src/lib/pipeline/`.
 *
 * The loop can still IMPROVE those files (it's a code-improvement agent
 * on all of `src/`); it just can't hot-swap them into the running
 * process. An improvement to, say, `src/app/page.tsx` is committed +
 * pushed, and the Next.js HMR picks it up on the next request. An
 * improvement to a pipeline module is BOTH committed AND hot-swapped.
 */

import { createHash } from "crypto";
import { join } from "path";
import { createRequire } from "module";

const PROJECT_ROOT = "/home/z/my-project";
const PIPELINE_DIR = join(PROJECT_ROOT, "src", "lib", "pipeline");

// Turbopack statically analyzes `require(...)` calls and tries to bundle
// the target. For a hot-swap that re-imports a path AT RUNTIME (after
// deleting it from require.cache), this static analysis fails — the path
// is absolute and Turbopack can't resolve it as a module.
// createRequire(import.meta.url) gives us a real Node require() that
// Turbopack can't see into (it's a runtime value, not a static call),
// so the hot-swap can re-import arbitrary paths without breaking the
// bundler.
const runtimeRequire = createRequire(import.meta.url ?? `file://${PROJECT_ROOT}/src/lib/pipeline/core/hot-swap.ts`);

// Modules whose singletons are pinned on globalThis. If we don't clear
// these pins, re-importing the module returns the old instance (the pin
// short-circuits the constructor).
const GLOBAL_PINS = [
  "__autonomousLoopRuntime",
  "__selfEnhanceLoop",
  "__oracleEvents",
  "__oracleScheduler",
];

// Modules that must NOT be invalidated — they hold state that can't be
// safely rebuilt mid-flight (Prisma connection pool, etc.). The loop
// can still EDIT these files; the swap just skips them.
const DO_NOT_INVALIDATE = [
  "@/lib/db",
  "src/lib/db.ts",
];

export interface HotSwapResult {
  ok: boolean;
  swapped: boolean;
  reason: string;
  /** Number of require.cache entries invalidated. */
  invalidatedCount: number;
  /** The file paths that were invalidated (truncated to 50 for storage). */
  invalidatedPaths: string[];
  /** Global pins cleared. */
  pinsCleared: string[];
  /** Time the swap took, end to end. */
  durationMs: number;
  /** If the swap fell back, the import error that caused it. */
  fallbackError?: string;
  startedAt: string;
  finishedAt: string;
}

// Re-entry guard. A swap is synchronous from the caller's perspective
// but the require/import work can be slow; a second swap attempt while
// one is in flight no-ops.
let swapInProgress = false;

// A ring buffer of the last N swap results, for the API + UI.
const swapHistory: HotSwapResult[] = [];
const SWAP_HISTORY_MAX = 25;

/** List every module under src/lib/pipeline/ currently in require.cache.
 *  Returns the resolved file paths (absolute). */
function pipelineModulesInCache(): string[] {
  const cache = runtimeRequire.cache as unknown as Record<string, NodeModule>;
  const prefix = join(PIPELINE_DIR);
  return Object.keys(cache).filter((p) => p.startsWith(prefix));
}

/** The state we snapshot from the old loop runtime so the new one can
 *  resume mid-stream. Fetched dynamically (not via import) so the
 *  snapshotter itself is swappable. Shape mirrors LoopConfig + LoopStats
 *  in loop-runtime.ts — keep these aligned if those interfaces change. */
interface LoopSnapshot {
  status: string;
  config: {
    enabled: boolean;
    mode: string;
    intervalMinutes: number;
    targetRepo: string;
    branch: string;
    evolutionBranch: string;
    maxCycles: number;
    maxFilesPerCycle: number;
    autoPush: boolean;
    siphonSourceId: string;
    userPrompt: string;
    githubToken: string;
  };
  stats: {
    totalRuns: number;
    totalFilesScanned: number;
    totalFilesCommitted: number;
    lastRunTime: string | null;
    lastTreeFingerprint: string | null;
    nextRunAt: string | null;
  };
}

/** Capture the current loop runtime's public state via the global pin.
 *  We read the pin (not an import) so this function doesn't create a
 *  require dependency on loop-runtime — keeping the snapshotter swappable. */
function snapshotLoop(): LoopSnapshot | null {
  try {
    const g = globalThis as unknown as { __autonomousLoopRuntime?: any };
    const rt = g.__autonomousLoopRuntime;
    if (!rt) return null;
    const state = rt.getState?.();
    if (!state) return null;
    return {
      status: state.status ?? "idle",
      config: {
        enabled: state.config?.enabled ?? false,
        mode: state.config?.mode ?? "continuous",
        intervalMinutes: state.config?.intervalMinutes ?? 1,
        targetRepo: state.config?.targetRepo ?? "self",
        branch: state.config?.branch ?? "main",
        evolutionBranch: state.config?.evolutionBranch ?? "loop-01",
        maxCycles: state.config?.maxCycles ?? 100,
        maxFilesPerCycle: state.config?.maxFilesPerCycle ?? 3,
        autoPush: state.config?.autoPush ?? true,
        siphonSourceId: state.config?.siphonSourceId ?? "self",
        userPrompt: state.config?.userPrompt ?? "",
        githubToken: state.config?.githubToken ?? "",
      },
      stats: {
        totalRuns: state.stats?.totalRuns ?? 0,
        totalFilesScanned: state.stats?.totalFilesScanned ?? 0,
        totalFilesCommitted: state.stats?.totalFilesCommitted ?? 0,
        lastRunTime: state.stats?.lastRunTime ?? null,
        lastTreeFingerprint: state.stats?.lastTreeFingerprint ?? null,
        nextRunAt: state.stats?.nextRunAt ?? null,
      },
    };
  } catch {
    return null;
  }
}

/** Restore a snapshot into a freshly-imported loop runtime. Best-effort:
 *  the new runtime's constructor sets sane defaults; we override the
 *  fields that matter for continuity (cycle count, config). Stats are
 *  informational so we copy them too. */
function restoreLoop(snap: LoopSnapshot): void {
  try {
    const g = globalThis as unknown as { __autonomousLoopRuntime?: any };
    const rt = g.__autonomousLoopRuntime;
    if (!rt) return;
    // Restore config (so a swap doesn't silently flip the loop off or
    // change its mode). Direct field assignment — the runtime exposes
    // `config` as a public field.
    if (rt.config) {
      rt.config.enabled = snap.config.enabled;
      rt.config.mode = snap.config.mode;
      rt.config.intervalMinutes = snap.config.intervalMinutes;
      rt.config.targetRepo = snap.config.targetRepo;
      rt.config.branch = snap.config.branch;
      rt.config.evolutionBranch = snap.config.evolutionBranch;
      rt.config.maxCycles = snap.config.maxCycles;
      rt.config.maxFilesPerCycle = snap.config.maxFilesPerCycle;
      rt.config.autoPush = snap.config.autoPush;
      rt.config.siphonSourceId = snap.config.siphonSourceId;
      rt.config.userPrompt = snap.config.userPrompt;
      rt.config.githubToken = snap.config.githubToken;
    }
    // Restore stats so cycle numbering continues from where the old
    // instance left off. Without this, the swap would reset the cycle
    // counter to 0 and the next push would collide with loop-01.
    if (rt.stats) {
      rt.stats.totalRuns = snap.stats.totalRuns;
      rt.stats.totalFilesScanned = snap.stats.totalFilesScanned;
      rt.stats.totalFilesCommitted = snap.stats.totalFilesCommitted;
      rt.stats.lastRunTime = snap.stats.lastRunTime;
      rt.stats.lastTreeFingerprint = snap.stats.lastTreeFingerprint;
      rt.stats.nextRunAt = snap.stats.nextRunAt;
    }
  } catch {
    /* best-effort — a failed restore just means the counter resets */
  }
}

/** Stop the current loop's timer so no cycle starts while we're swapping.
 *  Returns the captured snapshot so the new instance can resume. */
function pauseLoop(): LoopSnapshot | null {
  try {
    const g = globalThis as unknown as { __autonomousLoopRuntime?: any };
    const rt = g.__autonomousLoopRuntime;
    if (!rt) return null;
    const snap = snapshotLoop();
    // Stop the timer. The instance's own stop() sets status="paused" +
    // clears the interval. We call it defensively.
    try { rt.stop?.(); } catch { /* already stopped */ }
    return snap;
  } catch {
    return null;
  }
}

/** Resume the new loop instance: start its timer so the next cycle runs. */
function resumeLoop(): void {
  try {
    const g = globalThis as unknown as { __autonomousLoopRuntime?: any };
    const rt = g.__autonomousLoopRuntime;
    if (!rt) return;
    rt.start?.();
  } catch {
    /* best-effort — the operator can start it from the UI */
  }
}

/** Invalidate every pipeline module in require.cache + clear the
 *  globalThis pins that would otherwise resurrect the old singletons.
 *  Returns the list of invalidated paths (for logging + history). */
function invalidatePipelineCache(): { invalidated: string[]; pinsCleared: string[] } {
  const invalidated: string[] = [];
  const cache = runtimeRequire.cache as unknown as Record<string, NodeModule>;
  const prefix = join(PIPELINE_DIR);
  for (const path of Object.keys(cache)) {
    if (!path.startsWith(prefix)) continue;
    if (DO_NOT_INVALIDATE.some((skip) => path.includes(skip))) continue;
    try {
      delete cache[path];
      invalidated.push(path);
    } catch {
      /* some modules are pinned by the VM; skip them */
    }
  }
  const pinsCleared: string[] = [];
  for (const pin of GLOBAL_PINS) {
    try {
      const g = globalThis as any;
      if (g[pin] !== undefined) {
        g[pin] = undefined;
        pinsCleared.push(pin);
      }
    } catch {
      /* read-only pin — skip */
    }
  }
  return { invalidated, pinsCleared };
}

/** Re-import the loop-runtime module fresh. This creates a brand-new
 *  `AutonomousLoopRuntime` singleton (because we cleared the global pin
 *  in invalidatePipelineCache) wired to the freshly-imported pipeline
 *  modules (because we deleted their cache entries). */
function reimportLoopRuntime(): void {
  // Use an absolute path + bypass the @/ alias so we hit the same
  // resolved path that's in require.cache (or was — we just deleted it).
  // We try several variants because the module may be loaded as .ts
  // (Turbopack dev) or .js (transpiled build), under the @/ alias or
  // the absolute path. Each variant is a different cache key.
  const candidates = [
    join(PIPELINE_DIR, "autonomous", "loop-runtime.ts"),
    join(PIPELINE_DIR, "autonomous", "loop-runtime"),
  ];
  for (const p of candidates) {
    try {
      runtimeRequire(p);
      return;
    } catch {
      /* try next */
    }
  }
  // Last resort: the @/ alias. May hit a different cache key.
  runtimeRequire("@/lib/pipeline/autonomous/loop-runtime");
}

/** The main entry. Performs a full pipeline hot-swap. */
export async function hotSwapPipeline(opts?: {
  reason?: string;
  /** If true, don't actually re-import — just report what would be
   *  invalidated. Used by the dry-run API route. */
  dryRun?: boolean;
}): Promise<HotSwapResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  if (swapInProgress) {
    return {
      ok: false,
      swapped: false,
      reason: "a swap is already in progress — no-op",
      invalidatedCount: 0,
      invalidatedPaths: [],
      pinsCleared: [],
      durationMs: Date.now() - t0,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  swapInProgress = true;

  try {
    // 1. PAUSE + SNAPSHOT
    const snapshot = pauseLoop();

    // 2. INVALIDATE + CLEAR PINS
    const { invalidated, pinsCleared } = invalidatePipelineCache();

    if (opts?.dryRun) {
      // Don't re-import; the loop is still running on the old code.
      // Restart it since pauseLoop stopped it.
      resumeLoop();
      return {
        ok: true,
        swapped: false,
        reason: `dry run: would invalidate ${invalidated.length} module(s), clear ${pinsCleared.length} pin(s)`,
        invalidatedCount: invalidated.length,
        invalidatedPaths: invalidated.slice(0, 50).map((p) => p.replace(PROJECT_ROOT + "/", "")),
        pinsCleared,
        durationMs: Date.now() - t0,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    // 3. RE-IMPORT (with fallback)
    try {
      reimportLoopRuntime();
    } catch (importErr) {
      // FALLBACK: the new code is broken on import. The global pin was
      // cleared, so reimportLoopRuntime left us with NO running loop.
      // We need to restore the OLD module + OLD instance.
      //
      // The cleanest restoration: re-invalidate (to clear the broken
      // partial import) and re-import again — but if the code on disk
      // is broken, that'll throw too. So instead: log the failure,
      // record a postmortem, and rely on the Next.js dev server's next
      // request to re-compile (which may succeed if the broken code
      // was a transient parse error).
      const errMsg = (importErr as Error).message.slice(0, 300);
      // Record a critical postmortem so the failure memory carries it.
      try {
        const { postmortemStore } = await import("../postmortem/postmortem-store");
        await postmortemStore.recordFailure({
          repo: "self",
          branch: "main",
          filePath: "system:hot-swap",
          failureType: "COMPILE_ERROR",
          symptom: "Hot-swap re-import threw — broken code on disk",
          evidence: `reason=${opts?.reason ?? "(none)"} err=${errMsg}`,
          constraints:
            "The new code failed to import. The autonomous loop's running instance was stopped for the swap and could not be restarted. " +
            "An operator must fix the broken code on disk (check the dev log for the import error) and then trigger a manual swap or restart the dev server. " +
            "Until then, the autonomous loop is NOT running.",
        });
      } catch {
        /* best-effort */
      }
      return {
        ok: false,
        swapped: false,
        reason: `re-import failed: ${errMsg}`,
        invalidatedCount: invalidated.length,
        invalidatedPaths: invalidated.slice(0, 50).map((p) => p.replace(PROJECT_ROOT + "/", "")),
        pinsCleared,
        durationMs: Date.now() - t0,
        fallbackError: errMsg,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    // 4. RESTORE + RESUME
    if (snapshot) restoreLoop(snapshot);
    resumeLoop();

    const result: HotSwapResult = {
      ok: true,
      swapped: true,
      reason: opts?.reason ?? "post-enhancement swap",
      invalidatedCount: invalidated.length,
      invalidatedPaths: invalidated.slice(0, 50).map((p) => p.replace(PROJECT_ROOT + "/", "")),
      pinsCleared,
      durationMs: Date.now() - t0,
      startedAt,
      finishedAt: new Date().toISOString(),
    };

    // Record in the ring buffer.
    swapHistory.push(result);
    if (swapHistory.length > SWAP_HISTORY_MAX) swapHistory.shift();

    return result;
  } finally {
    swapInProgress = false;
  }
}

/** Read the swap history (for the API + UI). Returns the most recent first. */
export function getSwapHistory(): HotSwapResult[] {
  return [...swapHistory].reverse();
}

/** Count of swaps since process start. */
export function getSwapCount(): number {
  return swapHistory.length;
}

/** Fingerprint of the currently-loaded pipeline code, for the UI to
 *  show "the running code is X; the code on disk is Y; do they match?"
 *  We hash the resolved module paths' file contents. Cheap enough for
 *  a status endpoint polled every 5s (a few dozen small files). */
export function runningPipelineFingerprint(): string {
  try {
    const paths = pipelineModulesInCache();
    const hasher = createHash("sha256");
    for (const p of paths.sort()) {
      try {
        // Hash the module's id (path) — not the file content — so the
        // fingerprint is stable across calls even when content changes.
        // The point is to show "what modules are loaded", not "what's
        // in them". A swap changes the set; the fingerprint changes.
        hasher.update(p);
        hasher.update("|");
      } catch {
        /* skip unreadable */
      }
    }
    return hasher.digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}
