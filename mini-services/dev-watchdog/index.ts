/**
 * Dev Watchdog (port 3005) — keeps the whole LOOP stack alive.
 *
 * WHY THIS EXISTS (the 04:46 darkness):
 *   On 2026-11-22 ~04:46, the kernel OOM-killer shot the next-server
 *   process (1.5GB RSS after ~2h of Turbopack recompiles driven by the
 *   self-enhancement loop's constant src/ mutations — dmesg: "Out of
 *   memory: Killed process 1764 (next-server)"). The loop-worker kept
 *   working (cycles, gates, pushes all green), but the dashboard went
 *   dark: gateway 502s, no status APIs, nothing supervises the dev
 *   server. This service closed the first gap: mutual supervision —
 *   the Next server respawns the loop-worker (ensureWorkerRunning),
 *   the watchdog respawns the Next server.
 *
 * WHY IT NOW WATCHES FOUR TARGETS (operator, 2026-11-24 — 10-day
 * endurance test):
 *   The ensureWorkerRunning() respawn only fires when the dashboard
 *   polls the status proxy — which requires the operator's browser
 *   window to be open. Observed live: the worker died silently at
 *   ~00:48 (no crash trace, OOM-class) and NOTHING brought it back,
 *   because no window was polling. For the sanctioned 10-day unattended
 *   run, in-sandbox supervision with a 30s cadence is required:
 *
 *     :3000 dev server     /api/healthz   (original target — log
 *                                          rotation + 896MB heap cap)
 *     :3004 loop-worker    /health        (the mutation engine — the
 *                                          whole point of the test;
 *                                          output appends to worker.log
 *                                          so boot diagnostics survive)
 *     :3003 loop-ws        /health        (console stream sidecar)
 *     :3010 fleet-harvester /api/health   (siphon scaffold)
 *
 *   The watchdog itself is supervised from OUTSIDE the sandbox by the
 *   cron stack-heartbeat job (the "who watches the watchmen" gap —
 *   nothing in-sandbox can do it, by construction).
 *
 * DESIGN (per target, unchanged semantics from the original):
 *   - PROBE, DON'T ASSUME: fetch the target's health URL with a 5s
 *     timeout every 30s. 200 = alive. Anything else = one strike.
 *   - TWO-STRIKE RULE: respawn only after 2 consecutive failed probes
 *     (~60s dark). A single blip must not trigger a fork.
 *   - GRACE PERIOD: after a spawn, THAT target's probes are suppressed
 *     for 90s (per-target, not global — a worker respawn must not blind
 *     the dev-server checks).
 *   - SPAWN BUDGET: max 5 spawns per rolling hour PER TARGET. If a
 *     service can't stay up, forking forever helps nobody.
 *   - DETACHED SPAWN: children are reparented to init and outlive this
 *     watchdog's own death/restart.
 *   - CRASH-SILENT: an uncaught error in a probe cycle is logged and
 *     swallowed — a watchdog that dies with its watchee is worthless.
 *
 * Port 3005 serves GET /health with the full per-target state — the
 * top-level fields keep the original dev-server shape for backward
 * compatibility with any existing tooling.
 */

