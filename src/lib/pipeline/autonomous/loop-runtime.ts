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
    // JS-level handlers can't catch a C-level crash). The loop still
    // works; it just won't auto-start. Press [START] in the UI or POST
    // /api/autonomous/start to arm it when you want it running. The
    // duress safe-mode gate (core/duress.ts) still pauses it on a
    // security event. See docs/HOT-SWAP.md.
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
    return !!(globalThis as any)[AutonomousLoopRuntime.AUTO_ARM_FLAG];
  }
  private markAutoArmFired(): void {
    (globalThis as any)[AutonomousLoopRuntime.AUTO_ARM_FLAG] = true;
  }
  private resetAutoArmFlag(): void {
    (globalThis as any)[AutonomousLoopRuntime.AUTO_ARM_FLAG] = false;
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
        consumeStashedSnapshot?: () => any;
      };
      if (typeof consumeStashedSnapshot === "function") {
        const snap = consumeStashedSnapshot();
        if (snap) {
          if (snap.config) {
            this.config = { ...this.config, ...snap.config };
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
          const g = globalThis as unknown as { __autonomousLoopRuntime?: any };
          if (g.__autonomousLoopRuntime && g.__autonomousLoopRuntime !== this) {
            // Another instance won the race. Don't arm a second timer.
            return;
          }
          // Respect duress safe-mode: if it's raised at boot (e.g. a prior
          // session left it raised), don't auto-start. The recovery probe
          // or the operator will clear it.
          if (typeof isSafeMode === "function" && isSafeMode()) {
            this.addLog(
              "Auto-arm deferred: safe-mode is active. Clear via /api/duress/clear to start the autonomous loop.",
              "warn"
            );
            this.status = "paused";
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

  // --- Public API ---
  public getState(): LoopState {
    return {
      config: {
        ...this.config,
        githubToken: this.config.githubToken ? "[REDACTED]" : "",
      },
      status: this.status,
      stats: { ...this.stats },
      logs: [...this.logs],
      currentCycle: this.currentCycle ? { ...this.currentCycle } : null,
      recentCycles: [...this.recentCycles],
    };
  }

  public updateConfig(patch: Partial<LoopConfig>): LoopConfig {
    const wasEnabled = this.config.enabled;
    const oldMode = this.config.mode;
    const oldRepo = this.config.targetRepo;
    const oldBranch = this.config.evolutionBranch;
    const oldToken = this.config.githubToken;
    this.config = { ...this.config, ...patch };
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
    if (this.config.enabled && this.status !== "paused") {
      this.addLog("Loop already enabled.", "info");
      return this.getState();
    }
    this.config.enabled = true;
    this.status = "idle";
    this.addLog(
      `Autonomous loop ENABLED in ${this.config.mode.toUpperCase()} mode. First run scheduled in ${this.config.intervalMinutes} minute(s).`,
      "success"
    );
    this.restartScheduler();
    return this.getState();
  }

  public stop(): LoopState {
    this.config.enabled = false;
    this.status = "paused";
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Also kill any pending recovery probe. Without this, a stopped
    // instance's probe could fire later and re-arm ITS scheduler — a
    // zombie loop running in parallel with whichever instance the
    // operator (or a hot-swap) actually started.
    if (this.recoveryProbeTimer) {
      clearTimeout(this.recoveryProbeTimer);
      this.recoveryProbeTimer = null;
    }
    this.continuousLoopRunning = false;
    this.addLog(
      "Autonomous loop DISABLED. No further cycles will run until re-enabled.",
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
    this.addLog(`Scheduler armed. Next automatic cycle at ${this.stats.nextRunAt}`, "info");
    this.timer = setInterval(() => {
      this.executeCycle(this.config.mode).catch((err) => {
        this.addLog(`Scheduler cycle failed: ${(err as Error).message}`, "error");
      });
    }, ms);

    if (this.config.mode === "continuous") {
      this.continuousLoopRunning = true;
      this.runContinuousLoop().catch((err) => {
        this.addLog(`Continuous loop crashed: ${(err as Error).message}`, "error");
      });
    }
  }

  private async runContinuousLoop() {
    // The continuous loop is the heart of "fully autonomous". It MUST
    // NOT die on a single cycle crash — a bug in one cycle (a thrown
    // error inside executeCycle's internals, an OOM in the LLM call,
    // a transient DB hiccup) must not permanently stop the system.
    // The cycle itself already catches its own errors, but a defensive
    // try/catch around the whole loop body guarantees a future refactor
    // can't accidentally make one uncaught throw kill the loop forever.
    //
    // DYNAMIC COOLDOWN: the base cooldown is 1.5s, but when the LLM is
    // rate-limited (429 gate active), the cooldown extends to avoid
    // hammering the API. Without this, the loop starts a new cycle every
    // 1.5s even while the LLM gate is on a 150s cooldown — each cycle
    // immediately hits the gate, returns "deferred", and the loop tries
    // again 1.5s later. That saturates the event loop (every cycle does
    // a GitHub tree fetch + 3 file reads + gate check before deferring)
    // and the HTTP server stops responding to requests. With the backoff,
    // the loop waits for the gate to clear before starting the next cycle.
    while (
      this.continuousLoopRunning &&
      this.config.enabled &&
      this.config.mode === "continuous"
    ) {
      try {
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
          this.continuousLoopRunning = false;
          this.scheduleRecoveryProbe();
          return;
        }
      } catch (err) {
        // A throw escaping executeCycle is a bug, but the loop's job is
        // to keep running. Log it and continue — the next cycle starts
        // fresh. This is what makes the loop "never-stop".
        this.addLog(
          `Cycle threw (continuous loop survived): ${(err as Error).message}`,
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
      this.stats.lastTreeFingerprint = fp;
      this.addLog(`Tree fingerprint computed: ${fp} (${tree.length} entries)`, "info");

      // 2. Filter to REAL code files only. The LLM cannot meaningfully
      //    refactor markdown, JSON, YAML, shell, SQL, HTML, or CSS — running
      //    it on those files produces cosmetic comment injection that the
      //    0-diff saturation check then halts on, wasting LLM API calls.
      //    Only include languages where the LLM can extract constants,
      //    add type annotations, modularize, etc.
      const codeExtRegex = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|c|cpp|cc|cs)$/i;
      const ignored = /^(node_modules|\.git|\.next|dist|build|coverage|public\/assets|vendor|third_party|\.agents|docs?|examples?)\//i;
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
                originalCode: report.originalCode.slice(0, 200000),
                evolvedCode: report.evolvedCode.slice(0, 200000),
                sanitizerClean: report.sanitizerResult.clean,
                violations: JSON.stringify(report.sanitizerResult.violations),
                triggeredBy: mode,
              },
            });
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
      if (!halted) cycleStatus = "completed";
    } catch (err) {
      this.addLog(`Cycle #${cycleNumber} aborted: ${(err as Error).message}`, "error");
      cycleStatus = "error";
    } finally {
      this.finalizeCycle(cycleId, cycleStatus, cycleProofHash);
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
      cycleId,
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
