/**
 * Autonomous Self-Enhancement Loop Runtime (singleton, server-side)
 *
 * Supports four modes for triggering pipeline runs without manual interaction:
 *   1. scheduled   — interval-based cron-like timer (default 10 min)
 *   2. watch       — file-system-ish watcher over the target repo
 *                    (re-runs when remote tree fingerprint changes)
 *   3. continuous  — true continuous agent loop: back-to-back cycles with
 *                    saturation-driven self-stop (per halt governor)
 *   4. manual      — one-shot /api/autonomous/trigger invocation
 *
 * Each cycle:
 *   - fetches the target repo tree
 *   - selects up to N code files (sliced)
 *   - runs the 6-stage pipeline on each (sanitizer -> AST -> review)
 *   - if `autoPush` and gates pass, dispatches batch commit to GitHub
 *   - records a cycle in the DB and broadcasts logs via the WebSocket bus
 */

import { unifiedPipelineRunnerInstance } from "../core/unified-pipeline";
import { db } from "@/lib/db";
import { postmortemStore, generatePostmortemFromReport } from "../postmortem/postmortem-store";
import { autoProphecyAfterCycle } from "../oracle/oracle-auto";
import { isSafeMode, getSafeModeState } from "../core/duress";
import type { LoopSnapshot } from "../core/hot-swap";
// Retention helpers (audit 4 — grow-only sweep): bounded growth for the
// AutonomousCycle + PipelineRun tables the loop writes to. Fire-and-
// forget; a prune failure never fails the cycle that triggered it.
import { prunePipelineRuns, pruneAutonomousCycles } from "./retention";
// Operator armed-intent tier (.git/info/loop-armed-state.json). Pure leaf
// (fs + path), no circulars — the same import class as the agent-llm gate
// above. See armed-state.ts for why the intent must live on disk.
import { markArmed, readArmedState, type ArmedState } from "./armed-state";
// Operator crash-budget tier (.git/info/loop-crash-budget.json). Same
// wipe-proof pattern as armed-state — the count survives process death
// AND sandbox DB rollbacks, so a segfault that kills the process and the
// auto-restart boots a fresh instance can still trip the wall (the
// in-memory count alone would reset on every restart). Pure leaf.
import {
  readCrashBudget,
  writeCrashBudget,
  resetCrashBudget,
} from "./crash-budget";
// Operator last-touch tier (.git/info/loop-operator-touch.json) — powers
// the dead-man's switch: if the operator hasn't touched the system in
// 24h, the loop auto-PAUSES (no boot auto-arm). The operator must check
// in at least once a day for the autonomy to keep running. Pure leaf.
import { markOperatorTouch, isDeadMansTripped } from "./operator-touch";
import { runRedTeamSuite } from "../red-team/red-team-runner";
// Static import of the LLM rate-limit gate. This used to be a dynamic
// `require()` inside runContinuousLoop, but under Turbopack the interop
// of `require()` on compiled ESM is unreliable — when it silently fails,
// the backoff never triggers and the loop hammers a rate-limited API every
// tick until the event loop saturates and HTTP dies. agent-llm imports
// ONLY z-ai-web-dev-sdk (no pipeline modules), so a static import here
// creates no circular dependency. oracle-auto.ts already does this.
import { llmIsCoolingDown, llmCooldownMs } from "../llm/agent-llm";

/** How often (in completed autonomous cycles) the red-team suite
 *  auto-runs. Coarse so it doesn't compete with the enhancement step
 *  for the LLM quota. Every 20 cycles ≈ once per ~hour of continuous
 *  operation at the default 3-minute interval. */
const RED_TEAM_PERIOD = 20;

export type LoopMode = "scheduled" | "watch" | "continuous" | "manual";
export type LoopStatus = "idle" | "running" | "paused" | "error";

/**
 * The derived LIVE phase of the autonomous loop — what the UI reports.
 * This is a function of `(config.enabled, status, llmIsCoolingDown,
 * recoveryDeadlineMs, crashWall)`, NOT a free variable. The internal
 * `LoopStatus` (idle/running/paused/error) is the raw scheduler state;
 * `LivePhase` is what the operator actually wants to know: "is the
 * loop working, throttled, recovering, paused, or off?".
 *
 *   DISARMED          — config.enabled is false AND no crash-wall. The
 *                       loop does nothing. Press [START] to arm.
 *   ARMED-RUNNING     — armed, gate open, a cycle is in flight (or
 *                       about to start). The loop is making progress.
 *   ARMED-THROTTLED   — armed, the LLM 429 gate is active. The loop
 *                       auto-pauses until the gate clears. STOP still
 *                       works within 1s.
 *   ARMED-RECOVERING  — armed, the gate just cleared, the loop waits a
 *                       30s settle window before the next cycle so the
 *                       provider has a clean slate (avoids the immediate
 *                       re-429 you get when you fire the moment the gate
 *                       opens). Counts down via recoveryDeadlineMs.
 *   ARMED-PAUSED      — armed but stopped: either the operator pressed
 *                       [STOP] (sticky), OR the crash-wall tripped (3
 *                       consecutive same-class cycle crashes). Only an
 *                       explicit [START] releases this state — no boot,
 *                       probe, or quota event re-arms from here.
 *
 * The state machine:
 *   DISARMED → [START] → ARMED-RUNNING
 *   ARMED-RUNNING → quota halt → ARMED-THROTTLED
 *   ARMED-THROTTLED → quota reset → ARMED-RECOVERING (30s)
 *   ARMED-RECOVERING → timer → ARMED-RUNNING / [PAUSE] → ARMED-PAUSED
 *   ARMED-PAUSED (sticky, only manual [START] releases it)
 */
export type LivePhase =
  | "DISARMED"
  | "ARMED-RUNNING"
  | "ARMED-THROTTLED"
  | "ARMED-RECOVERING"
  | "ARMED-PAUSED";

export interface LoopConfig {
  enabled: boolean;
  mode: LoopMode;
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
}

export interface LoopStats {
  totalRuns: number;
  totalFilesScanned: number;
  totalFilesCommitted: number;
  lastRunTime: string | null;
  lastTreeFingerprint: string | null;
  nextRunAt: string | null;
}

export interface LoopLogEntry {
  timestamp: string;
  message: string;
  type: "info" | "warn" | "success" | "error";
  source: "autonomous" | "pipeline" | "github";
}

export interface LoopState {
  config: LoopConfig;
  status: LoopStatus;
  /** The derived LIVE phase — see LivePhase. This is what the UI reports
   *  (the raw `status` is the scheduler's internal word; the operator
   *  wants to know DISARMED / ARMED-RUNNING / ARMED-THROTTLED /
   *  ARMED-RECOVERING / ARMED-PAUSED). */
  livePhase: LivePhase;
  /** Milliseconds remaining in the ARMED-RECOVERING window (0 when not
   *  recovering). A RELATIVE duration, accurate at response time — the
   *  UI re-anchors to its own clock as `Date.now() + recoveryRemainingMs`
   *  (same skew-free pattern as the quota gate's remainingMs). */
  recoveryRemainingMs: number;
  stats: LoopStats;
  logs: LoopLogEntry[];
  currentCycle: AutonomousCycleState | null;
  recentCycles: AutonomousCycleSummary[];
}

export interface AutonomousCycleState {
  id: string;
  cycleNumber: number;
  mode: LoopMode;
  targetRepo: string;
  branch: string;
  startedAt: string;
  filesScanned: number;
  filesCommitted: number;
  status: "running" | "completed" | "error" | "halted";
  fileResults: Array<{
    path: string;
    astScore: number;
    consensus: string;
    proofHash: string;
    status: string;
    pushed: boolean;
  }>;
}

export interface AutonomousCycleSummary {
  id: string;
  cycleNumber: number;
  mode: LoopMode;
  targetRepo: string;
  branch: string;
  filesScanned: number;
  filesCommitted: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  proofHash: string | null;
}

class AutonomousLoopRuntime {
  private config: LoopConfig = {
    // ── OPERATOR-GATED (default, set 2026-11-03) ──────────────────────
    // Was enabled:true (auto-arm on boot — the loop started itself the
    // moment loop-runtime.ts was imported, no [START] needed). Disabled
    // because a native segfault in the LLM cycle crashes the server a
    // few seconds into each run (see src/instrumentation.ts comment —
    // JS-level handlers can't catch a C-level crash).
    //
    // The in-memory default is the FRESH-CHECKOUT tier: a brand-new
    // instance never auto-starts; the operator presses [START] once.
    // That press ALSO persists the intent to the wipe-proof tier
    // (.git/info/loop-armed-state.json — see armed-state.ts), and the
    // boot auto-arm below re-arms from disk on every subsequent boot:
    // armed once → runs by itself whenever the LLM quota gate is open,
    // across process restarts and DB rolls. [STOP] clears the disk
    // intent — the operator's interrupt is sticky forever, exactly as
    // specified ("stops when quota halt or user interrupts" — a quota
    // halt only backs off, a user STOP disarms). The duress safe-mode
    // gate (core/duress.ts) still pauses it on a security event.
    // See docs/HOT-SWAP.md.
    enabled: false,
    mode: "continuous",
    intervalMinutes: 1,
    targetRepo: "craighckby-stack/V1",
    branch: "main",
    evolutionBranch: "loop-01",
    maxCycles: 100000, // effectively unlimited — the loop is meant to run
    maxFilesPerCycle: 3,
    autoPush: true,
    siphonSourceId: "self",
    userPrompt: "",
    githubToken: "",
  };