import { spawn } from "child_process";
import { existsSync, renameSync, openSync, closeSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

const PORT = 3005;
/** mini-services/dev-watchdog → project root (two levels up). */
const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const DEV_LOG = join(PROJECT_ROOT, "dev.log");
const DEV_LOG_OLD = join(PROJECT_ROOT, "dev.log.1");
const WORKER_LOG = join(PROJECT_ROOT, "mini-services", "loop-worker", "worker.log");
const WS_LOG = join(PROJECT_ROOT, ".zscripts", "mini-service-loop-ws-service.log");
const HARVESTER_LOG = join(PROJECT_ROOT, ".zscripts", "mini-service-fleet-harvester.log");

const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const STRIKES_TO_RESPAWN = 2;
const GRACE_MS_AFTER_SPAWN = 90_000;
// 16/hour (raised 5→8→12→16 across 2026-11-24): memory-guard recycles are
// legitimate restarts, and a worker that legitimately needs recycling
// must not be starved out by a budget sized for crash storms. Measured
// cadence under full dashboard polling: one controlled recycle per ~6min
// (anon grows ~45MB/min to the 900MB ceiling) ≈ 10/hour — 16 leaves
// margin without losing crash-storm protection (a true crash loop burns
// 40+/hour and still trips).
const MAX_SPAWNS_PER_HOUR = 16;

// ── MEMORY GUARD (operator, 2026-11-24 — 10-day endurance test) ───────
// dmesg showed the kernel OOM-killer shooting bun processes at ~1.3GB
// anon-RSS (global_oom, CONSTRAINT_NONE) — the worker's steady state
// (in-memory TS compiler + Prisma + gate children that spike 500MB+
// each) collides with next-server's growth (1.1GB after ~2h). A random
// kernel kill picks a random victim at a random moment (mid-gate-chain
// worst case). The guard converts that into CONTROLLED recycles: when a
// process crosses its RSS ceiling, SIGTERM it at a known moment — the
// 2-strike respawn path brings it back within ~60-90s, and the worker's
// test-gate journal + restart tiers recover the in-flight state (the
// exact machinery built for crash recovery, now triggered deliberately).
// Ceilings sit just BELOW the observed OOM kill point (~1.3GB) so the
// kernel never gets to choose.
// Tuning (observed live, 2026-11-24 01:08-01:11): the worker's WORKING
// SET is ~1.35GB reached within ~90s of boot (front-loaded: pipeline
// import graph + in-memory TS compiler + Prisma + postmortem
// rehydration) — a 1250MB ceiling recycled it every 90s and burned the
// spawn budget. The worker now gets 1550MB (working set + leak margin);
// the DEV SERVER gets the tighter 1150MB ceiling instead — it idles
// fine lean (V8 heap capped at 896MB) and recycling IT keeps headroom
// for the worker's gate-children spikes (tsc/eslint ~500-1000MB).
// Combined worst case: 1.55 + 1.15 + ~0.5 misc + ~0.6 spike ≈ 3.8GB of
// the 3.9GB machine — the kernel never gets to choose a victim.
//
// RETUNE (operator, 2026-11-24 ~02:35 — the death loop): the 1150MB
// ceiling was WRONG in practice. Observed: characterization-test gate
// children (`bun test` on files with pinned tests) grow to ~1.32GB; at
// a fat moment (worker 1.35GB + child 1.32GB + next-server 0.86GB+)
// the 4.04GB box hit global OOM five times in ten minutes — the kernel
// killed the child and the WORKER (whose own allocation had invoked
// the killer) died with it, silently, every time. Six workers burned
// half the respawn budget. The envelope only closes if next-server is
// capped at 700MB: 1.35 + 1.32 + 0.70 + ~0.35 misc ≈ 3.7GB — the wall
// is never reached. Cost: the dashboard recycles every ~40-60min of
// growth (60-90s dark each) — read-only surface, acceptable for the
// endurance test; the LOOP is the point.
// RETUNE 2 (operator, 2026-11-24 04:30 UTC — the warmup recycle loop): the
// 700MB ceiling was unattainable in practice. Observed live on the 04:15:45
// cold boot: EVERY respawned dev-server warms to ~790-890MB within ~2min
// (Turbopack compile + the dashboard client's route polling), so the guard
// killed each one mid-warmup — 5 spawns burned in 11 minutes, budget
// exhaustion ~30min away, dashboard permanently dark while the loop itself
// cycled fine. Two changes:
//   1. Ceiling 700 → 850MB: a warmed dev-server's observed steady state on
//      this box is ~810MB. Envelope at 850: worker 1.35 + gate child 1.32 +
//      dev 0.85 + misc 0.35 ≈ 3.87GB — still inside the 4.04GB wall with
//      ~170MB margin (the death-loop math survives; 700 was aspiration,
//      not observation).
//   2. WARMUP GRACE: a next-server younger than 5 minutes is exempt from
//      the ceiling (compile spikes to ~890MB are normal warmup, not a
//      leak). The worker gets NO grace — its 1.35GB working set is
//      front-loaded inside 90s of boot and its 1550MB ceiling already is
//      working-set + margin.
// RETUNE 3 (operator, 2026-11-24 ~05:00 UTC — measured, not guessed): three
// consecutive instances under full dashboard polling settled at 897/955/
// 934MB — the true steady state with the operator's browser open is
// ~900-955MB, so an 850 ceiling still recycled every grace-expiry (~6.5min
// cycle → budget death in ~1h). Ceiling → 950MB (envelope worst case:
// worker 1.35 + gate child 1.32 + dev 0.95 + misc 0.35 ≈ 3.97GB — 70MB
// under the 4041MB wall; the kernel only gets to choose in the rare
// triple-overlap, and every layer recycles by design) AND the respawn
// heap cap drops 896 → 640MB so V8 GCs hard instead of hoarding — the
// appetite shrinks toward ~750-850MB, buying margin under the same
// ceiling. Worst case the dashboard lags under GC pressure, never dies.
// RETUNE 4 (operator, 2026-11-24 ~05:12 UTC — guard the currency the
// kernel actually spends): RSS-based ceilings kept recycling a HEALTHY
// server — settled RSS 1030-1070MB flat (no leak; 897→955→1023→1039
// across instances under full dashboard polling), heap cap 896→640 didn't
// shrink it (native + file-backed dominate). smaps_rollup on the settling
// instance: RSS 1023MB = Anonymous 774MB + file-backed ~250MB — and file
// pages are EVICTABLE: under box pressure the kernel reclaims them
// instead of OOM-killing. The OOM killer spends ANON, so the guard must
// too. Envelope in anon: worker 1.35 + gate child 1.32 + dev 0.90 +
// misc 0.35 ≈ 3.92GB < the 4041MB wall (≈120MB margin). Observed settled
// dev anon: 774MB → ceiling 900MB (margin for compile bursts). A real
// leak = anon growth → caught at 900 → controlled recycle. The worker
// stays RSS-based (its 1.35GB working set is compiler/prisma anon;
// RSS ≥ anon makes its guard slightly conservative — the safe direction).
const MEMGUARD_NEXT_SERVER_ANON_MB = 900; // next-server ANONYMOUS ceiling (smaps_rollup)
const MEMGUARD_WARMUP_GRACE_MS = 300_000; // next-server age below which the ceiling is exempt
const MEMGUARD_WORKER_MB = 1550; // working set ~1.35GB + leak margin (RSS metric)

interface MemGuardSpec {
  /** substring matched against /proc/<pid>/cmdline */
  cmdMatch: string;
  limitMb: number;
  /** which memory currency the limit is expressed in (RETUNE 4):
   *  "anon" = smaps_rollup Anonymous (the OOM killer's currency — use
   *  for processes with big evictable file-backed footprints, like a
   *  Turbopack-warm next-server); "rss" = VmRSS (simpler, conservative). */
  metric: "anon" | "rss";
  /** which target's respawn path owns the recovery */
  owner: string;
}

const MEMGUARDS: MemGuardSpec[] = [
  { cmdMatch: "next-server", limitMb: MEMGUARD_NEXT_SERVER_ANON_MB, metric: "anon", owner: "dev-server" },
  { cmdMatch: "loop-worker/index.ts", limitMb: MEMGUARD_WORKER_MB, metric: "rss", owner: "loop-worker" },
];

/** Anonymous memory of a pid in MB, or null when unreadable/vanished.
 *  /proc/<pid>/smaps_rollup is a single cheap read (unlike full smaps).
 *  This is the number the OOM killer cares about — file-backed pages
 *  evict under pressure instead of triggering kills. */
function anonMb(pid: number): number | null {
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const m = /Anonymous:\s+(\d+)\s+kB/.exec(rollup);
    return m ? Math.round(parseInt(m[1], 10) / 1024) : null;
  } catch {
    return null;
  }
}

