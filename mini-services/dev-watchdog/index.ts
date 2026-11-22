/**
 * Dev Watchdog (port 3005) — keeps the Next.js dev server alive.
 *
 * WHY THIS EXISTS (the 04:46 darkness):
 *   On 2026-11-22 ~04:46, the kernel OOM-killer shot the next-server
 *   process (1.5GB RSS after ~2h of Turbopack recompiles driven by the
 *   self-enhancement loop's constant src/ mutations — dmesg: "Out of
 *   memory: Killed process 1764 (next-server)"). The loop-worker kept
 *   working (cycles, gates, pushes all green), but the dashboard went
 *   dark: gateway 502s, no status APIs, nothing supervises the dev
 *   server. The system already had one-directional supervision — the
 *   Next server respawns the loop-worker via ensureWorkerRunning() —
 *   but the reverse direction was missing. This service closes the
 *   loop: either process dying gets revived by the other. Mutual
 *   supervision, no single point of darkness.
 *
 * DESIGN:
 *   - PROBE, DON'T ASSUME: fetch /api/healthz on 127.0.0.1:3000 with a
 *     5s timeout every 30s. A 200 = alive. Anything else (ECONNREFUSED,
 *     timeout, 5xx) = one strike.
 *   - TWO-STRIKE RULE: respawn only after 2 consecutive failed probes
 *     (~60s dark). A single blip — a config-change restart, a Turbopack
 *     memory-limit restart (see next.config.ts), a GC pause — must not
 *     trigger a fork.
 *   - GRACE PERIOD: after a spawn, suppress probes for 90s — `next dev`
 *     takes 5-15s to bind, plus first-compile time. Probing during
 *     boot would double-spawn.
 *   - SPAWN BUDGET: max 5 spawns per rolling hour. If the dev server
 *     can't stay up, forking forever helps nobody — the budget caps the
 *     blast radius and the /health endpoint shows the operator exactly
 *     how many attempts burned.
 *   - DETACHED SPAWN: the child is detached (reparented to init), stdio
 *     ignored — the `dev` npm script pipes through `tee dev.log`
 *     itself, so the log still lands in the project root. The child
 *     outlives this watchdog's own death/restart.
 *   - LOG ROTATION: before each spawn, dev.log is rotated to dev.log.1
 *     (one generation kept) so the pre-crash log isn't truncated by
 *     tee and the crash context survives for postmortems.
 *   - NO --hot FOR THE SPAWNED CHILD (it IS the dev server — hot reload
 *     is its native mode anyway). This service itself runs under
 *     `bun --hot` (see package.json) per the mini-service convention.
 *   - CRASH-SILENT: an uncaught error in the probe loop is logged and
 *     swallowed — a watchdog that dies with its watchee is worthless.
 *
 * Port 3005 serves GET /health with the full watchdog state — visible
 * to the operator through the gateway's XTransformPort pattern.
 */

import { spawn } from "child_process";
import { existsSync, renameSync } from "fs";
import { join } from "path";

const PORT = 3005;
/** mini-services/dev-watchdog → project root (two levels up). */
const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const DEV_LOG = join(PROJECT_ROOT, "dev.log");
const DEV_LOG_OLD = join(PROJECT_ROOT, "dev.log.1");

const PROBE_URL = "http://127.0.0.1:3000/api/healthz";
const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const STRIKES_TO_RESPAWN = 2;
const GRACE_MS_AFTER_SPAWN = 90_000;
const MAX_SPAWNS_PER_HOUR = 5;

interface WatchdogState {
  bootedAt: number;
  lastProbeAt: number | null;
  lastProbeOk: boolean | null;
  consecutiveFailures: number;
  spawnHistory: number[]; // epoch ms of each spawn (rolling hour)
  lastSpawnAt: number | null;
  lastAction: string;
}

const state: WatchdogState = {
  bootedAt: Date.now(),
  lastProbeAt: null,
  lastProbeOk: null,
  consecutiveFailures: 0,
  spawnHistory: [],
  lastSpawnAt: null,
  lastAction: "boot",
};

function log(msg: string): void {
  console.log(`[DEV-WATCHDOG] ${new Date().toISOString()} ${msg}`);
}

