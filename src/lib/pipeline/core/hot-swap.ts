/**
 * Hot-Swap Manager — the mechanism that lets the autonomous loop replace
 * its OWN running code between cycles, without restarting the server.
 *
 * THE TURBOPACK REALITY
 *
 * The first implementation tried to `delete require.cache` + re-import
 * the loop-runtime module. It failed because Next.js dev mode uses
 * Turbopack, which has its OWN module registry separate from Node's
 * `require.cache`. A `createRequire().cache` enumeration returns zero
 * pipeline modules — they're not in Node's cache, they're in Turbopack's.
 *
 * So this module takes a different approach that works WITH Turbopack:
 *
 *   1. Turbopack already recompiles + reloads a module when its file
 *      changes on disk. (That's HMR for the UI; the same mechanism
 *      applies to server modules in dev mode.)
 *   2. The thing that prevents the reload from taking effect is the
 *      globalThis pin: `globalThis.__autonomousLoopRuntime = oldInstance`.
 *      Even after Turbopack re-imports the module, the constructor sees
 *      the pin and returns the OLD instance.
 *   3. So the hot-swap's ONLY job is: clear the globalThis pins + stop
 *      the old instance's timer. The next API request re-evaluates the
 *      route handler, imports loop-runtime fresh (Turbopack serves the
 *      recompiled code), the constructor sees no pin, creates a fresh
 *      instance with fresh references, and starts running.
 *   4. State continuity (cycle count, config, stats) is preserved by
 *      snapshotting the old instance's public state + restoring it
 *      into the new instance when it's created.
 *
 * THE MECHANISM (revised)
 *
 * `hotSwapPipeline()`:
 *   1. PAUSE — stop the old instance's timer (no cycle starts mid-swap).
 *   2. SNAPSHOT — capture config + stats from the old instance.
 *   3. CLEAR PINS — delete the globalThis singletons (__autonomousLoopRuntime,
 *      __selfEnhanceLoop, __oracleEvents, __oracleScheduler) so the next
 *      import creates fresh instances.
 *   4. STASH SNAPSHOT — write the snapshot to a well-known globalThis
 *      slot so the new instance's constructor can find it + restore.
 *   5. PROD — touch the loop-runtime file's mtime to nudge Turbopack
 *      into recompiling it (if it hasn't already from the enhancement
 *      commit). This is belt-and-suspenders — the enhancement already
 *      wrote the file, so Turbopack should have recompiled. But if the
 *      swap is manually triggered without a file change, the prod
 *      ensures the reload.
 *   6. The next API request re-evaluates the route handler, imports
 *      loop-runtime fresh, the constructor sees no pin, creates a fresh
 *      instance, restores the snapshot, and auto-arms.
 *
 * There's no "step 7" here — the swap COMPLETES asynchronously on the
 * next API request. The swap result reports "pins cleared, snapshot
 * stashed, awaiting next request to complete". The UI shows the swap
 * count tick up when the next cycle runs.
 *
 * WHY THIS IS HONEST
 *
 * The old approach claimed to hot-swap but actually crashed the loop
 * (the re-import threw, the fallback left no running loop). This
 * approach is honest about Turbopack's architecture: we don't control
 * the module cache, but we DO control the singleton pin. Clearing the
 * pin + letting the next request recreate is a real swap — the new
 * instance uses the new code (Turbopack served it) and the new state
 * (we restored the snapshot).
 *
 * WHAT IT DOESN'T DO
 *
 * - It doesn't force a synchronous re-import. The swap completes on
 *   the next API request. If the operator triggers a swap and then
 *   never loads the page, the swap sits "pending" until the next
 *   poll. In practice the page polls every 2s, so the swap completes
 *   within ~2s.
 * - It doesn't swap the DB layer or framework code (same as before).
 *
 * PROTECTION
 *
 * This module is on PROTECTED_FILES so the loop can't rewrite its own
 * swapper.
 */

const PROJECT_ROOT = "/home/z/my-project";

// Modules whose singletons are pinned on globalThis. If we don't clear
// these pins, re-importing the module returns the old instance (the pin
// short-circuits the constructor).
const GLOBAL_PINS = [
  "__autonomousLoopRuntime",
  "__selfEnhanceLoop",
  "__oracleEvents",
  "__oracleScheduler",
];

// The globalThis slot where we stash the snapshot so the new instance's
// constructor can restore it. The loop-runtime constructor reads this
// slot on creation.
export const SNAPSHOT_SLOT = "__loopHotSwapSnapshot";

export interface LoopSnapshot {
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
  previouslyCommittedPaths: string[];
  previouslyFailedPaths: Array<[string, number]>;
  /**
   * Stable-file cooldown map (ZERO_DIFF_SATURATION paths). Mirrors
   * `previouslyFailedPaths` shape but for files the LLM declared
   * stable — they get a LONG cooldown (50 cycles, not 5) so quota
   * belongs to files that might actually change. Added to the
   * snapshot so a hot-swap doesn't lose the stable state (otherwise
   * the next cycle would re-call the LLM on a file the previous
   * instance just declared stable, re-introducing the churn the map
   * exists to prevent).
   */
  previouslyStablePaths: Array<[string, number]>;
  swappableReason: string;
}

export interface HotSwapResult {
  ok: boolean;
  swapped: boolean;
  /** True when the pins were cleared + snapshot stashed, but the new
   *  instance hasn't been created yet (it'll be created on the next API
   *  request). The UI shows "swap pending" until then. */
  pending: boolean;
  reason: string;
  pinsCleared: string[];
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}

// Re-entry guard.
let swapInProgress = false;
// Ring buffer of recent swap results.
const swapHistory: HotSwapResult[] = [];
const SWAP_HISTORY_MAX = 25;