  private status: LoopStatus = "idle";
  private stats: LoopStats = {
    totalRuns: 0,
    totalFilesScanned: 0,
    totalFilesCommitted: 0,
    lastRunTime: null,
    lastTreeFingerprint: null,
    nextRunAt: null,
  };
  private logs: LoopLogEntry[] = [];
  private currentCycle: AutonomousCycleState | null = null;
  private recentCycles: AutonomousCycleSummary[] = [];
  private timer: NodeJS.Timeout | null = null;
  private continuousLoopRunning = false;
  /** Generation token for the continuous while-loop. restartScheduler()
   *  bumps it to invalidate any old loop still parked in an await — the
   *  old code flipped continuousLoopRunning false→true synchronously, so
   *  a mid-await old loop re-checked the flag AFTER the new spawn set it
   *  true again and BOTH loops ran (duplicate cycles, doubled crash
   *  budget, "another cycle already running" spam). */
  private continuousLoopGeneration = 0;
  /** STOP-interrupt generation (external audit F2). stop() increments
   *  this; executeCycle() captures it at entry and re-checks per file
   *  and before every remote commit. Previously stop() only disabled
   *  the scheduler — an executeCycle() already in flight processed its
   *  whole file list and could still commit to the remote repo after
   *  [STOP]. A generation counter (rather than reading config.enabled
   *  directly) keeps manual one-shot triggers working while the loop is
   *  stopped: triggerManual() captures the CURRENT generation and is
   *  only interrupted by a STOP pressed after it began, which is the
   *  correct semantics for an operator interrupt. */
  private cycleGeneration = 0;
  /** ARMED-RECOVERING countdown anchor (epoch ms). 0 when not recovering.
   *  Set to `Date.now() + RECOVERY_SETTLE_MS` the moment the LLM 429 gate
   *  transitions from active → clear. While > Date.now(), `livePhase()`
   *  reports ARMED-RECOVERING and `runContinuousLoop` waits out the
   *  remainder before starting the next cycle. The 30s settle window
   *  avoids the immediate re-429 you get when you fire the exact moment
   *  the gate opens. */
  private recoveryDeadlineMs = 0;
  /** The 30s settle window between quota-clear and next-cycle. Chosen
   *  to be long enough for the provider to fully reset its rate-limit
   *  counters but short enough that the operator doesn't think the loop
   *  died. The UI shows a live countdown. */
  private static readonly RECOVERY_SETTLE_MS = 30_000;
  /** Sticky crash-budget wall. Set true when 3 consecutive same-class
   *  cycle crashes happen (see runContinuousLoop's catch). Cleared
   *  ONLY by an explicit [START] — no boot, probe, or quota event
   *  re-arms from this state. Persisted to .git/info/loop-crash-budget.json
   *  so it survives process death (a segfault that kills the process
   *  and the auto-restart boots a fresh instance must STILL see the
   *  wall — the in-memory flag alone would reset). */
  private crashWall = false;
  /** Dead-man's switch: tripped when the operator hasn't touched the
   *  system in >24h. STICKY — only an explicit [START] clears it (same
   *  release path as crashWall). When tripped, `livePhase()` returns
   *  ARMED-PAUSED (not DISARMED) because the operator's LAST RECORDED
   *  intent was "armed" — the switch silently disarmed them overnight,
   *  and the splash must honestly say "ARMED — PAUSED — MANUAL [START]
   *  REQUIRED" so the operator knows to re-arm, not "DISARMED" (which
   *  would be a lie — they DID arm, the switch tripped). Cleared by
   *  start() (which refreshes the touch timestamp AND resets this
   *  flag). NOT persisted to disk: it's RE-DERIVED on every boot from
   *  the touch file (isDeadMansTripped reads the file fresh). */
  private deadMansTripped = false;
  /** In-memory consecutive same-class crash counter. Mirrored to the
   *  disk tier on every change so it survives restarts. Reset to 0 on
   *  a clean cycle (completed or halted — per-file failures inside a
   *  cycle do NOT count as a crash for this purpose, they're caught
   *  inside the for-loop and reported through postmortems). */
  private consecutiveCrashCount = 0;
  /** The error class (Error.name / constructor name) of the last crash.
   *  Different classes reset the count — only SUSTAINED same-class
   *  crashes trip the wall. A network blip followed by a segfault is 2
   *  different problems, not a pattern. */
  private lastCrashClass = "";
  /**
   * Set of file paths already committed to the evolution branch in prior
   * cycles — skipped so each cycle processes NEW files instead of re-doing
   * the same first-N-alphabetical files every time.
   */
  private previouslyCommittedPaths: Set<string> = new Set();
  /**
   * Set of file paths that FAILED in a prior cycle (AST-rejected,
   * debate-rejected, or threw). Skipped for a cooldown period so the
   * loop doesn't get stuck retrying the same un-improvable file every
   * cycle. (Zero-diff saturation is tracked separately — see
   * `previouslyStablePaths`; it is NOT a failure, so it does not belong
   * here. The old code lumped them together and burned 1 LLM call per
   * stable file every 5 cycles forever — visible in the dev log as
   * build-guide/*.py stuck at attempt #7+ and contributing to the 429
   * rate-limits.)
   *
   * Each entry is `{path, failedAt}` so the cooldown can expire. A file
   * that failed 5 cycles ago gets re-tried; one that failed last cycle
   * is skipped. The cooldown is `FAILED_FILE_COOLDOWN_CYCLES`.
   */
  private previouslyFailedPaths: Map<string, number> = new Map();
  private static readonly FAILED_FILE_COOLDOWN_CYCLES = 5;
  /**
   * Set of file paths the LLM declared STABLE in a prior cycle
   * (ZERO_DIFF_SATURATION — produced no semantic change). Skipped for a
   * LONG cooldown (`STABLE_FILE_COOLDOWN_CYCLES`, 50 cycles) so quota
   * belongs to files that might actually change. 50 cycles = ~5
   * distillation passes (DISTILL_INTERVAL=10), enough for the lesson
   * store to evolve new prompts that might tip the LLM to find a real
   * refactor when the file is re-tried.
   *
   * Same `{path, stableAt}` shape as `previouslyFailedPaths`. The long
   * cooldown is the fix for the "stable file churn" bug — the old code
   * used the 5-cycle FAILED cooldown for zero-diff too, which kept
   * calling the LLM on files it had already declared stable.
   *
   * The postmortem for a stable file is recorded ONCE (the first time
   * we see zero-diff on it) so the next attempt gets a "make a real
   * refactor" constraint. REPEATED zero-diffs do NOT bump `attempts`
   * and do NOT rewrite the on-disk postmortem — the postmortem already
   * says "stable", and churning it every cycle just creates git noise
   * (the postmortems/<repo>/<branch>/*.json files were modified every
   * cycle in the dev log). Once is enough.
   */
  private previouslyStablePaths: Map<string, number> = new Map();
  private static readonly STABLE_FILE_COOLDOWN_CYCLES = 50;
  /** Auto-arm guard — the constructor arms the scheduler exactly once on
   *  the first instance. A hot-swap re-imports the module, creating a
   *  fresh instance, which re-arms. The re-arm respects the snapshot's
   *  `enabled` flag so a stopped loop stays stopped across a swap. */
  private autoArmed = false;
  /** STATIC auto-arm guard — across ALL instances in this process. When
   *  the globalThis pin is cleared (by a hot-swap), Turbopack may create
   *  several fresh instances before one re-pins itself. Without a
   *  static guard, each would schedule its own 2s setTimeout and they'd
   *  arm multiple timers (multiple cycles running in parallel = chaos).
   *  The static guard ensures only ONE auto-arm fires per process boot,
   *  no matter how many instances are transiently created. */
  /* ── WHY autoArmFired LIVES ON globalThis ─────────────────────────
   *
   * Static (and module-local) variables are PER Turbopack module
   * instance. Every time Turbopack recompiles + re-imports this file,
   * the fresh module gets `autoArmFired = false` again — so the static
   * guard does NOT actually guard across module generations. Each
   * re-import that constructs an instance would schedule its own 2s
   * auto-arm timer → multiple parallel continuous loops → event-loop
   * saturation → HTTP dies (the "won't load" failure mode).
   *
   * A globalThis flag is process-global: it survives module re-imports,
   * so only ONE auto-arm fires per "generation". A new generation is
   * explicitly re-enabled by the hot-swap snapshot restore below (the
   * only legitimate path that wants a second arm). This mirrors the
   * safe-mode fix (see core/duress.ts). */
  private static readonly AUTO_ARM_FLAG = "__loopAutoArmFired";
  private autoArmAlreadyFired(): boolean {
    return !!(globalThis as unknown as Record<string, boolean>)[AutonomousLoopRuntime.AUTO_ARM_FLAG];
  }
  private markAutoArmFired(): void {
    (globalThis as unknown as Record<string, boolean>)[AutonomousLoopRuntime.AUTO_ARM_FLAG] = true;
  }
  private resetAutoArmFlag(): void {
    (globalThis as unknown as Record<string, boolean>)[AutonomousLoopRuntime.AUTO_ARM_FLAG] = false;
  }

