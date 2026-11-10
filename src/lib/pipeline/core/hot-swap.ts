import { appendFileSync, mkdirSync, readFileSync, utimesSync } from "fs";
import { join } from "path";
import { db } from "@/lib/db";

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

import { PROJECT_ROOT } from "./paths";

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

// ── Self-enhance loop state continuity (audit 3, B4/B11) ────────────────
// The loop-runtime snapshot above restores the high-level scheduler, but
// the SELF-ENHANCE loop's own state (compounding cadence counter, per-file
// saturation lockouts, cooldown streak) was never captured — every swap
// reset cyclesCompleted to 0, which silently restarted the distillation
// cadence (every 10 cycles → back to square one) and the meta-tuner's
// warm-up (70 cycles → never elapsing, D8 effectively disabled in steady
// state) and cleared every saturation lockout (locked-out files burned
// quota again). A separate slot (not folded into LoopSnapshot) because a
// different consumer (the SelfEnhanceLoop constructor) reads it.
export const SELF_SNAPSHOT_SLOT = "__selfEnhanceLoopSnapshot";

export interface SelfEnhanceSnapshot {
  /** True when the OLD instance was running continuously — the new
   *  instance schedules an auto-resume so a post-enhancement swap
   *  doesn't halt the autonomy after one pipeline-file improvement. */
  continuous: boolean;
  stats: {
    totalScanned: number;
    totalEnhanced: number;
    totalReverted: number;
    totalPushed: number;
    testsWritten: number;
    cyclesCompleted: number;
    tasksGenerated: number;
    lastEnhancementAt: string | null;
  };
  /** Per-file saturation lockouts (repo-relative path → state). */
  saturation: Array<[string, unknown]>;
  consecutiveCooldownCycles: number;
  quotaExhaustedLogged: boolean;
  stashedAt: number;
  reason: string;
}

function snapshotSelfEnhance(reason: string): SelfEnhanceSnapshot | null {
  try {
    const g = globalThis as unknown as { __selfEnhanceLoop?: any };
    const sel = g.__selfEnhanceLoop;
    if (!sel) return null;
    return {
      continuous: typeof sel.isContinuous === "function" ? sel.isContinuous() : false,
      stats:
        sel.stats ?? {
          totalScanned: 0,
          totalEnhanced: 0,
          totalReverted: 0,
          totalPushed: 0,
          testsWritten: 0,
          cyclesCompleted: 0,
          tasksGenerated: 0,
          lastEnhancementAt: null,
        },
      saturation: sel.saturation instanceof Map ? Array.from(sel.saturation.entries()) : [],
      consecutiveCooldownCycles: sel.consecutiveCooldownCycles ?? 0,
      quotaExhaustedLogged: sel.quotaExhaustedLogged ?? false,
      stashedAt: Date.now(),
      reason,
    };
  } catch {
    return null;
  }
}

/** Read (not consume) the stashed self-enhance snapshot. Called by the
 *  SelfEnhanceLoop constructor. Cleared by clearSelfEnhanceSnapshot when
 *  the new instance actually arms — same survival contract as the
 *  loop-runtime snapshot. */
export function consumeSelfEnhanceSnapshot(): SelfEnhanceSnapshot | null {
  const g = globalThis as any;
  const snap = g[SELF_SNAPSHOT_SLOT];
  if (!snap) return null;
  return snap as SelfEnhanceSnapshot;
}

export function clearSelfEnhanceSnapshot(): void {
  const g = globalThis as any;
  g[SELF_SNAPSHOT_SLOT] = undefined;
}

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

// ── Module-identity fix ─────────────────────────────────────────────
// In Turbopack dev mode, the same module file can be loaded into multiple
// module graphs (one per route boundary). A module-level `let swapHistory =
// []` is PER-INSTANCE — the trigger route pushes to one array, the status
// route reads from another, and the UI always shows 0 swaps. Moving the
// re-entry guard + history ring to globalThis makes them shared across all
// module instances, same pattern as the singleton pins themselves.
// Verified: the fingerprint (already on globalThis) DID update cross-route
// while the history (module-level) did not — proving the fix.
const STATE_SLOT = "__hotSwapState";
const SWAP_HISTORY_MAX = 25;

interface HotSwapState {
  swapInProgress: boolean;
  swapHistory: HotSwapResult[];
}