/** Probe the dev server. Resolves true iff /api/healthz returned 200. */
async function probeDevServer(): Promise<boolean> {
  try {
    const res = await fetch(PROBE_URL, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      // Health checks are pointless from cache.
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Spawns within the last hour (rolling budget window). */
function spawnsInLastHour(): number {
  const cutoff = Date.now() - 3_600_000;
  state.spawnHistory = state.spawnHistory.filter((t) => t >= cutoff);
  return state.spawnHistory.length;
}

/** Respawn the dev server: rotate the log, then spawn `bun run dev`
 *  detached. Returns true if the spawn was issued. */
function respawnDevServer(): boolean {
  if (spawnsInLastHour() >= MAX_SPAWNS_PER_HOUR) {
    state.lastAction = "spawn-refused-budget-exhausted";
    log(
      `spawn REFUSED — ${MAX_SPAWNS_PER_HOUR}/hour budget exhausted ` +
        `(total this hour: ${spawnsInLastHour()}). Manual intervention needed.`,
    );
    return false;
  }

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

  // V8 heap cap for the respawned dev server. The two OOM kills
  // (04:46, 05:09) both hit next-server at 1.26-1.55GB RSS when its
  // heap growth coincided with a transient gate child-process (eslint
  // ~500MB / tsc ~1GB). Capping the heap at 896MB makes V8 GC harder
  // instead of growing — worst case the dashboard lags, never dies.
  // Existing NODE_OPTIONS (if any) are preserved, not clobbered.
  const existingNodeOptions = process.env.NODE_OPTIONS ?? "";
  const nodeOptions = existingNodeOptions
    .split(/\s+/)
    .filter((f) => f && f !== "--max-old-space-size=896")
    .concat("--max-old-space-size=896")
    .join(" ");

  const child = spawn("bun", ["run", "dev"], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  });
  child.unref();

  const now = Date.now();
  state.spawnHistory.push(now);
  state.lastSpawnAt = now;
  state.consecutiveFailures = 0;
  state.lastAction = "spawned";
  log(
    `respawned dev server (pid ${child.pid}, spawn #${state.spawnHistory.length} this hour, ` +
      `${spawnsInLastHour()}/${MAX_SPAWNS_PER_HOUR} budget used)`,
  );
  return true;
}

async function probeCycle(): Promise<void> {
  const now = Date.now();

  // Grace period after a spawn: the server needs 5-15s to bind plus
  // first-compile time. Probing now would see a dead port and
  // double-spawn.
  if (state.lastSpawnAt !== null && now - state.lastSpawnAt < GRACE_MS_AFTER_SPAWN) {
    state.lastAction = "grace-period";
    return;
  }

  state.lastProbeAt = now;
  const ok = await probeDevServer();
  state.lastProbeOk = ok;

  if (ok) {
    if (state.consecutiveFailures > 0) {
      log(`recovered — probe OK after ${state.consecutiveFailures} failure(s)`);
    }
    state.consecutiveFailures = 0;
    state.lastAction = "probe-ok";
    return;
  }

  state.consecutiveFailures += 1;
  state.lastAction = `probe-failed-x${state.consecutiveFailures}`;
  log(`probe FAILED (${state.consecutiveFailures}/${STRIKES_TO_RESPAWN}) — dev server not answering ${PROBE_URL}`);

  if (state.consecutiveFailures >= STRIKES_TO_RESPAWN) {
    respawnDevServer();
  }
}

// Boot message + first probe after a short settle delay (lets this
// service's own HTTP server bind before the first log line matters).
//
// HOT-RELOAD TIMER GUARD: `bun --hot` re-runs this module on edit but
// does NOT clear the previous module's setInterval — the first edit
// left TWO probe loops running in one process (duplicate FAILED lines
// 1.2s apart, a phantom "recovered", and a double-spawn risk). The
// globalThis timer slot below is the same pattern as
// oracle-scheduler.ts: exactly one interval per process, ever.
const g = globalThis as unknown as {
  __devWatchdogTimer?: ReturnType<typeof setInterval> | null;
  __devWatchdogSettleTimer?: ReturnType<typeof setTimeout> | null;
};
if (g.__devWatchdogTimer) clearInterval(g.__devWatchdogTimer);
if (g.__devWatchdogSettleTimer) clearTimeout(g.__devWatchdogSettleTimer);

g.__devWatchdogSettleTimer = setTimeout(() => {
  log(
    `watching ${PROBE_URL} every ${PROBE_INTERVAL_MS / 1000}s ` +
      `(2-strike respawn, ${GRACE_MS_AFTER_SPAWN / 1000}s grace, ${MAX_SPAWNS_PER_HOUR}/hour budget)`,
  );
  void probeCycle();
}, 2_000);
g.__devWatchdogSettleTimer.unref?.();

g.__devWatchdogTimer = setInterval(() => {
  probeCycle().catch((err) => {
    // A watchdog that dies with its watchee is worthless — swallow.
    log(`probe cycle error (watchdog continues): ${err instanceof Error ? err.message : String(err)}`);
  });
}, PROBE_INTERVAL_MS);
g.__devWatchdogTimer.unref?.();

// ── HTTP surface: GET /health (port 3005) ─────────────────────────────
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
      return new Response(
        JSON.stringify(
          {
            ok: true,
            watching: PROBE_URL,
            uptimeSeconds: Math.round((Date.now() - state.bootedAt) / 1000),
            lastProbeAt: state.lastProbeAt ? new Date(state.lastProbeAt).toISOString() : null,
            lastProbeOk: state.lastProbeOk,
            consecutiveFailures: state.consecutiveFailures,
            spawnsLastHour: spawnsInLastHour(),
            spawnBudget: MAX_SPAWNS_PER_HOUR,
            lastSpawnAt: state.lastSpawnAt ? new Date(state.lastSpawnAt).toISOString() : null,
            lastAction: state.lastAction,
          },
          null,
          2,
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
});

// The watchdog must never die from a stray rejection.
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION (watchdog stays up): ${err instanceof Error ? err.stack : String(err)}`);
});
process.on("unhandledRejection", (err) => {
  log(`UNHANDLED REJECTION (watchdog stays up): ${err instanceof Error ? err.stack : String(err)}`);
});

log(`listening on 0.0.0.0:${PORT} (pid ${process.pid})`);