  constructor() {
    // ── Hot-swap restore ────────────────────────────────────────────
    // If a hot-swap stashed a snapshot before this constructor ran (i.e.
    // a fresh instance is being created to replace one that was paused),
    // read the snapshot + restore its state. This is what makes the
    // swap state-continuous: the new instance picks up the cycle count,
    // config, stats, and the committed/failed-path sets the old one had.
    //
    // The snapshot is NOT consumed here (consumeStashedSnapshot is a
    // peek, not a take). It stays stashed until the instance that
    // actually arms its timer calls clearStashedSnapshot. This handles
    // the Turbopack race: when the pin is cleared, multiple fresh
    // instances may be created before one re-pins itself; the snapshot
    // must survive all of them so the instance that finally arms gets
    // the state. See core/hot-swap.ts.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { consumeStashedSnapshot } = require("../core/hot-swap") as {
        consumeStashedSnapshot?: () => LoopSnapshot | null;
      };
      if (typeof consumeStashedSnapshot === "function") {
        const snap = consumeStashedSnapshot();
        if (snap) {
          if (snap.config) {
            this.config = { ...this.config, ...snap.config } as LoopConfig;
          }
          if (snap.stats) {
            this.stats = { ...this.stats, ...snap.stats };
          }
          if (Array.isArray(snap.previouslyCommittedPaths)) {
            this.previouslyCommittedPaths = new Set(snap.previouslyCommittedPaths);
          }
          if (Array.isArray(snap.previouslyFailedPaths)) {
            this.previouslyFailedPaths = new Map(snap.previouslyFailedPaths);
          }
          // Restore the stable-file cooldown map too — without this, a
          // hot-swap would lose the "this file is stable for 50 cycles"
          // state, and the next cycle would re-call the LLM on a file
          // the previous instance just declared stable (re-introducing
          // the very churn this map exists to prevent).
          if (Array.isArray(snap.previouslyStablePaths)) {
            this.previouslyStablePaths = new Map(snap.previouslyStablePaths);
          }
          // A swap happened — reset the auto-arm flag so THIS fresh
          // instance can auto-arm. Without this, the flag (set true by
          // the previous generation) would prevent the new instance
          // from arming, and the loop would stay paused after every
          // swap. This is the ONE legitimate re-arm path.
          this.resetAutoArmFlag();
          // Log the restore so the swap is visible in the loop's own log.
          this.addLog(
            `HOT-SWAP RESTORE: resumed from snapshot (cycle #${snap.stats?.totalRuns ?? 0}, ${snap.previouslyCommittedPaths?.length ?? 0} committed, ${snap.previouslyFailedPaths?.length ?? 0} failed, ${snap.previouslyStablePaths?.length ?? 0} stable). Reason: ${snap.swappableReason ?? "(none)"}`,
            "success"
          );
        }
      }
    } catch {
      /* hot-swap module not yet loaded — first boot, no snapshot */
    }

    // ── Crash-budget restore ─────────────────────────────────────────
    // The crash wall is persisted to .git/info/loop-crash-budget.json so
    // a segfault that KILLS the process and the auto-restart boots a
    // fresh instance still sees the wall. Without this restore, the
    // in-memory crashWall would reset to false on every restart and the
    // wall would never trip on a real crash loop. Fail-closed: a
    // missing/malformed file is treated as "no wall" (a fresh install
    // has no crash history).
    try {
      const persisted = readCrashBudget();
      if (persisted) {
        this.crashWall = persisted.crashWall;
        this.consecutiveCrashCount = persisted.crashWall ? 0 : persisted.count;
        this.lastCrashClass = persisted.crashWall ? "" : persisted.lastClass;
        if (persisted.crashWall) {
          this.addLog(
            `PERSISTED CRASH-WALL (tripped at ${persisted.at} after ${3} consecutive ${persisted.lastClass} cycles). Loop will NOT auto-arm — manual [START] required to clear.`,
            "warn"
          );
        }
      }
    } catch {
      /* best-effort — in-memory remains the live source */
    }

    // Auto-arm on construction. The singleton is created at module load
    // (server boot), so this starts the autonomous loop WITHOUT requiring
    // an operator to press [START]. A deferred 2-second setTimeout lets
    // the rest of the system (DB, postmortem store rehydrate, duress
    // safe-mode rehydrate) settle before the first cycle fires — otherwise
    // the first cycle can race the duress rehydrate and miss a safe-mode
    // flag that should pause it.
    // The GLOBAL auto-arm flag is the key: it survives Turbopack module
    // re-imports, so no matter how many fresh module instances are
    // transiently created, only ONE schedules an auto-arm per generation.
    // The pin check inside the timer (below) is the second guard: even if
    // two timers somehow got scheduled, only the instance that owns the
    // globalThis pin proceeds to arm.
    if (!this.autoArmAlreadyFired()) {
      this.markAutoArmFired();
      setTimeout(() => {
        try {
          // Re-check the pin: if another instance already armed + is
          // running, this one should no-op. The pin is set by the
          // singleton export below.
          const g = globalThis as unknown as { __autonomousLoopRuntime?: AutonomousLoopRuntime };
          if (g.__autonomousLoopRuntime && g.__autonomousLoopRuntime !== this) {
            // Another instance won the race. Don't arm a second timer.
            return;
          }
          // Respect config.enabled: if the operator disabled the loop
          // (default after 2026-11-03 — see the config comment above), do
          // NOT auto-arm — UNLESS the wipe-proof armed-state tier says the
          // operator armed this loop in a prior session. That persisted
          // intent is what makes "run by itself when quota is available"
          // true across restarts: re-armed here, the loop's own quota
          // machinery does the waiting (dynamic cooldown backs off to the
          // gate's end + 2s, capped 5min; the pre-tree-fetch fast-path
          // defers a gated cycle at ~0ms cost). [STOP] clears the disk
          // intent — the operator's interrupt is sticky; a quota halt
          // never disarms, a human STOP does.
          if (!this.config.enabled) {
            let disk: ArmedState | null = null;
            try {
              disk = readArmedState();
            } catch {
              disk = null; // fail-closed: unreadable ≠ armed
            }
            if (disk && disk.armed) {
              // ── Crash-wall gate ─────────────────────────────────────
              // If a prior session tripped the crash-wall (3 consecutive
              // same-class cycle crashes, persisted to .git/info/loop-
              // crash-budget.json), do NOT auto-arm even if the disk
              // says armed. The wall is STICKY — only an explicit [START]
              // (the operator's re-arm gesture) clears it. A process
              // restart that auto-rearms from disk would defeat the
              // wall's whole purpose (the segfault that killed the
              // process would, on auto-restart, silently re-arm and
              // start crashing again).
              if (this.crashWall) {
                this.addLog(
                  "Auto-arm skipped: crash-wall is tripped. The loop crashed 3 consecutive times on the same error class in a prior session. Manual [START] required to clear the wall and re-arm.",
                  "error"
                );
                this.status = "paused";
                return;
              }
              // ── Dead-man's switch ───────────────────────────────────
              // If the operator hasn't touched the system in >24h, do
              // NOT auto-arm. The dead-man's switch stops a runaway
              // loop from quietly burning API quota for days while the
              // operator is away. The operator must press [START] at
              // least once a day for the autonomy to keep running.
              // Fail-closed: an unreadable touch file is treated as
              // tripped (never fabricate a recent touch from a bad
              // read — same dual-layer contract as the armed-state).
              let deadMansTripped = false;
              try {
                deadMansTripped = isDeadMansTripped();
              } catch {
                deadMansTripped = true; // unreadable → tripped (fail-closed)
              }
              if (deadMansTripped) {
                this.deadMansTripped = true;
                this.addLog(
                  "DEAD-MAN'S SWITCH TRIPPED — last operator touch >24h ago (or no touch on record). Loop auto-arm denied. Press [START] to re-arm and refresh the touch timestamp.",
                  "warn"
                );
                this.status = "paused";
                return;
              }
              this.config.enabled = true;
              this.addLog(
                `PERSISTED ARMED STATE (armed at ${disk.at || "?"} by ${disk.by || "?"}) — auto-arming. It runs whenever the quota gate is open; [STOP] clears the intent.`,
                "success"
              );
            } else {
              this.addLog(
                "Auto-arm skipped: config.enabled is false (operator-gated mode). Press [START] or POST /api/autonomous/start to run the loop.",
                "info"
              );
              this.status = "paused";
              return;
            }
          }
          // Respect duress safe-mode: if it's raised at boot (e.g. a prior
          // session left it raised), don't auto-start. When the loop is
          // ARMED, the recovery probe below re-arms it the minute safe-mode
          // clears (60s cadence); a disarmed loop schedules nothing.
          if (typeof isSafeMode === "function" && isSafeMode()) {
            this.addLog(
              "Auto-arm deferred: safe-mode is active. Clear via /api/duress/clear to start the autonomous loop.",
              "warn"
            );
            this.status = "paused";
            if (this.config.enabled) this.scheduleRecoveryProbe();
            return;
          }
          this.addLog(
            "Autonomous loop auto-armed on boot — continuous mode, ~10s cooldown between cycles (longer while the LLM is rate-limited). Press [STOP] to pause.",
            "success"
          );
          this.restartScheduler();
        } catch (err) {
          this.addLog(`Auto-arm failed: ${(err as Error).message}`, "error");
        }
      }, 2000);
    }
  }

  // --- Token resolution (don't log the value) ---
  private resolveToken(clientToken?: string): string | null {
    // Fall through EVERY candidate in priority order, skipping empty/invalid
    // values. This used to be a `??` chain, which treats "" as a value — so
    // with the default config token of "", process.env.GITHUB_TOKEN was
    // NEVER reached and resolution always failed (audit 2, item 2).
    //
    // The 4th candidate — the push-target store — is what makes the loop
    // fully autonomous: after the operator configures the PAT via the
    // [CONFIG] panel (or the API), it's stored in the DB + the durable
    // state file. The loop reads it from there on every cycle, so it
    // doesn't need a separate `githubToken` config field to be set. This
    // closes the gap where the loop was auto-running but every cycle
    // 403'd on the GitHub tree fetch because the config token was empty.
    const candidates = [clientToken, this.config.githubToken, process.env.GITHUB_TOKEN];
    for (const candidate of candidates) {
      const value = (candidate ?? "").trim();
      if (!value || value.startsWith("MY_") || value === "undefined" || value.length < 8) {
        continue;
      }
      return value;
    }
    // Final fallback: the push-target store. Synchronous read from the
    // durable state file (no DB round-trip) so this is fast even on a
    // cold cache. If the store has a token, use it; otherwise the loop
    // runs unauthenticated and the GitHub API will 403 — surfaced as a
    // clear cycle error, not a silent failure.
    try {
      // Lazy dynamic require to avoid a circular import at module load
      // (push-target imports from pipeline modules; loop-runtime is one).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getStoredTargetSync } = require("./push-target") as {
        getStoredTargetSync?: () => { token: string } | null;
      };
      if (typeof getStoredTargetSync === "function") {
        const stored = getStoredTargetSync();
        if (stored && stored.token && stored.token.length >= 8) {
          return stored.token;
        }
      }
    } catch {
      /* push-target not yet loaded — fall through */
    }
    return null;
  }

  private addLog(
    message: string,
    type: LoopLogEntry["type"] = "info",
    source: LoopLogEntry["source"] = "autonomous"
  ) {
    const entry: LoopLogEntry = {
      timestamp: new Date().toLocaleTimeString(),
      message,
      type,
      source,
    };
    this.logs.unshift(entry);
    if (this.logs.length > 200) this.logs.pop();
    console.log(`[AUTONOMOUS:${source}] [${type.toUpperCase()}] ${message}`);
  }

  /**
   * The derived LIVE phase of the loop — see {@link LivePhase}. This is
   * a pure function of `(config.enabled, status, llmIsCoolingDown,
   * recoveryDeadlineMs, crashWall)`. The branch order matters:
   *
   *   1. DISARMED      — config.enabled is false AND no crash-wall.
   *   2. ARMED-PAUSED  — crashWall OR status==="paused" (operator STOP
   *                      is sticky; crash-wall is sticky; both require
   *                      manual [START]).
   *   3. ARMED-RECOVERING — recoveryDeadline > now (30s settle window
   *                      after a 429 gate clears, before the next cycle).
   *   4. ARMED-THROTTLED  — LLM 429 gate active (auto-pause until clear).
   *   5. ARMED-RUNNING  — armed, gate open, not paused, not recovering.
   *
   * The crash-wall check is FIRST among the armed branches so a
   * wall-tripped loop reports ARMED-PAUSED (the operator's actionable
   * state: "press [START]") even if the gate happens to also be active.
   */
  private livePhase(): LivePhase {
    // DISARMED only when the operator has NOT armed AND no sticky
    // wall is tripped. The dead-man's switch is a STICKY wall: when
    // tripped, the operator's last recorded intent was "armed", so
    // the honest report is ARMED-PAUSED (the switch silently disarmed
    // them overnight — the splash must say "press [START] to re-arm",
    // not "DISARMED" which would hide the reason).
    if (!this.config.enabled && !this.crashWall && !this.deadMansTripped) return "DISARMED";
    // Armed from here on (config.enabled OR crashWall OR deadMansTripped
    // — any of these means the operator armed at some point and a sticky
    // wall or the live config is holding the armed state).
    if (this.crashWall || this.deadMansTripped || this.status === "paused") return "ARMED-PAUSED";
    if (this.recoveryDeadlineMs > Date.now()) return "ARMED-RECOVERING";
    if (llmIsCoolingDown()) return "ARMED-THROTTLED";
    return "ARMED-RUNNING";
  }

  /** Milliseconds remaining in the ARMED-RECOVERING window. 0 when not
   *  recovering. A RELATIVE duration (not an absolute epoch) so the UI
   *  can re-anchor to its own clock skew-free — same pattern as the
   *  LLM gate's `remainingMs`. */
  private recoveryRemainingMs(): number {
    if (this.recoveryDeadlineMs <= 0) return 0;
    return Math.max(0, this.recoveryDeadlineMs - Date.now());
  }

  /** Record an operator touch to the wipe-proof tier. Called from
   *  start() / stop() / updateConfig() — the three operator gestures.
   *  Best-effort, never throws (the in-memory state is the live source;
   *  the disk file is the dead-man's-switch restart tier). */
  private markOperatorTouch(by: string): void {
    try {
      markOperatorTouch(by);
    } catch {
      /* best-effort */
    }
  }

  // --- Public API ---
  public getState(): LoopState {
    return {
      config: {
        ...this.config,
        githubToken: this.config.githubToken ? "[REDACTED]" : "",
      },
      status: this.status,
      livePhase: this.livePhase(),
      recoveryRemainingMs: this.recoveryRemainingMs(),
      stats: { ...this.stats },
      logs: [...this.logs],
      currentCycle: this.currentCycle ? { ...this.currentCycle } : null,
      recentCycles: [...this.recentCycles],
    };
  }

  public updateConfig(patch: Partial<LoopConfig>): LoopConfig {
    // An operator config PATCH counts as a "touch" for the dead-man's
    // switch — the operator is interacting with the system, so the 24h
    // auto-pause timer resets. Recorded first so a throw later in this
    // method can't lose the touch.
    this.markOperatorTouch("config-patch");
    const wasEnabled = this.config.enabled;
    const oldMode = this.config.mode;
    const oldRepo = this.config.targetRepo;
    const oldBranch = this.config.evolutionBranch;
    const oldToken = this.config.githubToken;
    this.config = { ...this.config, ...patch };
    // Keep the disk tier in sync when a caller PATCHes `enabled` directly
    // (the control panel doesn't, but the API allows it — a config-level
    // arm/disarm must not silently desync from the persisted intent).
    if (typeof patch.enabled === "boolean") {
      markArmed(patch.enabled, "config-patch");
      if (!patch.enabled && wasEnabled) {
        // Disarm via config PATCH must actually tear down the machinery.
        // (The old code only wrote the disk intent: the interval kept
        // firing full cycles that still fetched, mutated, and PUSHED
        // commits while every status surface reported "disarmed".)
        this.config.enabled = false;
        this.stopMachinery();
        this.addLog(
          "Loop DISARMED via config PATCH (enabled:false) — scheduler and continuous loop torn down.",
          "warn"
        );
      } else if (patch.enabled && !wasEnabled) {
        // Arm via config PATCH must actually arm the scheduler / spawn
        // the continuous loop (the old code only wrote the disk intent —
        // nothing ran until the next boot's auto-arm).
        this.config.enabled = true;
        this.restartScheduler();
        this.addLog(
          "Loop ARMED via config PATCH (enabled:true) — scheduler restarted.",
          "success"
        );
      }
    }
    // If the target repo or evolution branch changed, clear the committed-
    // paths cache — those commits don't apply to the new target.
    if (
      (patch.targetRepo && patch.targetRepo !== oldRepo) ||
      (patch.evolutionBranch && patch.evolutionBranch !== oldBranch)
    ) {
      this.previouslyCommittedPaths.clear();
      this.previouslyFailedPaths.clear();
      this.previouslyStablePaths.clear();
      this.addLog(
        `Cleared committed-paths + failed-paths + stable-paths caches (repo or branch changed from ${oldRepo}:${oldBranch}).`,
        "info"
      );
    }
    // If token was passed as "[REDACTED]" keep the previous one (the UI
    // re-sends the placeholder when the user didn't edit the field). The
    // API route normally strips it before calling here; this guard is
    // defense-in-depth so a future caller that bypasses the route can't
    // silently destroy the stored token with the placeholder.
    if (this.config.githubToken && patch.githubToken === "[REDACTED]") {
      this.config.githubToken = oldToken;
    }
    this.addLog(
      `Configuration updated: mode=${this.config.mode}, interval=${this.config.intervalMinutes}m, repo=${this.config.targetRepo}, autoPush=${this.config.autoPush}`,
      "info"
    );
    if (wasEnabled && this.config.enabled && oldMode !== this.config.mode) {
      this.addLog(
        `Switching loop mode from ${oldMode} to ${this.config.mode}. Restarting scheduler.`,
        "info"
      );
      this.restartScheduler();
    }
    return {
      ...this.config,
      githubToken: this.config.githubToken ? "[REDACTED]" : "",
    };
  }

  public start(): LoopState {
    if (this.config.enabled && this.status !== "paused" && !this.crashWall) {
      this.addLog("Loop already enabled.", "info");
      return this.getState();
    }
    this.config.enabled = true;
    // ── [START] is the ONE gesture that clears the crash-wall ──────────
    // The wall is STICKY: no boot, probe, or quota event re-arms from
    // it. The operator pressing [START] is the explicit re-arm gesture
    // — it clears the wall, resets the in-memory crash count, and
    // resets the disk tier so a subsequent process restart sees a
    // clean budget. This is the single path that releases ARMED-PAUSED
    // (the crash-wall variant) back to ARMED-RUNNING.
    if (this.crashWall) {
      this.crashWall = false;
      this.consecutiveCrashCount = 0;
      this.lastCrashClass = "";
      resetCrashBudget();
      this.addLog(
        "Crash-wall CLEARED by operator [START]. Budget reset; the loop resumes from a clean crash slate.",
        "success"
      );
    }
    // ── [START] also clears the dead-man's switch ────────────────────
    // The dead-man's switch is a STICKY wall (same release path as the
    // crash-wall). The operator pressing [START] refreshes the touch
    // timestamp AND clears the tripped flag — the loop re-arms.
    if (this.deadMansTripped) {
      this.deadMansTripped = false;
      this.addLog(
        "Dead-man's switch CLEARED by operator [START]. Touch timestamp refreshed; the loop resumes.",
        "success"
      );
    }
    // Persist the armed intent to the wipe-proof tier — this is what
    // makes [START] a ONE-TIME ritual: every subsequent process boot
    // re-arms from disk (see the constructor's auto-arm). Best-effort,
    // never throws (in-memory remains the live source; disk is the
    // restart tier).
    markArmed(true, "operator-start");
    // ── Dead-man's switch: [START] refreshes the touch timestamp ────
    // The 24h auto-pause timer resets on every operator gesture. This
    // is the gesture that LEGITIMIZES continued autonomy — record it
    // first so a throw later in this method can't lose the touch.
    this.markOperatorTouch("operator-start");
    // Clear any stale recovery deadline — a re-arm starts a fresh cycle,
    // not a recovery window.
    this.recoveryDeadlineMs = 0;
    // Kill any pending recovery probe — [START] is the explicit gesture,
    // so a probe scheduled by an earlier pause must not fire later and
    // spawn a SECOND scheduler alongside the one restartScheduler() arms
    // below.
    if (this.recoveryProbeTimer) {
      clearTimeout(this.recoveryProbeTimer);
      this.recoveryProbeTimer = null;
    }
    this.status = "idle";
    this.addLog(
      `Autonomous loop ENABLED in ${this.config.mode.toUpperCase()} mode. First run scheduled in ${this.config.intervalMinutes} minute(s). Armed state persisted — it survives restarts.`,
      "success"
    );
    this.restartScheduler();
    return this.getState();
  }

  public stop(): LoopState {
    this.config.enabled = false;
    // Clear the persisted intent — [STOP] is the operator's interrupt and
    // it is STICKY: no boot, probe, or quota event may re-arm after a
    // human stop. Only an explicit [START] writes armed:true again.
    markArmed(false, "operator-stop");
    // ── Dead-man's switch: [STOP] also counts as a touch ─────────────
    // The operator is interacting with the system, so the 24h auto-pause
    // timer resets. (A [STOP] followed by 25h of silence would NOT trip
    // the dead-man's switch on the next [START] — the [STOP] itself
    // refreshed the touch. This is correct: the operator who pressed
    // [STOP] demonstrably knows the loop exists.)
    this.markOperatorTouch("operator-stop");
    // Clear the recovery deadline so a re-arm doesn't think it's mid-
    // recovery. Same reasoning as start() — a re-arm starts a fresh
    // cycle, not a recovery window.
    this.recoveryDeadlineMs = 0;
    this.stopMachinery();
    this.addLog(
      "Autonomous loop DISABLED. No further cycles will run until re-enabled. Armed state cleared — this stop is sticky across restarts.",
      "warn"
    );
    return this.getState();
  }

  public async triggerManual(): Promise<{ started: boolean; cycleId: string | null }> {
    this.addLog("Manual trigger received. Starting one-shot autonomous cycle...", "info");
    const cycle = await this.executeCycle("manual");
    return { started: !!cycle, cycleId: cycle?.id ?? null };
  }

  private restartScheduler() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Invalidate any continuous loop from a previous scheduling round.
    // (The old code only flipped continuousLoopRunning false→true
    // synchronously — a mid-await old loop re-checked the flag AFTER the
    // new spawn set it true again, so BOTH loops ran.)
    this.continuousLoopGeneration++;
    this.continuousLoopRunning = false;
    if (!this.config.enabled) {
      this.status = "paused";
      this.stats.nextRunAt = null;
      return;
    }
    // ── Consume the hot-swap snapshot NOW ──────────────────────────
    // This is the moment the instance actually arms. The snapshot was
    // stashed by a swap + survived transient instances; this instance
    // is the one that persists, so it claims + clears the snapshot.
    // See core/hot-swap.ts clearStashedSnapshot.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { clearStashedSnapshot } = require("../core/hot-swap") as {
        clearStashedSnapshot?: () => void;
      };
      if (typeof clearStashedSnapshot === "function") clearStashedSnapshot();
    } catch {
      /* hot-swap module not yet loaded */
    }
    const ms = Math.max(15_000, this.config.intervalMinutes * 60 * 1000);
    this.status = "idle";
    this.stats.nextRunAt = new Date(Date.now() + ms).toISOString();
    // Audit 3 (F16): in continuous mode, do NOT also arm the setInterval
    // scheduler — the continuous while-loop already drives cycles with
    // dynamic pacing (LLM-gate-aware), and the interval double-scheduled
    // cycles that bypassed that pacing. The `status === "running"` guard
    // in executeCycle prevented overlap, but two schedulers interleaved
    // cycle accounting for no benefit. Interval scheduling stays for the
    // scheduled/one-shot modes only.
    if (this.config.mode !== "continuous") {
      this.addLog(`Scheduler armed. Next automatic cycle at ${this.stats.nextRunAt}`, "info");
      this.timer = setInterval(() => {
        this.executeCycle(this.config.mode).catch((err) => {
          this.addLog(`Scheduler cycle failed: ${(err as Error).message}`, "error");
        });
      }, ms);
    }

    if (this.config.mode === "continuous") {
      const myGen = this.continuousLoopGeneration;
      this.continuousLoopRunning = true;
      this.runContinuousLoop(myGen).catch((err) => {
        this.addLog(`Continuous loop crashed: ${(err as Error).message}`, "error");
      });
    }
  }

  private async runContinuousLoop(myGen: number) {
    // The continuous loop is the heart of "fully autonomous". It MUST
    // NOT die on a single cycle crash — a bug in one cycle (a thrown
    // error inside executeCycle's internals, an OOM in the LLM call,
    // a transient DB hiccup) must not permanently stop the system.
    // The cycle itself already catches its own errors, but a defensive
    // try/catch around the whole loop body guarantees a future refactor
    // can't accidentally make one uncaught throw kill the loop forever.
    //
    // GENERATION TOKEN: the while condition also requires the captured
    // generation to match. restartScheduler() bumps the generation before
    // spawning a successor, so an old loop parked in an await exits at
    // its next checkpoint instead of resurrecting alongside the new one.
    //
    // DYNAMIC COOLDOWN: the base cooldown is 10s, but when the LLM is
    // rate-limited (429 gate active), the cooldown extends to avoid
    // hammering the API. Without this, the loop starts a new cycle every
    // 10s even while the LLM gate is on a 150s cooldown — each cycle
    // immediately hits the gate, returns "deferred", and the loop tries
    // again 10s later. That saturates the event loop (every cycle does
    // a GitHub tree fetch + 3 file reads + gate check before deferring)
    // and the HTTP server stops responding to requests. With the backoff,
    // the loop waits for the gate to clear before starting the next cycle.
    //
    // CRASH BUDGET: a single thrown cycle is tolerated (the catch logs
    // and continues — the "never-stop" guarantee). But 3 consecutive
    // cycles throwing the SAME error class trip the crash-wall: the loop
    // transitions to ARMED-PAUSED and persists the wall to
    // .git/info/loop-crash-budget.json so a process restart doesn't
    // silently reset the count and re-arm into the same crash loop.
    // Different error classes reset the count — a network blip followed
    // by a segfault is 2 different problems, not a pattern. The wall is
    // STICKY: only an explicit [START] clears it (see start()).
    //
    // ARMED-RECOVERING: when the LLM 429 gate transitions from active →
    // clear, the loop does NOT immediately fire the next cycle. It enters
    // a 30s settle window (RECOVERY_SETTLE_MS) so the provider has a
    // clean slate — firing the exact moment the gate opens often re-429s
    // immediately. The UI shows a live countdown via recoveryRemainingMs.
    let wasThrottled = false;
    while (
      this.continuousLoopRunning &&
      this.continuousLoopGeneration === myGen &&
      this.config.enabled &&
      this.config.mode === "continuous" &&
      !this.crashWall
    ) {
      try {
        // ── ARMED-RECOVERING settle window ─────────────────────────
        // If we just came out of a throttle, hold for 30s before the
        // next cycle. The transition is detected by `wasThrottled && !nowThrottled`.
        // The deadline is set ONCE (when the transition fires); subsequent
        // iterations just check it. While recovering, skip executeCycle
        // and wait out the remaining window.
        const nowThrottled = llmIsCoolingDown();
        if (
          wasThrottled &&
          !nowThrottled &&
          this.recoveryDeadlineMs <= Date.now()
        ) {
          this.recoveryDeadlineMs = Date.now() + AutonomousLoopRuntime.RECOVERY_SETTLE_MS;
          this.addLog(
            `Quota reset — entering ARMED-RECOVERING for ${AutonomousLoopRuntime.RECOVERY_SETTLE_MS / 1000}s before the next cycle (avoids immediate re-429).`,
            "info"
          );
        }
        wasThrottled = nowThrottled;
        if (this.recoveryDeadlineMs > Date.now()) {
          // Still in the recovery window — wait it out, then loop.
          const waitMs = Math.min(
            AutonomousLoopRuntime.RECOVERY_SETTLE_MS,
            this.recoveryDeadlineMs - Date.now() + 100
          );
          await new Promise((r) => setTimeout(r, waitMs));
          // After the wait, the deadline has passed → next iteration
          // falls through to executeCycle. Skip this iteration's
          // executeCycle + cooldown entirely.
          continue;
        }
        const cycle = await this.executeCycle("continuous");
        if (!cycle) {
          // executeCycle returned null — either another cycle is already
          // running (rare in continuous mode) OR safe-mode paused it.
          // Don't break the loop; just cool down and try again next tick.
          // The safe-mode recovery probe (below) handles auto-resume.
        } else if (cycle.status === "halted") {
          this.addLog(
            "Continuous loop halted by governor (saturation or failure limit reached). Pausing — recovery probe will resume when conditions improve.",
            "warn"
          );
          this.status = "paused";
          if (this.continuousLoopGeneration === myGen) this.continuousLoopRunning = false;
          this.scheduleRecoveryProbe();
          return;
        }
      } catch (err) {
        // ── Crash-budget accounting ─────────────────────────────────
        // A throw escaping executeCycle is a real bug (executeCycle has
        // its own try/catch around the cycle body, so something escaped
        // THAT — typically a native crash or a bug in the catch itself).
        // Tolerated once or twice; 3 consecutive SAME-CLASS crashes trip
        // the wall. Different error classes reset the count.
        const errClass = (err as Error)?.name || (err as Error)?.constructor?.name || "Error";
        if (errClass === this.lastCrashClass) {
          this.consecutiveCrashCount++;
        } else {
          this.consecutiveCrashCount = 1;
          this.lastCrashClass = errClass;
        }
        const msg = (err as Error).message || String(err);
        if (this.consecutiveCrashCount >= 3) {
          // ── CRASH-WALL TRIPPED ──────────────────────────────────────
          // Persist the wall to the wipe-proof tier so a process restart
          // (or auto-restart after a segfault) doesn't silently reset
          // the count and re-arm into the same crash loop. Disarm the
          // loop AND mark the wall — the operator must press [START] to
          // clear it (the single legitimate release path).
          this.crashWall = true;
          this.config.enabled = false;
          markArmed(false, "crash-budget");
          const wallState = {
            count: this.consecutiveCrashCount,
            lastClass: this.lastCrashClass,
            at: new Date().toISOString(),
            crashWall: true,
          };
          writeCrashBudget(wallState);
          this.addLog(
            `CRASH BUDGET EXHAUSTED — ${this.consecutiveCrashCount} consecutive ${this.lastCrashClass} cycles (last: ${msg.slice(0, 120)}). Loop ARMED-PAUSED. Manual [START] required to clear the wall.`,
            "error"
          );
          this.status = "paused";
          if (this.continuousLoopGeneration === myGen) this.continuousLoopRunning = false;
          if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
          }
          if (this.recoveryProbeTimer) {
            clearTimeout(this.recoveryProbeTimer);
            this.recoveryProbeTimer = null;
          }
          return; // exit the while loop — wall is sticky, no re-arm here
        }
        // Persist the running budget so a restart sees the count.
        writeCrashBudget({
          count: this.consecutiveCrashCount,
          lastClass: this.lastCrashClass,
          at: new Date().toISOString(),
          crashWall: false,
        });
        this.addLog(
          `Cycle threw (continuous loop survived, crash budget ${this.consecutiveCrashCount}/3 ${errClass}): ${msg}`,
          "error"
        );
      }
      // Dynamic cooldown: check the LLM rate-limit gate (STATIC import —
      // reliable under Turbopack, unlike the old dynamic require() whose
      // silent interop failure meant the backoff never triggered). Base
      // cooldown is 10s — cycles themselves take 10–60s, so this barely
      // affects throughput but keeps the event loop responsive for HTTP.
      let cooldownMs = 10_000;
      try {
        if (llmIsCoolingDown()) {
          const remaining = llmCooldownMs();
          // Wait until the gate clears. Cap at 5min so a stuck gate
          // doesn't pause the loop forever.
          cooldownMs = Math.min(Math.max(remaining + 2000, 5000), 300000);
          this.addLog(
            `LLM rate-limit gate active — backing off ${(cooldownMs / 1000).toFixed(0)}s before next cycle (HTTP server freed up).`,
            "warn"
          );
        }
      } catch {
        /* gate check failed — use base cooldown */
      }
      await new Promise((r) => setTimeout(r, cooldownMs));
    }
    // Only the CURRENT generation may clear the flag — a stale loop
    // exiting here (after restartScheduler spawned its successor) must
    // not kill the successor's flag.
    if (this.continuousLoopGeneration === myGen) {
      this.continuousLoopRunning = false;
    }
  }

  /** Tear down all scheduling machinery: interval, continuous loop
   *  (generation bump + flag), recovery probe, and the in-flight cycle
   *  generation. Shared by stop() and config-PATCH disarm so both paths
   *  cannot drift apart. Does NOT touch armed-state tiers or logs. */
  private stopMachinery(): void {
    this.status = "paused";
    this.stats.nextRunAt = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // External audit F2: bump the cycle generation so an executeCycle()
    // currently in flight sees the STOP at its next per-file / pre-commit
    // checkpoint and aborts — the scheduler clear above only stops FUTURE
    // cycles, it cannot reach into a running one.
    this.cycleGeneration++;
    // Also kill any pending recovery probe. Without this, a stopped
    // instance's probe could fire later and re-arm ITS scheduler — a
    // zombie loop running in parallel with whichever instance the
    // operator (or a hot-swap) actually started.
    if (this.recoveryProbeTimer) {
      clearTimeout(this.recoveryProbeTimer);
      this.recoveryProbeTimer = null;
    }
    this.continuousLoopGeneration++;
    this.continuousLoopRunning = false;
  }

  /** Recovery probe — when the loop pauses (safe-mode OR governor halt),
   *  schedule a one-shot probe that re-checks the pause condition after
   *  a cooldown. If the condition cleared (safe-mode cleared, or the
   *  governor's saturation/timeout reset), the probe re-arms the
   *  scheduler so the loop auto-resumes. This is the "never-stop"
   *  guarantee: the system pauses when it must, then tries again. */
  private recoveryProbeTimer: NodeJS.Timeout | null = null;
  private scheduleRecoveryProbe(): void {
    if (this.recoveryProbeTimer) return; // already scheduled
    const RECOVERY_PROBE_MS = 60_000; // 1 minute — coarse to be gentle
    this.addLog(
      `Recovery probe scheduled in ${RECOVERY_PROBE_MS / 1000}s — will auto-resume if safe-mode clears.`,
      "info"
    );
    this.recoveryProbeTimer = setTimeout(() => {
      this.recoveryProbeTimer = null;
      try {
        if (!this.config.enabled) {
          // Operator stopped it. Don't auto-resume.
          this.addLog("Recovery probe: loop disabled by operator — not resuming.", "info");
          return;
        }
        if (isSafeMode()) {
          // Still in safe-mode. Schedule another probe.
          this.addLog("Recovery probe: safe-mode still active — re-probing in 60s.", "info");
          this.scheduleRecoveryProbe();
          return;
        }
        // Safe-mode cleared (or was never the reason). Re-arm.
        this.addLog(
          "Recovery probe: conditions clear — re-arming autonomous loop.",
          "success"
        );
        this.restartScheduler();
      } catch (err) {
        this.addLog(`Recovery probe failed: ${(err as Error).message}`, "error");
        // Try again — the probe is the never-stop guarantee.
        this.scheduleRecoveryProbe();
      }
    }, RECOVERY_PROBE_MS);
  }

  private async executeCycle(mode: LoopMode): Promise<AutonomousCycleState | null> {
    if (this.status === "running") {
      this.addLog("Skipping cycle — another cycle already running.", "warn");
      return null;
    }
    // External audit F2: capture the STOP generation for this cycle. stop()
    // increments it; the per-file and pre-commit checkpoints below compare
    // against it so an in-flight cycle is interruptible, not just the
    // scheduler. (See the cycleGeneration field docs for why a generation
    // counter rather than config.enabled: manual triggers must still work
    // while the loop is stopped.)
    const myGen = this.cycleGeneration;
    // ── LLM rate-limit fast-path (pre-tree-fetch) ────────────────────
    // If the LLM gate is already active, defer BEFORE the expensive part
    // of a cycle (GitHub tree fetch over ~667 entries + branch checks +
    // file reads). Previously the gate was only consulted AFTER the cycle
    // (in the continuous loop's cooldown), so a gated cycle still burned
    // several seconds of fetch work before deferring — back-to-back gated
    // cycles were the exact cause of the event-loop saturation that made
    // the site unreachable. Deferring here costs ~0ms. Manual triggers
    // bypass this: the operator asked for a cycle, so give them one (the
    // per-file gates will defer individual LLM calls as needed).
    if (mode !== "manual" && llmIsCoolingDown()) {
      const remaining = Math.ceil(llmCooldownMs() / 1000);
      this.addLog(
        `Cycle deferred — LLM rate-limit gate active (${remaining}s remaining). Skipping tree fetch.`,
        "warn"
      );
      return null;
    }
    // ── Safe-mode gate (concept: PKM duress / GRAFT 2) ──────────────
    // If the duress protocol OR the red-team suite has raised safe-mode,
    // the loop REFUSES to run any further cycles — no mutate, no push.
    // The operator must clear it via /api/duress/clear after verifying
    // the situation. This is the HALT step of the PKM §3 sequence: the
    // autonomous loop's own work is what the purge protects against.
    if (isSafeMode()) {
      const state = await getSafeModeState();
      const by = state.setBy ?? "unknown";
      const reason = state.reason ?? "(no reason recorded)";
      this.addLog(
        `SAFE-MODE ACTIVE — cycle skipped. Raised by ${by}: ${reason}. ` +
        `Clear via /api/duress/clear after verifying the situation.`,
        "error"
      );
      this.status = "paused";
      // Schedule a recovery probe so the loop auto-resumes when safe-mode
      // clears (operator cleared it, or the duress module auto-cleared
      // after a successful probe). Without this, a safe-mode event would
      // permanently stop the loop until a manual [START] — which violates
      // "fully autonomous".
      this.scheduleRecoveryProbe();
      return null;
    }
    this.status = "running";
    this.stats.totalRuns++;
    const cycleId = `cycle_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const cycleNumber = this.stats.totalRuns;
    const startedAt = new Date().toISOString();

    this.currentCycle = {
      id: cycleId,
      cycleNumber,
      mode,
      targetRepo: this.config.targetRepo,
      branch: this.config.branch,
      startedAt,
      filesScanned: 0,
      filesCommitted: 0,
      status: "running",
      fileResults: [],
    };

    this.addLog(
      `Starting autonomous cycle #${cycleNumber} (${mode}) on ${this.config.targetRepo}:${this.config.branch}`,
      "info"
    );

    const token = this.resolveToken();
    const headers: Record<string, string> = {
      "User-Agent": "Architecture-Helper-Pipeline",
      Accept: "application/vnd.github.v3+json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    let cycleStatus: AutonomousCycleState["status"] = "completed";
    let cycleProofHash: string | null = null;
    // The tree fingerprint is committed to stats ONLY when the cycle
    // finishes non-error. (The old code wrote it immediately after the
    // unchanged-check, BEFORE the per-file work — a mid-cycle crash then
    // made every later watch cycle see "fingerprint unchanged" and skip,
    // permanently swallowing the crashed cycle's files until the remote
    // tree changed again.)
    let completedFingerprint: string | null = null;

    try {
      // 1. Fetch repo tree (recursive)
      const treeUrl = `https://api.github.com/repos/${this.config.targetRepo}/git/trees/${this.config.branch}?recursive=1`;
      let treeRes = await fetch(treeUrl, { headers });
      if (!treeRes.ok && this.config.branch === "main") {
        const altUrl = `https://api.github.com/repos/${this.config.targetRepo}/git/trees/master?recursive=1`;
        treeRes = await fetch(altUrl, { headers });
      }
      if (!treeRes.ok) {
        throw new Error(`GitHub tree fetch failed (${treeRes.status})`);
      }
      const treeData = (await treeRes.json()) as {
        tree: Array<{ path: string; type: string; sha: string; size?: number }>;
      };
      const tree = treeData.tree ?? [];

      // Compute tree fingerprint
      const fp = this.computeTreeFingerprint(tree);
      if (this.config.mode === "watch" && this.stats.lastTreeFingerprint === fp) {
        this.addLog(
          `Watch mode: tree fingerprint unchanged (${fp}). Skipping cycle — no remote changes detected.`,
          "info"
        );
        cycleStatus = "halted";
        // NOTE: no finalizeCycle() call here — the try/finally below is
        // the SINGLE finalize point. The old code called finalizeCycle()
        // explicitly on this path, so the finally block ran it a second
        // time: the same cycle was double-inserted into recentCycles
        // (the second DB insert failed on the duplicate id, but the
        // in-memory list kept both copies).
        return this.currentCycle!;
      }
      // Capture for the completed path only — stats.lastTreeFingerprint
      // is committed AFTER the per-file work succeeds (see below).
      completedFingerprint = fp;
      this.addLog(`Tree fingerprint computed: ${fp} (${tree.length} entries)`, "info");

      // 2. Filter to REAL code files only. The LLM cannot meaningfully
      //    refactor markdown, JSON, YAML, shell, SQL, HTML, or CSS — running
      //    it on those files produces cosmetic comment injection that the
      //    0-diff saturation check then halts on, wasting LLM API calls.
      //    Only include languages where the LLM can extract constants,
      //    add type annotations, modularize, etc.
      const codeExtRegex = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|c|cpp|cc|cs)$/i;
      // audit 5 — ZERO_DIFF_SATURATION wall: the prior `ignored` regex
      // admitted scripts/, build-guide/, proxy/, mini-services/, and
      // top-level config stubs (next.config.ts, next-env.d.ts, postcss/
      // eslint configs). The deep investigation (audit 5) found 100% of
      // zero-diff postmortems are in this autonomous-loop path, and the
      // top zero-diff files (scripts/q.ts: 14 attempts, scripts/check-
      // llm.ts, next-env.d.ts, build-guide/*.py) are GENUINELY FINISHED —
      // 8-16 lines, correct, no bugs, no missing error handling. The
      // LLM correctly returns them unchanged; the loop was just feeding
      // it trivial files. Excluding these paths means the loop spends
      // its maxFilesPerCycle budget on substantive code where a real
      // refactor is possible. Config stubs (next.config, postcss, eslint,
      // tailwind, tsconfig) are also excluded — they're declarative
      // configs with no business logic to refactor.
      const ignored = /^(node_modules|\.git|\.next|dist|build|coverage|public\/assets|vendor|third_party|\.agents|docs?|examples?|scripts|build-guide|proxy|mini-services)\//i;
      const ignoredFiles = /^(next-env\.d\.ts|next\.config\.(ts|js|mjs)|postcss\.config\.(mjs|js|ts)|eslint\.config\.(mjs|js|ts)|tailwind\.config\.(ts|js|mjs)|tsconfig\.json|prettier\.config\.(js|mjs|ts)|\.env\.example|package\.json|bun\.lock|bun\.lockb)$/i;
      // Hard cap on files per cycle — prevents runaway LLM API costs.
      const effectiveMaxFiles = Math.min(this.config.maxFilesPerCycle, 500);
      // Skip files already committed in prior cycles so each cycle makes
      // forward progress through large repos.
      const alreadyCommitted = this.previouslyCommittedPaths;
      // Skip files that failed recently (cooldown) so the loop doesn't
      // get stuck retrying an un-improvable file every cycle. A file that
      // failed >= FAILED_FILE_COOLDOWN_CYCLES ago is re-tried.
      //
      // ALSO skip files declared stable recently (zero-diff saturation).
      // Stable files get a LONG cooldown (STABLE_FILE_COOLDOWN_CYCLES,
      // 50) — see previouslyStablePaths for why. The two cooldowns are
      // independent: a stable file is not a failure, and a failed file
      // is not stable. A file in EITHER map is skipped until its cooldown
      // expires.
      const currentCycleNum = this.stats.totalRuns;
      const cooledDown = (path: string): boolean => {
        const failedAt = this.previouslyFailedPaths.get(path);
        if (
          failedAt !== undefined &&
          currentCycleNum - failedAt < AutonomousLoopRuntime.FAILED_FILE_COOLDOWN_CYCLES
        ) {
          return false;
        }
        const stableAt = this.previouslyStablePaths.get(path);
        if (
          stableAt !== undefined &&
          currentCycleNum - stableAt < AutonomousLoopRuntime.STABLE_FILE_COOLDOWN_CYCLES
        ) {
          return false;
        }
        return true;
      };
      const codeBlobs = tree
        .filter(
          (item) =>
            item.type === "blob" &&
            codeExtRegex.test(item.path) &&
            !ignored.test(item.path) &&
            !ignoredFiles.test(item.path) &&
            !alreadyCommitted.has(item.path) &&
            cooledDown(item.path)
        )
        .slice(0, effectiveMaxFiles);

      this.currentCycle!.filesScanned = codeBlobs.length;
      this.stats.totalFilesScanned += codeBlobs.length;
      this.addLog(
        `Selected ${codeBlobs.length} code file(s) for pipeline processing (${alreadyCommitted.size} already committed, ${this.previouslyFailedPaths.size} in failed-cooldown, ${this.previouslyStablePaths.size} in stable-cooldown — all skipped).`,
        "info"
      );

      // 2.5. Ensure the evolution branch exists before we try to commit to it.
      //     If the branch doesn't exist, create it from the source branch's HEAD.
      //     This prevents 404 "branch not found" errors on the commit PUT.
      if (token && this.config.autoPush && this.config.evolutionBranch !== this.config.branch) {
        try {
          const branchCheckUrl = `https://api.github.com/repos/${this.config.targetRepo}/git/ref/heads/${this.config.evolutionBranch}`;
          const branchCheckRes = await fetch(branchCheckUrl, { headers });
          if (!branchCheckRes.ok && branchCheckRes.status === 404) {
            // Branch doesn't exist — create it from source branch HEAD
            const sourceRefUrl = `https://api.github.com/repos/${this.config.targetRepo}/git/ref/heads/${this.config.branch}`;
            const sourceRefRes = await fetch(sourceRefUrl, { headers });
            if (sourceRefRes.ok) {
              const sourceRefData = (await sourceRefRes.json()) as { object?: { sha?: string } };
              const sourceSha = sourceRefData.object?.sha;
              if (sourceSha) {
                const createBranchRes = await fetch(
                  `https://api.github.com/repos/${this.config.targetRepo}/git/refs`,
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${token}`,
                      "Content-Type": "application/json",
                      "User-Agent": "Architecture-Helper-Pipeline",
                      Accept: "application/vnd.github.v3+json",
                    },
                    body: JSON.stringify({
                      ref: `refs/heads/${this.config.evolutionBranch}`,
                      sha: sourceSha,
                    }),
                  }
                );
                if (createBranchRes.ok) {
                  this.addLog(
                    `Created evolution branch '${this.config.evolutionBranch}' from ${this.config.branch} (${sourceSha.slice(0, 7)}).`,
                    "success",
                    "github"
                  );
                } else {
                  const errBody = await createBranchRes.json().catch(() => ({}));
                  this.addLog(
                    `Failed to create evolution branch: ${(errBody as { message?: string })?.message ?? `HTTP ${createBranchRes.status}`}`,
                    "warn",
                    "github"
                  );
                }
              }
            } else {
              this.addLog(
                `Could not resolve source branch '${this.config.branch}' to create evolution branch (HTTP ${sourceRefRes.status}).`,
                "warn",
                "github"
              );
            }
          } else if (branchCheckRes.ok) {
            this.addLog(
              `Evolution branch '${this.config.evolutionBranch}' already exists.`,
              "info",
              "github"
            );
          }
        } catch (err) {
          this.addLog(
            `Branch creation check failed: ${(err as Error).message}`,
            "warn",
            "github"
          );
        }
      }

      // 3. For each file: fetch content, run pipeline, optionally commit
      let committed = 0;
      let halted = false;
      for (const blob of codeBlobs) {
        if (halted) break;
        // External audit F2 — per-file STOP checkpoint: [STOP] pressed
        // during a previous file's pipeline run bumps cycleGeneration; stop
        // here instead of fetching and LLM-processing more files.
        if (myGen !== this.cycleGeneration) {
          this.addLog("STOP mid-cycle — aborting remaining files (in-flight cycle interrupted)", "warn");
          halted = true;
          // Record the operator interrupt honestly — the cycle did NOT
          // run to completion, so the DB row / recent-cycles must not say
          // "completed".
          cycleStatus = "halted";
          break;
        }
        try {
          const fileUrl = `https://api.github.com/repos/${this.config.targetRepo}/contents/${blob.path}?ref=${this.config.branch}`;
          const fileRes = await fetch(fileUrl, { headers });
          if (!fileRes.ok) {
            this.addLog(`Failed to fetch ${blob.path} (${fileRes.status}). Skipping.`, "warn");
            continue;
          }
          const fileData = (await fileRes.json()) as { content?: string; sha: string };
          const rawContent = fileData.content
            ? Buffer.from(fileData.content, "base64").toString("utf-8")
            : "";

          // Run pipeline
          const report = await unifiedPipelineRunnerInstance.runPipeline(
            {
              githubToken: token ?? undefined,
              targetRepo: this.config.targetRepo,
              targetBranch: this.config.branch,
              evolutionBranch: this.config.evolutionBranch,
              filePath: blob.path,
              userPrompt: this.config.userPrompt,
              siphonSourceId: this.config.siphonSourceId,
              code: rawContent,
              triggeredBy: mode,
            }
          );

          // Record pipeline run in DB (best-effort)
          try {
            await db.pipelineRun.create({
              data: {
                pipelineId: report.id,
                targetRepo: this.config.targetRepo,
                targetBranch: this.config.branch,
                evolutionBranch: this.config.evolutionBranch,
                filePath: blob.path,
                userPrompt: this.config.userPrompt,
                siphonSourceId: this.config.siphonSourceId,
                status: report.status,
                astScore: report.astDiffResult.astScore,
                consensus: report.reviewVerdict.consensus,
                proofHash: report.proofCommitHash,
                // audit 4 — grow-only sweep: cap code blobs at 20 KB to match
                // the manual /api/pipeline/run path (route.ts:60-61). The
                // previous 200 KB cap was a copy-paste mistake when the
                // autonomous write path was added — the comment at
                // route.ts:58 says "the full code lives in git history
                // anyway", and 200 KB × many rows/cycle was a 178 MB-waiting-
                // to-happen regression. The full evolved code is recoverable
                // from the loop-NN branch the cycle pushed to.
                originalCode: report.originalCode.slice(0, 20000),
                evolvedCode: report.evolvedCode.slice(0, 20000),
                sanitizerClean: report.sanitizerResult.clean,
                violations: JSON.stringify(report.sanitizerResult.violations),
                triggeredBy: mode,
              },
            });
            // audit 4 — grow-only sweep: prune PipelineRun AFTER each
            // autonomous write (best-effort, fire-and-forget). The manual
            // route prunes to 25; the autonomous path ran with NO prune at
            // all, so every cycle permanently added rows. Keep 50 (2× the
            // manual cap) since autonomous cycles fire more often — a 25-row
            // window would age out within hours. See retention.ts.
            void prunePipelineRuns(50);
          } catch (err) {
            this.addLog(`DB write failed for ${blob.path}: ${(err as Error).message}`, "warn");
          }

          let pushed = false;
          // Decompose the gate decision into its constituent parts so we can
          // log the ACTUAL reason a commit was skipped, instead of lumping
          // everything under "Gates failed".
          const astPassed = report.astDiffResult.passed;
          const reviewApproved =
            report.reviewVerdict.consensus === "APPROVED" ||
            report.reviewVerdict.consensus === "CONDITIONAL_APPROVAL";
          const haltReason = report.haltState?.reason;
          const haltShouldHalt = !!report.haltState?.shouldHalt;
          // 0-diff saturation means the LLM produced no semantic change —
          // there is literally nothing to commit, so this is NOT a failure.
          const isZeroDiffSaturation = haltReason === "ZERO_DIFF_SATURATION";
          // Real gates passed = AST + review both green AND not halted by
          // a non-saturation reason (max cycles, consecutive failures).
          const gatesPassed = astPassed && reviewApproved && !haltShouldHalt;
          // We only commit when there IS a real change to push.
          const hasRealChange = !isZeroDiffSaturation;

          if (gatesPassed && hasRealChange && this.config.autoPush && token) {
            // External audit F2 — pre-commit STOP checkpoint: the pipeline
            // run above takes tens of seconds; a [STOP] that landed during
            // it must still prevent THIS file's remote commit.
            if (myGen !== this.cycleGeneration) {
              this.addLog(`STOP mid-cycle — skipping GitHub commit for ${blob.path} (gates had passed, but the operator interrupted)`, "warn");
              halted = true;
              cycleStatus = "halted";
              continue;
            }
            const pushResult = await this.putFileWithToctouRetry({
              token,
              filePath: blob.path,
              rawContent,
              evolvedCode: report.evolvedCode,
              baseSha: fileData.sha,
              cycleId,
              cycleNumber,
              proofHash: report.proofCommitHash,
              astScore: report.astDiffResult.astScore,
            });
            if (pushResult.pushed) {
              pushed = true;
              committed++;
              // Track this path so future cycles skip it.
              this.previouslyCommittedPaths.add(blob.path);
              this.addLog(
                `Pushed ${blob.path} → ${this.config.evolutionBranch} (proof ${report.proofCommitHash})${pushResult.toctouHealed ? " [TOCTOU-healed]" : ""}`,
                "success",
                "github"
              );
            } else if (pushResult.skippedDueToRemoteChange) {
              // Already logged inside the helper — the next cycle will
              // fetch the fresh remote content and refactor it anew.
            } else {
              this.addLog(
                `Commit failed for ${blob.path}: ${pushResult.error ?? "unknown"}`,
                "error",
                "github"
              );
            }
          } else if (!astPassed) {
            this.addLog(
              `Skipping ${blob.path}: AST gate failed (score ${report.astDiffResult.astScore}/100, violations: ${report.astDiffResult.violations.map(v => v.code).join(",") || "none"}).`,
              "warn"
            );
          } else if (!reviewApproved) {
            this.addLog(
              `Skipping ${blob.path}: Review tribunal rejected (${report.reviewVerdict.consensus}, coefficient ${(report.reviewVerdict.consensusCoefficient * 100).toFixed(0)}%).`,
              "warn"
            );
          } else if (isZeroDiffSaturation) {
            this.addLog(
              `No change for ${blob.path}: LLM produced no semantic diff (0-diff saturation). Nothing to commit.`,
              "info"
            );
          } else if (haltShouldHalt) {
            this.addLog(
              `Skipping ${blob.path}: Halt governor engaged (${haltReason}: ${report.haltState?.detail ?? ""}).`,
              "warn"
            );
            // Only halt the cycle for non-saturation reasons.
            halted = true;
            cycleStatus = "halted";
          } else if (!token) {
            this.addLog(
              `No GitHub token available — would have pushed ${blob.path} (proof ${report.proofCommitHash}).`,
              "warn"
            );
          }

          // Postmortem integration: record failures, resolve on success.
          const repo = this.config.targetRepo;
          const branch = this.config.branch;
          if (pushed) {
            // Commit succeeded — resolve any active postmortem for this file.
            postmortemStore
              .markResolved(repo, branch, blob.path)
              .then(() => {
                this.addLog(
                  `Postmortem resolved for ${blob.path} (file successfully committed).`,
                  "info"
                );
              })
              .catch(() => {
                /* ignore */
              });
          } else if (isZeroDiffSaturation) {
            // ── Stable-file branch (the bug fix) ────────────────────────
            // The LLM produced no semantic change. This is NOT a failure
            // (it's the model correctly identifying the file as already
            // good). The old code lumped zero-diff in with real AST/review
            // failures here, which meant:
            //   1. `attempts` got bumped every cycle (build-guide/*.py hit
            //      attempt #7+ in the dev log) — pure noise.
            //   2. The on-disk postmortem JSON got rewritten every cycle
            //      (7+ files showed up as modified in `git status` every
            //      pass) — git churn with no information gain.
            //   3. The file got the 5-cycle FAILED cooldown, so the loop
            //      re-called the LLM on it every 5 cycles forever — quota
            //      waste that contributed to the 429 rate-limits.
            //
            // The fix:
            //   - Apply the LONG stable cooldown (50 cycles) so quota
            //     belongs to files that might actually change.
            //   - Record the ZERO_DIFF_SATURATION postmortem ONCE (so the
            //     next attempt gets the "make a real refactor" constraint).
            //     On REPEATED zero-diff, the existing postmortem already
            //     says "stable" — don't rewrite it. The attempts counter
            //     stops ticking up once the file is recognized as stable.
            //   - Do NOT add to previouslyFailedPaths — a stable file is
            //     not a failure.
            this.previouslyStablePaths.set(blob.path, this.stats.totalRuns);
            postmortemStore
              .getActivePostmortem(repo, branch, blob.path)
              .then((existing) => {
                if (existing && existing.failureType === "ZERO_DIFF_SATURATION") {
                  // Already recorded as stable — don't churn the postmortem.
                  this.addLog(
                    `File ${blob.path} still stable (0-diff saturation, attempt #${existing.attempts}). Long cooldown ${AutonomousLoopRuntime.STABLE_FILE_COOLDOWN_CYCLES} cycles — quota preserved.`,
                    "info"
                  );
                  return null;
                }
                // First time we've seen this file as stable (or it
                // previously failed for a different reason and is now
                // stable). Record a fresh ZERO_DIFF_SATURATION postmortem
                // so the next attempt gets the "make a real refactor"
                // constraint instead of the old AST/review constraint.
                const pm = generatePostmortemFromReport({
                  filePath: blob.path,
                  astDiffResult: report.astDiffResult,
                  sanitizerResult: report.sanitizerResult,
                  reviewVerdict: report.reviewVerdict,
                  haltReason: report.haltState?.reason,
                });
                return postmortemStore.recordFailure({
                  repo,
                  branch,
                  filePath: blob.path,
                  failureType: pm.failureType,
                  symptom: pm.symptom,
                  evidence: pm.evidence,
                  constraints: pm.constraints,
                });
              })
              .then((record) => {
                if (record) {
                  this.addLog(
                    `File ${blob.path} marked stable (0-diff saturation, postmortem attempt #${record.attempts}). Long cooldown ${AutonomousLoopRuntime.STABLE_FILE_COOLDOWN_CYCLES} cycles — next retry will see evolved lessons.`,
                    "info"
                  );
                }
              })
              .catch(() => {
                /* best-effort — stable cooldown still set above */
              });
          } else if (!astPassed || !reviewApproved) {
            // A real failure — record/update the postmortem so the next
            // attempt gets the constraints.
            const pm = generatePostmortemFromReport({
              filePath: blob.path,
              astDiffResult: report.astDiffResult,
              sanitizerResult: report.sanitizerResult,
              reviewVerdict: report.reviewVerdict,
              haltReason: report.haltState?.reason,
            });
            postmortemStore
              .recordFailure({
                repo,
                branch,
                filePath: blob.path,
                failureType: pm.failureType,
                symptom: pm.symptom,
                evidence: pm.evidence,
                constraints: pm.constraints,
              })
              .then((record) => {
                this.addLog(
                  `Postmortem recorded for ${blob.path} (attempt #${record.attempts}, ${pm.failureType}). Next attempt will use these constraints.`,
                  "warn"
                );
              })
              .catch(() => {
                /* ignore */
              });
            // ── Failed-path cooldown (the "don't get stuck" fix) ────
            // Record this path in previouslyFailedPaths with the current
            // cycle number. The next cycle's file selector (see
            // cooledDown() above) skips it for FAILED_FILE_COOLDOWN_CYCLES
            // cycles, then re-tries. (Zero-diff files are NOT added here
            // — they go to previouslyStablePaths with a longer cooldown.)
            this.previouslyFailedPaths.set(blob.path, this.stats.totalRuns);
          }

          this.currentCycle!.fileResults.push({
            path: blob.path,
            astScore: report.astDiffResult.astScore,
            consensus: report.reviewVerdict.consensus,
            proofHash: report.proofCommitHash,
            status: report.status,
            pushed,
          });
          if (report.proofCommitHash && !cycleProofHash) cycleProofHash = report.proofCommitHash;
        } catch (err) {
          this.addLog(`File ${blob.path} failed: ${(err as Error).message}`, "error");
        }
      }

      this.currentCycle!.filesCommitted = committed;
      this.stats.totalFilesCommitted += committed;
      this.stats.lastRunTime = new Date().toISOString();
      if (!halted) {
        cycleStatus = "completed";
        // Commit the fingerprint only on a cycle that ran to completion.
        if (completedFingerprint) this.stats.lastTreeFingerprint = completedFingerprint;
      }
    } catch (err) {
      this.addLog(`Cycle #${cycleNumber} aborted: ${(err as Error).message}`, "error");
      cycleStatus = "error";
    } finally {
      this.finalizeCycle(cycleId, cycleStatus, cycleProofHash);
      // ── Crash-budget reset on a clean cycle ─────────────────────────
      // A cycle that ran to completion or halted (governor saturation)
      // is "clean" for crash-budget purposes: the loop is structurally
      // fine — per-file failures inside the cycle are caught in the
      // for-loop above and reported through postmortems, they do NOT
      // reach the runContinuousLoop catch and do NOT count as a crash.
      // Resetting the budget on a clean cycle is what makes the wall
      // trip only on SUSTAINED crashes, not on a single crash followed
      // by 100 clean cycles followed by another single crash.
      if (
        (cycleStatus === "completed" || cycleStatus === "halted") &&
        this.consecutiveCrashCount > 0
      ) {
        this.consecutiveCrashCount = 0;
        this.lastCrashClass = "";
        try {
          resetCrashBudget();
        } catch {
          /* best-effort — in-memory is the live source */
        }
      }
      this.status = this.config.enabled ? "idle" : "paused";
      if (this.config.enabled && this.config.mode !== "continuous") {
        const ms = Math.max(15_000, this.config.intervalMinutes * 60 * 1000);
        this.stats.nextRunAt = new Date(Date.now() + ms).toISOString();
      } else {
        this.stats.nextRunAt = null;
      }
    }

    return this.currentCycle;
  }

  /**
   * TOCTOU-safe Contents-API PUT (concept: Aether_Forge Ω repo's
   * force:false ref retry, adapted for the Contents API).
   *
   * The GitHub Contents API is optimistic-concurrency on `sha`: the PUT
   * must include the sha of the file as it was when we READ it, and if
   * the file changed in between, GitHub returns 409. The old code logged
   * "Commit failed" and dropped the enhancement — even though the
   * pipeline (LLM + AST + debate) had already validated it.
   *
   * This helper retries the 409 with a critical correctness guard:
   *
   *   1. On 409, REFETCH the file's current content + sha from the
   *      evolution branch.
   *   2. If the refetched content is BYTE-IDENTICAL to the `rawContent`
   *      we based the refactor on, the sha drift is metadata-only (a
   *      bot touched the sha, or someone committed-then-reverted). The
   *      refactor is still valid → retry the PUT with the fresh sha.
   *   3. If the refetched content DIFFERS, a real concurrent change
   *      landed. Our refactor was based on STALE input — committing it
   *      would CLOBBER the remote change. Skip HONESTLY: log it, mark
   *      skippedDueToRemoteChange, and let the next cycle refactor the
   *      fresh content from scratch.
   *
   * This is stricter than Aether_Forge's blind retry (their push is of
   * GENERATED content not derived from the remote file's previous
   * content, so clobbering isn't a concern there). For LOOP, the LLM
   * refactor IS derived from the remote file — so a content-changed
   * 409 must NOT retry.
   *
   * Emits `push` events on the loop event bus at each lifecycle point
   * (committed / toctou_conflict / toctou_healed / skipped_remote_changed
   * / failed) so the console stream can narrate the heal path.
   */
  private async putFileWithToctouRetry(params: {
    token: string;
    filePath: string;
    rawContent: string; // original content the refactor was based on
    evolvedCode: string; // the LLM-refactored code to commit
    baseSha: string; // sha of rawContent as fetched at pipeline start
    cycleId: string;
    cycleNumber: number;
    proofHash: string;
    astScore: number;
  }): Promise<{
    pushed: boolean;
    toctouHealed: boolean;
    skippedDueToRemoteChange: boolean;
    error?: string;
  }> {
    const {
      token,
      filePath,
      rawContent,
      evolvedCode,
      baseSha,
      cycleNumber,
      proofHash,
      astScore,
    } = params;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "Architecture-Helper-Pipeline",
      Accept: "application/vnd.github.v3+json",
    };
    const commitUrl = `https://api.github.com/repos/${this.config.targetRepo}/contents/${filePath}`;
    const fileUrl = `https://api.github.com/repos/${this.config.targetRepo}/contents/${filePath}?ref=${this.config.evolutionBranch}`;
    const message = `Autonomous self-enhancement #${cycleNumber} — ${filePath} (AST ${astScore}, proof ${proofHash})`;
    const contentB64 = Buffer.from(evolvedCode).toString("base64");
    let currentSha = baseSha;
    const MAX_TOCTOU_RETRIES = 3;

    for (let attempt = 0; attempt <= MAX_TOCTOU_RETRIES; attempt++) {
      const commitPayload: Record<string, unknown> = {
        message,
        content: contentB64,
        branch: this.config.evolutionBranch,
      };
      if (currentSha) commitPayload.sha = currentSha;

      let commitRes: Response;
      try {
        commitRes = await fetch(commitUrl, {
          method: "PUT",
          headers,
          body: JSON.stringify(commitPayload),
        });
      } catch (err) {
        return {
          pushed: false,
          toctouHealed: false,
          skippedDueToRemoteChange: false,
          error: `dispatch error: ${(err as Error).message}`,
        };
      }

      if (commitRes.ok) {
        return {
          pushed: true,
          toctouHealed: attempt > 0,
          skippedDueToRemoteChange: false,
        };
      }

      // Non-409 errors don't retry — they're real failures (auth, 404,
      // 422, validation). Surface them and bail.
      if (commitRes.status !== 409) {
        const errBody = (await commitRes.json().catch(() => ({}))) as {
          message?: string;
        };
        return {
          pushed: false,
          toctouHealed: false,
          skippedDueToRemoteChange: false,
          error: `${errBody.message ?? `HTTP ${commitRes.status}`}`,
        };
      }

      // 409 — TOCTOU conflict. Refetch to decide whether the remote
      // content actually changed.
      if (attempt === MAX_TOCTOU_RETRIES) {
        return {
          pushed: false,
          toctouHealed: false,
          skippedDueToRemoteChange: false,
          error: `409 persisted across ${MAX_TOCTOU_RETRIES + 1} attempts`,
        };
      }

      // Exponential backoff before the refetch (1s, 2s, 4s) — gives a
      // concurrent committer time to settle so we don't refetch mid-flux.
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));

      let refetchRes: Response;
      try {
        refetchRes = await fetch(fileUrl, { headers });
      } catch (err) {
        return {
          pushed: false,
          toctouHealed: false,
          skippedDueToRemoteChange: false,
          error: `refetch dispatch error: ${(err as Error).message}`,
        };
      }
      if (!refetchRes.ok) {
        return {
          pushed: false,
          toctouHealed: false,
          skippedDueToRemoteChange: false,
          error: `refetch failed (HTTP ${refetchRes.status})`,
        };
      }
      const refetchData = (await refetchRes.json().catch(() => ({}))) as {
        content?: string;
        sha: string;
      };
      const refetchedContent = refetchData.content
        ? Buffer.from(refetchData.content, "base64").toString("utf-8")
        : "";

      if (refetchedContent !== rawContent) {
        // Remote content CHANGED since we fetched — our refactor is
        // based on stale input. Committing would clobber the remote
        // change. Skip honestly; the next cycle fetches fresh content
        // and refactors anew. This is the key correctness guard that
        // makes the TOCTOU retry safe for derived-from-remote commits.
        this.addLog(
          `Skipping ${filePath}: remote content changed mid-cycle (TOCTOU). Refactor based on stale input — would clobber remote change. Next cycle will refactor the fresh content.`,
          "warn",
          "github"
        );
        return {
          pushed: false,
          toctouHealed: false,
          skippedDueToRemoteChange: true,
          error: "remote content changed mid-cycle (skipped to avoid clobber)",
        };
      }

      // Remote content byte-identical — the sha drift is metadata-only
      // (someone committed-then-reverted, or a bot touched the sha
      // without changing content). Retry the PUT with the fresh sha;
      // the refactor is still valid against this content.
      currentSha = refetchData.sha;
      this.addLog(
        `TOCTOU heal: remote content unchanged, sha drifted. Retrying ${filePath} with fresh sha ${(refetchData.sha ?? "").slice(0, 7)} (attempt ${attempt + 2}/${MAX_TOCTOU_RETRIES + 1}).`,
        "info",
        "github"
      );
    }

    // Unreachable (the loop returns on every path), but TS needs a return.
    return {
      pushed: false,
      toctouHealed: false,
      skippedDueToRemoteChange: false,
      error: "exhausted",
    };
  }

  private finalizeCycle(
    cycleId: string,
    status: AutonomousCycleState["status"],
    proofHash: string | null
  ) {
    if (!this.currentCycle) return;
    const finishedAt = new Date().toISOString();
    this.currentCycle.status = status;
    this.currentCycle.filesCommitted = this.currentCycle.filesCommitted ?? 0;

    db.autonomousCycle
      .create({
        data: {
          id: cycleId,
          cycleNumber: this.currentCycle.cycleNumber,
          mode: this.currentCycle.mode,
          targetRepo: this.currentCycle.targetRepo,
          branch: this.currentCycle.branch,
          filesScanned: this.currentCycle.filesScanned,
          filesCommitted: this.currentCycle.filesCommitted,
          status,
          proofHash,
          startedAt: new Date(this.currentCycle.startedAt),
          finishedAt: new Date(finishedAt),
        },
      })
      .then(() => {
        // audit 4 — grow-only sweep: prune AutonomousCycle AFTER the write.
        // Before this, finalizeCycle wrote one row per cycle with NO
        // deletion logic anywhere in the codebase — the table grew at
        // 1 row/cycle forever. Keep newest 200 (covers ~a week of
        // continuous running; the oracle + UI only read the recent tail,
        // older rows have no live consumer). Fire-and-forget, best-effort.
        void pruneAutonomousCycles(200);
      })
      .catch(() => {
        /* ignore */
      });

    this.recentCycles.unshift({
      id: cycleId,
      cycleNumber: this.currentCycle.cycleNumber,
      mode: this.currentCycle.mode,
      targetRepo: this.currentCycle.targetRepo,
      branch: this.currentCycle.branch,
      filesScanned: this.currentCycle.filesScanned,
      filesCommitted: this.currentCycle.filesCommitted,
      status,
      startedAt: this.currentCycle.startedAt,
      finishedAt,
      proofHash,
    });
    if (this.recentCycles.length > 25) this.recentCycles.length = 25;

    // Oracle background integration: after every completed/halted cycle,
    // give the system the chance to predict its OWN next turn. This is what
    // makes the Oracle a participant in the loop's rhythm instead of a
    // manual toy — every cycle ends with "what happens next?" committed to
    // a falsifiable answer BEFORE the next cycle runs. autoProphecyAfterCycle
    // is fire-and-forget, LLM-gate-aware, bounded (≤5 pending prophecies),
    // and never throws — it can't take down the loop. (Previously this was
    // wired into self-enhance-loop.ts but NOT loop-runtime.ts — the
    // autonomous loop ran cycles without ever generating prophecies.)
    if (status === "completed" || status === "halted") {
      try {
        autoProphecyAfterCycle();
      } catch {
        // Defensive: autoProphecyAfterCycle already swallows internally,
        // but a defensive try here guarantees a future refactor can't
        // accidentally make the oracle take down the autonomous loop.
      }
    }

    // Red-team periodic self-assessment (concept: Aether_Forge aetherforge-eval
    // / GRAFT 4). Every RED_TEAM_PERIOD cycles, the loop runs the adversarial
    // probe suite against its OWN LLM enhancement path. A containment bypass
    // raises safe-mode (via the runner→duress bridge), halting further cycles
    // until an operator clears it. Fire-and-forget + LLM-gate-aware + bounded
    // — same defensive guarantees as autoProphecyAfterCycle. The period is
    // coarse (default 20) so it doesn't burn the LLM quota every cycle.
    if ((status === "completed" || status === "halted") && this.stats.totalRuns % RED_TEAM_PERIOD === 0) {
      try {
        void runRedTeamSuite().catch(() => {
          // Defensive — a red-team failure can't take down the loop.
        });
      } catch {
        /* defensive */
      }
    }
  }

  private computeTreeFingerprint(
    tree: Array<{ path: string; sha: string; size?: number }>
  ): string {
    const sorted = [...tree].sort((a, b) => a.path.localeCompare(b.path));
    const raw = sorted.map((f) => `${f.path}:${f.sha ?? f.size ?? 0}`).join("|");
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
    }
    return "tree_fp_" + Math.abs(hash).toString(16);
  }
}

// Singleton — survives across hot reloads.
const globalForLoop = globalThis as unknown as {
  __autonomousLoopRuntime?: AutonomousLoopRuntime;
};

export const autonomousLoopRuntime: AutonomousLoopRuntime =
  globalForLoop.__autonomousLoopRuntime ?? new AutonomousLoopRuntime();

if (!globalForLoop.__autonomousLoopRuntime) {
  globalForLoop.__autonomousLoopRuntime = autonomousLoopRuntime;
}