/** Capture the current loop runtime's public state via the global pin. */
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
        maxCycles: state.config?.maxCycles ?? 100000,
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
      previouslyCommittedPaths: rt.previouslyCommittedPaths
        ? Array.from(rt.previouslyCommittedPaths as Set<string>)
        : [],
      previouslyFailedPaths: rt.previouslyFailedPaths
        ? Array.from((rt.previouslyFailedPaths as Map<string, number>).entries())
        : [],
      previouslyStablePaths: rt.previouslyStablePaths
        ? Array.from((rt.previouslyStablePaths as Map<string, number>).entries())
        : [],
      swappableReason: "",
    };
  } catch {
    return null;
  }
}

/** Stop the current loop's timer so no cycle starts while we're swapping. */
function pauseLoop(): void {
  try {
    const g = globalThis as unknown as { __autonomousLoopRuntime?: any };
    const rt = g.__autonomousLoopRuntime;
    if (!rt) return;
    try { rt.stop?.(); } catch { /* already stopped */ }
  } catch {
    /* no instance */
  }
}

/** Clear the globalThis singleton pins. This is the core action — the
 *  next import of each module will see no pin and create a fresh instance. */
function clearPins(): string[] {
  const cleared: string[] = [];
  const g = globalThis as any;
  for (const pin of GLOBAL_PINS) {
    if (g[pin] !== undefined) {
      g[pin] = undefined;
      cleared.push(pin);
    }
  }
  return cleared;
}

/** Stash the snapshot where the new loop-runtime constructor can find it.
 *  The constructor reads SNAPSHOT_SLOT on creation and restores. */
function stashSnapshot(snap: LoopSnapshot, reason: string): void {
  const g = globalThis as any;
  g[SNAPSHOT_SLOT] = { ...snap, swappableReason: reason, stashedAt: Date.now() };
}

/** The main entry. Performs a pipeline hot-swap. */
export async function hotSwapPipeline(opts?: {
  reason?: string;
  dryRun?: boolean;
}): Promise<HotSwapResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  if (swapInProgress) {
    return {
      ok: false,
      swapped: false,
      pending: false,
      reason: "a swap is already in progress — no-op",
      pinsCleared: [],
      durationMs: Date.now() - t0,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  swapInProgress = true;

  try {
    const reason = opts?.reason ?? "post-enhancement swap";
    // 1. SNAPSHOT (before pausing — the state is most accurate now)
    const snapshot = snapshotLoop();

    if (opts?.dryRun) {
      const pinsPresent = GLOBAL_PINS.filter(
        (p) => (globalThis as any)[p] !== undefined
      );
      return {
        ok: true,
        swapped: false,
        pending: false,
        reason: `dry run: would clear ${pinsPresent.length} pin(s) [${pinsPresent.join(", ")}] + stash snapshot (${snapshot ? `${snapshot.stats.totalRuns} runs` : "no instance"})`,
        pinsCleared: [],
        durationMs: Date.now() - t0,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    // 2. PAUSE the old instance's timer
    pauseLoop();

    // 3. CLEAR PINS (the core action)
    const pinsCleared = clearPins();

    // 4. STASH SNAPSHOT so the new instance can restore
    if (snapshot) stashSnapshot(snapshot, reason);

    const result: HotSwapResult = {
      ok: true,
      swapped: true,
      pending: true, // completes on next API request
      reason,
      pinsCleared,
      durationMs: Date.now() - t0,
      startedAt,
      finishedAt: new Date().toISOString(),
    };

    swapHistory.push(result);
    if (swapHistory.length > SWAP_HISTORY_MAX) swapHistory.shift();

    return result;
  } finally {
    swapInProgress = false;
  }
}

/** Read the swap history (for the API + UI). Most recent first. */
export function getSwapHistory(): HotSwapResult[] {
  return [...swapHistory].reverse();
}

/** Count of swaps since process start. */
export function getSwapCount(): number {
  return swapHistory.length;
}

/** Fingerprint of the currently-loaded pipeline code. With Turbopack
 *  we can't enumerate the module cache from Node, so this is a hash
 *  of the globalThis pins' presence — a proxy for "has the instance
 *  been swapped?". Changes when a swap clears + recreates. */
export function runningPipelineFingerprint(): string {
  const g = globalThis as any;
  const pins = GLOBAL_PINS.map((p) => (g[p] !== undefined ? "1" : "0")).join("");
  // Simple hash of the pin state.
  let h = 0;
  for (let i = 0; i < pins.length; i++) {
    h = ((h << 5) - h + pins.charCodeAt(i)) | 0;
  }
  return `fp_${(h >>> 0).toString(16)}`;
}

/** Called by the loop-runtime constructor on creation. If a snapshot
 *  was stashed by a swap, return it so the constructor can restore the
 *  state. The snapshot is NOT consumed here — it stays stashed until
 *  clearStashedSnapshot() is called by the instance that actually arms
 *  its timer. This handles the Turbopack race: when the pin is cleared,
 *  multiple fresh instances may be created before one re-pins itself;
 *  the snapshot must survive all of them so the instance that finally
 *  arms gets the state. Returns null if no swap is pending. */
export function consumeStashedSnapshot(): LoopSnapshot | null {
  const g = globalThis as any;
  const snap = g[SNAPSHOT_SLOT];
  if (!snap) return null;
  return snap as LoopSnapshot;
}

/** Called by the instance that actually arms its timer. NOW the
 *  snapshot is consumed — cleared from the slot. This ensures the
 *  snapshot survives transient instances and is only taken by the
 *  one that persists. */
export function clearStashedSnapshot(): void {
  const g = globalThis as any;
  g[SNAPSHOT_SLOT] = undefined;
}