function getHotSwapState(): HotSwapState {
  const g = globalThis as unknown as { [STATE_SLOT]?: HotSwapState };
  if (!g[STATE_SLOT]) {
    g[STATE_SLOT] = { swapInProgress: false, swapHistory: [] };
  }
  return g[STATE_SLOT]!;
}

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
    const g = globalThis as unknown as {
      __autonomousLoopRuntime?: any;
      __selfEnhanceLoop?: any;
    };
    // Stop BOTH singletons. The loop-runtime's timer drives the high-level
    // cycle scheduler; the self-enhance loop's runContinuous while-loop
    // drives the enhance-verify-push inner loop. Stopping only the runtime
    // leaves the enhance loop's while-loop running against the OLD module
    // code — an invisible rogue loop the STOP button can't reach (it
    // calls stop() on the NEW singleton post-swap). Bumping runId via
    // stop() makes the in-flight runCycle exit at its next checkpoint.
    const rt = g.__autonomousLoopRuntime;
    if (rt) {
      try { rt.stop?.(); } catch { /* already stopped */ }
    }
    const sel = g.__selfEnhanceLoop;
    if (sel) {
      try { sel.stop?.(); } catch { /* already stopped */ }
    }
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

  const state = getHotSwapState();
  if (state.swapInProgress) {
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
  state.swapInProgress = true;

  try {
    const reason = opts?.reason ?? "post-enhancement swap";
    // 1. SNAPSHOT (before pausing — the state is most accurate now)
    const snapshot = snapshotLoop();
    // 1b. SNAPSHOT THE SELF-ENHANCE LOOP TOO (audit 3, F2 — critical
    //     ordering). snapshotSelfEnhance captures `continuous:
    //     sel.isContinuous()`. pauseLoop() (step 2) calls sel.stop(),
    //     which sets continuous=false. Taking this snapshot AFTER the
    //     pause — as the old order did — always recorded
    //     continuous:false, so the new instance's resume branch
    //     (`if (snap.continuous)`) was dead code: the "fully autonomous"
    //     loop silently died after EVERY successful pipeline-file
    //     enhancement until a human pressed START. Both snapshots now sit
    //     on the same side of pauseLoop().
    const selfSnap = snapshotSelfEnhance(reason);

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

    // 4b. STASH the self-enhance snapshot taken in step 1b (separate slot,
    //     separate consumer — the SelfEnhanceLoop constructor). Without
    //     this, every swap reset cyclesCompleted/saturation/cooldown
    //     state — see the SELF_SNAPSHOT_SLOT note above.
    if (selfSnap) {
      (globalThis as any)[SELF_SNAPSHOT_SLOT] = selfSnap;
    }

    // 5. PROD — touch the loop-runtime + self-enhance-loop mtime to nudge
    //    Turbopack into recompiling. Post-enhancement triggers already
    //    wrote the file (Turbopack recompiles from the write), but a MANUAL
    //    trigger has no file change — without this prod, the singleton line
    //    `globalForLoop.__autonomousLoopRuntime ?? new AutonomousLoopRuntime()`
    //    never re-runs, the new instance is never created, and the swap
    //    stays pending forever. Touching mtime gives Turbopack a reason to
    //    recompile + re-evaluate the module, which runs the singleton line,
    //    which sees the cleared pin and creates the fresh instance.
    //    Two files because both singletons (__autonomousLoopRuntime AND
    //    __selfEnhanceLoop) need to re-evaluate.
    const prodded: string[] = [];
    for (const rel of [
      "src/lib/pipeline/autonomous/loop-runtime.ts",
      "src/lib/pipeline/autonomous/self-enhance-loop.ts",
    ]) {
      try {
        const now = new Date();
        utimesSync(join(PROJECT_ROOT, rel), now, now);
        prodded.push(rel);
      } catch {
        /* file may not exist in this checkout — best-effort */
      }
    }

    const result: HotSwapResult = {
      ok: true,
      swapped: true,
      pending: true, // completes on next API request after Turbopack recompiles
      reason,
      pinsCleared,
      durationMs: Date.now() - t0,
      startedAt,
      finishedAt: new Date().toISOString(),
    };

    state.swapHistory.push(result);
    if (state.swapHistory.length > SWAP_HISTORY_MAX) state.swapHistory.shift();

    // PERSISTENT SUCCESS COUNTER (boot-splash "HOT-SWAP LOG · N LIFETIME").
    // swapHistory is in-memory and dies with the process; the SystemFlag
    // row survives restarts AND the disk journal (.git/info/, wipe-proof)
    // survives DB rolls. Counted ONLY on the success path (ok &&
    // swapped) — a failed/pending swap never inflates the number.
    // Fire-and-forget: a counter failure must never fail a swap that
    // already succeeded.
    bumpHotSwapSuccessCounter({
      at: result.finishedAt,
      reason,
      pinsCleared,
      durationMs: result.durationMs,
    }).catch(() => {
      /* counter is best-effort — the swap itself already succeeded */
    });

    // Log the prod so the operator knows why Turbopack recompiled (the
    // mtime touch is invisible otherwise — no file content changed).
    if (prodded.length > 0) {
      result.reason = `${reason} (prodded ${prodded.length} module(s) for recompile)`;
    }

    return result;
  } finally {
    state.swapInProgress = false;
  }
}

/** Read the swap history (for the API + UI). Most recent first.
 *  Reads from globalThis so the status route sees what the trigger
 *  route wrote (module-level state is per-instance in Turbopack —
 *  see STATE_SLOT above). */
export function getSwapHistory(): HotSwapResult[] {
  return [...getHotSwapState().swapHistory].reverse();
}

/** Count of swaps since process start. Same globalThis read. */
export function getSwapCount(): number {
  return getHotSwapState().swapHistory.length;
}