/** RSS of a pid in MB, or null when it vanished. /proc/<pid>/status
 *  VmRSS line (kB). Never throws — processes disappear mid-walk. */
function rssMb(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    return m ? Math.round(parseInt(m[1], 10) / 1024) : null;
  } catch {
    return null;
  }
}

/** All pids whose cmdline contains `substr`, with their RSS. Walks
 *  /proc directly (no pgrep dependency, no spawn in the probe loop). */
function findProcesses(substr: string): Array<{ pid: number; rssMb: number | null }> {
  const out: Array<{ pid: number; rssMb: number | null }> = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    if (pid === process.pid) continue; // never guard the watchdog itself
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (cmdline.includes(substr)) {
        out.push({ pid, rssMb: rssMb(pid) });
      }
    } catch {
      /* process vanished mid-walk — skip */
    }
  }
  return out;
}

/** One memory-guard sweep. SIGTERMs any process over its ceiling; the
 *  target's probe failures then drive the 2-strike respawn.
 *
 * SIGTERM ESCALATION (operator, 2026-11-24 ~02:37 — observed live during
 * the death-loop recovery): next-server under memory pressure IGNORED
 * two consecutive SIGTERMs (pid 2634 recycled at 02:34:59 and 02:35:29,
 * still holding 850MB and port :3000). A stuck-terminating server
 * blocks its own replacement (EADDRINUSE) and burns respawn budget.
 * Now: a SIGTERMed pid that is still alive on the NEXT sweep (~30s
 * later) gets SIGKILL — the port frees, the respawn binds cleanly. */