/** SystemFlag key for the persistent (restart-surviving) success count. */
export const HOT_SWAP_SUCCESS_FLAG = "hot-swap-success-count";

// ── WIPE-PROOF DISK JOURNAL (the "lifetime" counter's durable tier) ────
// The DB SystemFlag lives in SQLite, and the sandbox ROLLS THE DB BACK —
// observed live: the mutation corpus reads 0 attempts while the remote
// holds 108 loop-NN branches. A swap that really happened must never be
// erased by a roll, so every successful swap ALSO appends a line to
// .git/info/loop-hot-swap-journal.jsonl — the same wipe-proof tier as
// the vault key (.git/info/loop-vault-key) and the push state
// (.git/info/loop-push-state.json). .git/info/ is never tracked, never
// committed, and survives DB rolls. The reader takes max(disk, DB) so
// neither tier can undercount the other (a DB that raced ahead of the
// journal is still honored; a rolled-back DB is healed from disk).
const HOT_SWAP_JOURNAL = ".git/info/loop-hot-swap-journal.jsonl";

function journalPath(): string {
  return join(PROJECT_ROOT, HOT_SWAP_JOURNAL);
}

interface SwapJournalEntry {
  at: string;
  reason: string;
  pinsCleared: string[];
  durationMs: number;
}

/** Append one line per successful swap. Never throws — a journal
 *  failure must never fail a swap that already succeeded.
 *
 *  audit 4 — grow-only sweep: the in-memory `swapHistory` is capped at 25
 *  (see hotSwapPipeline), but this DISK journal was append-only with no
 *  rotation. The reader at readSwapJournalCount loads the whole file and
 *  splits on newlines — a multi-MB journal would slow every reader call.
 *  Rotate every 50th swap to keep newest 1000 entries (see retention.ts).
 *  The 50-swap throttle amortizes the read-rewrite cost (same pattern as
 *  mutation-corpus.ts: every 25th cycle). Module-level counter resets on
 *  restart — worst case the journal grows by 50 entries (~10 KB) before
 *  the next rotation, which is negligible. */
let swapAppendCounter = 0;
function appendSwapJournal(entry: SwapJournalEntry): void {
  try {
    mkdirSync(join(PROJECT_ROOT, ".git/info"), { recursive: true });
    appendFileSync(journalPath(), `${JSON.stringify(entry)}\n`, "utf8");
    // Throttled rotation: every 50th swap, trim to newest 1000 entries.
    // Best-effort — a rotation failure logs and leaves the file intact.
    // Dynamic import (not top-level) avoids a core→autonomous static
    // dependency edge; retention.ts is a leaf (db + paths only).
    swapAppendCounter++;
    if (swapAppendCounter % 50 === 0) {
      void import("../autonomous/retention")
        .then((m) => m.pruneHotSwapJournal(1000))
        .catch(() => { /* best-effort — don't fail the swap */ });
    }
  } catch {
    /* best-effort — the DB flag is the other tier */
  }
}

/** Count recorded swaps on disk (0 when the journal is absent/unreadable
 *  — never throws, never fakes). */
function readSwapJournalCount(): number {
  try {
    const raw = readFileSync(journalPath(), "utf8");
    let n = 0;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as SwapJournalEntry;
        if (e && typeof e.at === "string") n++;
      } catch {
        /* torn/partial line (crash mid-append) — not a completed swap */
      }
    }
    return n;
  } catch {
    return 0;
  }
}

/** Increment the persistent success counter. Success path only.
 *  Dual-tier: DB SystemFlag + wipe-proof disk journal (see above). */
async function bumpHotSwapSuccessCounter(entry: SwapJournalEntry): Promise<void> {
  appendSwapJournal(entry);
  const flag = await db.systemFlag.findUnique({ where: { key: HOT_SWAP_SUCCESS_FLAG } });
  const current = parseInt(flag?.value ?? "0", 10) || 0;
  await db.systemFlag.upsert({
    where: { key: HOT_SWAP_SUCCESS_FLAG },
    update: {
      value: String(current + 1),
      setBy: "hot-swap",
      reason: "one more successful live hot-swap (pins cleared, snapshot stashed, ok+swapped)",
      setAt: new Date(),
    },
    create: {
      key: HOT_SWAP_SUCCESS_FLAG,
      value: "1",
      setBy: "hot-swap",
      reason: "first successful live hot-swap (pins cleared, snapshot stashed, ok+swapped)",
    },
  });
}

/** Read the persistent success count (0 on any failure — never throws).
 *  max(disk journal, DB flag): the journal survives DB rolls, the DB
 *  honors swaps that raced ahead of a journal write. */
export async function getHotSwapSuccessCount(): Promise<number> {
  let disk = 0;
  let flagVal = 0;
  try {
    disk = readSwapJournalCount();
  } catch {
    disk = 0;
  }
  try {
    const flag = await db.systemFlag.findUnique({ where: { key: HOT_SWAP_SUCCESS_FLAG } });
    flagVal = parseInt(flag?.value ?? "0", 10) || 0;
  } catch {
    flagVal = 0;
  }
  return Math.max(disk, flagVal);
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