const gEscalate = globalThis as unknown as {
  __memguardSigtermed?: Map<number, number>; // pid → epoch ms of SIGTERM
  __memguardGraceNoted?: Set<number>; // pids already logged as in warmup grace
  __memguardSweepCount?: number; // RSS observability cadence (log every 10th sweep)
};
gEscalate.__memguardSigtermed ??= new Map();
gEscalate.__memguardGraceNoted ??= new Set();
gEscalate.__memguardSweepCount ??= 0;

/** Age of a pid in ms, or null when unreadable. /proc/<pid>/stat field 22
 *  (starttime, clock ticks since boot) vs /proc/uptime. comm (field 2)
 *  may contain spaces and parens — parse after the LAST ')'. */
function ageMs(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return null;
    // After "pid (comm) " the next field is state (field 3), so field 22
    // (starttime) is index 19 of this slice.
    const fields = stat.slice(close + 2).split(" ");
    const starttimeTicks = parseInt(fields[19], 10);
    if (!Number.isFinite(starttimeTicks)) return null;
    const uptime = parseFloat(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    if (!Number.isFinite(uptime)) return null;
    const CLK_TCK = 100; // _SC_CLK_TCK — 100 on every Linux we run on
    return Math.max(0, (uptime - starttimeTicks / CLK_TCK) * 1000);
  } catch {
    return null;
  }
}

function runMemoryGuard(): void {
  const now = Date.now();
  // Escalation pass first: anything SIGTERMed >25s ago that still lives
  // is stuck-terminating — hard-kill it so the respawn can bind.
  for (const [pid, termAt] of gEscalate.__memguardSigtermed!) {
    let alive = true;
    try {
      process.kill(pid, 0); // signal 0 = existence probe, no signal sent
    } catch {
      alive = false; // exited on its own — forget it
    }
    if (!alive) {
      gEscalate.__memguardSigtermed!.delete(pid);
      continue;
    }
    if (now - termAt > 25_000) {
      log(
        `[memguard] pid ${pid} survived SIGTERM >25s (stuck terminating) — escalating to SIGKILL`
      );
      try {
        process.kill(pid, "SIGKILL");
      } catch (err) {
        log(
          `[memguard] SIGKILL failed for pid ${pid} (guard continues): ${err instanceof Error ? err.message : String(err)}`
        );
      }
      gEscalate.__memguardSigtermed!.delete(pid);
    }
  }
  gEscalate.__memguardSweepCount!++;
  for (const guard of MEMGUARDS) {
    for (const proc of findProcesses(guard.cmdMatch)) {
      // Warmup grace (dev-server only): a fresh next-server legitimately
      // spikes to ~890MB while Turbopack compiles; killing it mid-warmup
      // burned 5 spawns in 11 minutes on 2026-11-24 (see RETUNE 2 above).
      // Log the exemption once per pid; RSS line every 10th sweep either
      // way so the digest has a memory curve to point at.
      if (guard.owner === "dev-server") {
        const age = ageMs(proc.pid);
        if (age !== null && age < MEMGUARD_WARMUP_GRACE_MS) {
          if (!gEscalate.__memguardGraceNoted!.has(proc.pid)) {
            gEscalate.__memguardGraceNoted!.add(proc.pid);
            log(
              `[memguard] next-server pid ${proc.pid} in warmup grace (age ${Math.round(age / 1000)}s < ${MEMGUARD_WARMUP_GRACE_MS / 1000}s, RSS ${proc.rssMb}MB) — ceiling exempt until settled`
            );
          }
          continue;
        }
        // Steady-state observability: one compact RSS line every ~5min
        // (both currencies — RSS shows the fat, anon shows the risk).
        if (gEscalate.__memguardSweepCount! % 10 === 0) {
          log(
            `[memguard] next-server pid ${proc.pid} RSS ${proc.rssMb}MB anon ${anonMb(proc.pid)}MB (anon ceiling ${guard.limitMb}MB)`
          );
        }
      }
      // RETUNE 4: the dev-server is judged on ANON, the worker on RSS.
      const metricMb =
        guard.metric === "anon" ? anonMb(proc.pid) : proc.rssMb;
      if (metricMb !== null && metricMb > guard.limitMb) {
        log(
          `[memguard] recycling ${guard.owner} (pid ${proc.pid}, ${guard.metric} ${metricMb}MB > ${guard.limitMb}MB ${guard.metric} ceiling${guard.metric === "anon" ? `, RSS ${proc.rssMb}MB (file-backed is evictable — not the risk)` : ""}) — controlled recycle, 2-strike respawn follows`
        );
        try {
          process.kill(proc.pid, "SIGTERM");
          gEscalate.__memguardSigtermed!.set(proc.pid, now);
        } catch (err) {
          log(
            `[memguard] SIGTERM failed for pid ${proc.pid} (guard continues): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }
}

interface TargetState {
  consecutiveFailures: number;
  lastProbeOk: boolean | null;
  lastProbeAt: number | null;
  spawnHistory: number[]; // epoch ms of each spawn (rolling hour)
  lastSpawnAt: number | null;
  lastAction: string;
}

interface WatchTarget {
  name: string;
  probeUrl: string;
  /** Target-specific respawn. Returns true if the spawn was issued
   *  (false = budget exhausted or spawn error — logged by caller's
   *  context, never thrown: the watchdog must stay up). */
  respawn: () => boolean;
  state: TargetState;
}

function freshState(): TargetState {
  return {
    consecutiveFailures: 0,
    lastProbeOk: null,
    lastProbeAt: null,
    spawnHistory: [],
    lastSpawnAt: null,
    lastAction: "boot",
  };
}

function log(msg: string): void {
  console.log(`[DEV-WATCHDOG] ${new Date().toISOString()} ${msg}`);
}

/** Spawns within the last hour (rolling budget window) for a target. */
function spawnsInLastHour(t: WatchTarget): number {
  const cutoff = Date.now() - 3_600_000;
  t.state.spawnHistory = t.state.spawnHistory.filter((ms) => ms >= cutoff);
  return t.state.spawnHistory.length;
}

/** Budget gate + bookkeeping shared by every respawn path. */
function issueSpawn(t: WatchTarget, spawnFn: () => number | null): boolean {
  if (spawnsInLastHour(t) >= MAX_SPAWNS_PER_HOUR) {
    t.state.lastAction = "spawn-refused-budget-exhausted";
    log(
      `${t.name}: spawn REFUSED — ${MAX_SPAWNS_PER_HOUR}/hour budget exhausted. Manual intervention needed.`
    );
    return false;
  }
  try {
    const pid = spawnFn();
    if (pid === null) return false; // spawnFn logged its own error
    const now = Date.now();
    t.state.spawnHistory.push(now);
    t.state.lastSpawnAt = now;
    t.state.consecutiveFailures = 0;
    t.state.lastAction = "spawned";
    log(
      `${t.name}: respawned (pid ${pid}, ${spawnsInLastHour(t)}/${MAX_SPAWNS_PER_HOUR} budget used)`
    );
    return true;
  } catch (err) {
    t.state.lastAction = "spawn-failed";
    log(
      `${t.name}: spawn FAILED (watchdog continues): ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

// ── Target 1: the Next.js dev server (original logic, verbatim) ────────
const devServerTarget: WatchTarget = {
  name: "dev-server",
  probeUrl: "http://127.0.0.1:3000/api/healthz",
  state: freshState(),
  respawn: () =>
    issueSpawn(devServerTarget, () => {
      // Rotate dev.log → dev.log.1 (keep one generation) so `tee dev.log`
      // inside the dev script doesn't truncate the pre-crash log.
      try {
        if (existsSync(DEV_LOG)) {
          renameSync(DEV_LOG, DEV_LOG_OLD);
        }
      } catch (err) {
        // Non-fatal: worst case tee truncates the old log.
        log(`log rotation failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
      }

      // V8 heap cap for the respawned dev server (RETUNE 3: 896 → 640MB).
      // The 896 cap let the heap hoard to ~900MB+ before hard GC (observed
      // settled RSS 897-955MB under dashboard polling). 640 forces V8 to
      // stay lean: worst case the dashboard lags, never dies. NOTE: only
      // this respawn path is capped — dev.sh's boot spawn and the cron
      // keepalive's relaunch run uncapped; an oversized uncapped server
      // gets one controlled memguard recycle and THIS capped path takes
      // over. Self-converging by construction.
      const existingNodeOptions = process.env.NODE_OPTIONS ?? "";
      const nodeOptions = existingNodeOptions
        .split(/\s+/)
        .filter((f) => f && f !== "--max-old-space-size=896" && f !== "--max-old-space-size=640")
        .concat("--max-old-space-size=640")
        .join(" ");

      const child = spawn("bun", ["run", "dev"], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, NODE_OPTIONS: nodeOptions },
      });
      child.unref();
      return child.pid ?? null;
    }),
};

// ── Target 2: the loop worker (the mutation engine) ────────────────────
// Respawn mirrors ensureWorkerRunning()'s detached spawn, but appends
// stdout/stderr to the shared worker.log so boot diagnostics (armed-tier
// hydration, master-unlock rehydration, gate crashes) survive for
// postmortems — this log is the primary debugging surface for the loop.
const workerTarget: WatchTarget = {
  name: "loop-worker",
  probeUrl: "http://127.0.0.1:3004/health",
  state: freshState(),
  respawn: () =>
    issueSpawn(workerTarget, () => {
      const out = openSync(WORKER_LOG, "a");
      try {
        const child = spawn("bun", ["mini-services/loop-worker/index.ts"], {
          cwd: PROJECT_ROOT,
          detached: true,
          stdio: ["ignore", out, out],
        });
        child.unref();
        return child.pid ?? null;
      } finally {
        // The child dups the fd; close the parent's copy (no fd leak
        // per spawn — the budget allows up to 5/hour per target).
        closeSync(out);
      }
    }),
};

// ── Target 3: the websocket console sidecar ────────────────────────────
// Same detached pattern as instrumentation.ts's spawn (idempotent health
// probe there, respawn here) — output appends to the .zscripts log.
const wsTarget: WatchTarget = {
  name: "loop-ws",
  probeUrl: "http://127.0.0.1:3003/health",
  state: freshState(),
  respawn: () =>
    issueSpawn(wsTarget, () => {
      const out = openSync(WS_LOG, "a");
      try {
        const child = spawn("bun", ["index.ts"], {
          cwd: join(PROJECT_ROOT, "mini-services", "loop-ws-service"),
          detached: true,
          stdio: ["ignore", out, out],
        });
        child.unref();
        return child.pid ?? null;
      } finally {
        closeSync(out);
      }
    }),
};

// ── Target 4: the fleet-harvester siphon scaffold ──────────────────────
const harvesterTarget: WatchTarget = {
  name: "fleet-harvester",
  probeUrl: "http://127.0.0.1:3010/api/health",
  state: freshState(),
  respawn: () =>
    issueSpawn(harvesterTarget, () => {
      const out = openSync(HARVESTER_LOG, "a");
      try {
        const child = spawn("bun", ["index.ts"], {
          cwd: join(PROJECT_ROOT, "mini-services", "fleet-harvester"),
          detached: true,
          stdio: ["ignore", out, out],
        });
        child.unref();
        return child.pid ?? null;
      } finally {
        closeSync(out);
      }
    }),
};

const TARGETS: WatchTarget[] = [devServerTarget, workerTarget, wsTarget, harvesterTarget];

/** Probe one target. Resolves true iff its health URL returned 200. */
async function probeTarget(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      // Health checks are pointless from cache.
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function probeCycleFor(t: WatchTarget): Promise<void> {
  const now = Date.now();

  // Per-target grace period after a spawn: the service needs time to
  // bind its port plus first-compile time. Probing now would see a dead
  // port and double-spawn.
  if (t.state.lastSpawnAt !== null && now - t.state.lastSpawnAt < GRACE_MS_AFTER_SPAWN) {
    t.state.lastAction = "grace-period";
    return;
  }

  t.state.lastProbeAt = now;
  const ok = await probeTarget(t.probeUrl);
  t.state.lastProbeOk = ok;

  if (ok) {
    if (t.state.consecutiveFailures > 0) {
      log(`${t.name}: recovered — probe OK after ${t.state.consecutiveFailures} failure(s)`);
    }
    t.state.consecutiveFailures = 0;
    t.state.lastAction = "probe-ok";
    return;
  }

  t.state.consecutiveFailures += 1;
  t.state.lastAction = `probe-failed-x${t.state.consecutiveFailures}`;
  log(
    `${t.name}: probe FAILED (${t.state.consecutiveFailures}/${STRIKES_TO_RESPAWN}) — not answering ${t.probeUrl}`
  );

  if (t.state.consecutiveFailures >= STRIKES_TO_RESPAWN) {
    t.respawn();
  }
}

// Boot message + first probe after a short settle delay.
//
// HOT-RELOAD TIMER GUARD: `bun --hot` re-runs this module on edit but
// does NOT clear the previous module's setInterval — the first edit
// left TWO probe loops running in one process. The globalThis timer
// slot below is the same pattern as oracle-scheduler.ts: exactly one
// interval per process, ever.
const g = globalThis as unknown as {
  __devWatchdogTimer?: ReturnType<typeof setInterval> | null;
  __devWatchdogSettleTimer?: ReturnType<typeof setTimeout> | null;
};
if (g.__devWatchdogTimer) clearInterval(g.__devWatchdogTimer);
if (g.__devWatchdogSettleTimer) clearTimeout(g.__devWatchdogSettleTimer);

g.__devWatchdogSettleTimer = setTimeout(() => {
  log(
    `watching ${TARGETS.length} targets every ${PROBE_INTERVAL_MS / 1000}s ` +
      `(2-strike respawn, ${GRACE_MS_AFTER_SPAWN / 1000}s grace, ${MAX_SPAWNS_PER_HOUR}/hour budget per target): ` +
      TARGETS.map((t) => `${t.name}→${t.probeUrl}`).join(", ")
  );
  for (const t of TARGETS) void probeCycleFor(t);
}, 2_000);
g.__devWatchdogSettleTimer.unref?.();

g.__devWatchdogTimer = setInterval(() => {
  // Memory guard first: a controlled recycle deliberately makes the
  // affected target's next probe fail — ordering the guard before the
  // probes keeps the strike counting coherent within one cycle.
  try {
    runMemoryGuard();
  } catch (err) {
    log(`memguard error (watchdog continues): ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const t of TARGETS) {
    probeCycleFor(t).catch((err) => {
      // A watchdog that dies with its watchee is worthless — swallow.
      log(
        `${t.name}: probe cycle error (watchdog continues): ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }
}, PROBE_INTERVAL_MS);
g.__devWatchdogTimer.unref?.();

// ── HTTP surface: GET /health (port 3005) ─────────────────────────────
// SINGLE-OWNER RULE (operator, 2026-11-24 — the double-watchdog incident):
// on every cold boot, dev.sh's `bun run dev` wrappers AND the dev server's
// own instrumentation spawns race for this port. A watchdog that lost the
// race used to LINGER — its uncaughtException resilience (correct for probe
// errors) also swallowed the EADDRINUSE from Bun.serve, leaving a portless
// zombie running a SECOND memguard sweep and a SECOND spawn loop: double
// kills, double spawns, budget burned twice as fast, invisible to :3005.
// A loser now exits immediately — the port owner is the one true watchdog.
const bootedAt = Date.now();
let serveOk = true;
try {
  Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url).pathname;
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/health") {
      // Top-level fields keep the ORIGINAL dev-server-only shape (the
      // first rollout's consumers) — sourced from the dev-server target.
      const ds = devServerTarget.state;
      return new Response(
        JSON.stringify(
          {
            ok: true,
            watching: devServerTarget.probeUrl,
            uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
            lastProbeAt: ds.lastProbeAt ? new Date(ds.lastProbeAt).toISOString() : null,
            lastProbeOk: ds.lastProbeOk,
            consecutiveFailures: ds.consecutiveFailures,
            spawnsLastHour: spawnsInLastHour(devServerTarget),
            spawnBudget: MAX_SPAWNS_PER_HOUR,
            lastSpawnAt: ds.lastSpawnAt ? new Date(ds.lastSpawnAt).toISOString() : null,
            lastAction: ds.lastAction,
            // Full multi-target view (2026-11-24 extension).
            targets: Object.fromEntries(
              TARGETS.map((t) => [
                t.name,
                {
                  probeUrl: t.probeUrl,
                  lastProbeOk: t.state.lastProbeOk,
                  lastProbeAt: t.state.lastProbeAt
                    ? new Date(t.state.lastProbeAt).toISOString()
                    : null,
                  consecutiveFailures: t.state.consecutiveFailures,
                  spawnsLastHour: spawnsInLastHour(t),
                  spawnBudget: MAX_SPAWNS_PER_HOUR,
                  lastSpawnAt: t.state.lastSpawnAt
                    ? new Date(t.state.lastSpawnAt).toISOString()
                    : null,
                  lastAction: t.state.lastAction,
                },
              ])
            ),
          },
          null,
          2
        ),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
  });
} catch (err) {
  serveOk = false;
  log(
    `port ${PORT} unavailable (${err instanceof Error ? err.message : String(err)}) — another watchdog owns it. Exiting (single-owner rule).`
  );
  // Timers registered above die with us; the port owner keeps supervising.
  process.exit(0);
}

// The watchdog must never die from a stray rejection.
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION (watchdog stays up): ${err instanceof Error ? err.stack : String(err)}`);
});
process.on("unhandledRejection", (err) => {
  log(`UNHANDLED REJECTION (watchdog stays up): ${err instanceof Error ? err.stack : String(err)}`);
});

if (serveOk) {
  log(`listening on 0.0.0.0:${PORT} (pid ${process.pid}) — supervising ${TARGETS.length} targets`);
  log(
    `memguard armed: next-server anon>${MEMGUARD_NEXT_SERVER_ANON_MB}MB (warmup grace ${MEMGUARD_WARMUP_GRACE_MS / 1000}s), loop-worker rss>${MEMGUARD_WORKER_MB}MB → controlled SIGTERM recycle (kernel OOM kill observed at ~1.3GB, 2026-11-24)`
  );
}
