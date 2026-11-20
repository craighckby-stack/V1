/**
 * health-metrics.ts — the loop's EXTERNAL objective signal.
 *
 * WHY THIS EXISTS
 * ──────────────
 * Every other metric the loop tracks is INTERNAL:
 *   - enhanced/pushed/cycles = activity (how much the loop did)
 *   - lesson helped/hindered = the loop's own learning
 *   - self-model Brier = the loop's self-prediction accuracy
 * None of these say whether the codebase actually got healthier. The
 * loop could push 1000 mutations and have the codebase get WORSE
 * (more regressions, slower CI, shrinking test coverage) and the
 * dashboard would still show "enhanced:1000" as if it were progress.
 *
 * This module captures the EXTERNAL signal: test count, test failures,
 * tsc errors, lint errors. The delta between snapshots tells the truth
 * about whether the loop's work is making the codebase healthier.
 *
 * CAPTURE CADENCE
 * ──────────────
 * captureHealthSnapshot is called every N cycles (default 10), NOT
 * every cycle. Running the full test suite (~1.6s) + tsc (~2s) on every
 * cycle would dominate cycle latency (a cycle is ~10s). The snapshot
 * is sampled, not continuous. The trend across snapshots is still
 * meaningful: 10 cycles ≈ 100s of loop work between readings.
 *
 * HONESTY
 * ───────
 * - The capture NEVER throws into the caller. A failed tsc/test run
 *   is recorded as {ok: false, error} in the snapshot, not a crash.
 *   The trend can show "tsc broken at cycle N, fixed at cycle N+10"
 *   without losing the snapshot stream.
 * - The capture runs in the CALLER's process (the route or the
 *   worker), spawning child processes for bun test / tsc / eslint.
 *   It does NOT import the loop's own code under test (no circular
 *   dependency, no measurement-of-the-measurer contamination).
 * - protectedFileCount is read from the protected-files module (a
 *   static set at module load); a growing number alongside flat tests
 *   is the system over-protecting itself.
 *
 * FUTURE (curiosity drive, step 2)
 * ───────────────────────────────
 * The file-selection logic can read getRecentHealthTrend and prefer
 * files/situations the self-model is LEAST confident about when the
 * health trend is flat or worsening — "get bored when too confident,
 * seek surprise." That wiring is a separate, reviewable step; this
 * module is the foundation it reads.
 *
 * INTEGRITY: this module spawns child processes + reads the DB. It
 * does NOT shape prompt content or call the LLM. It's a pure
 * measurement leaf.
 */

import { spawnSync } from "node:child_process";
import { db } from "@/lib/db";
import { PROJECT_ROOT } from "../core/paths";
import { PROTECTED_FILES } from "./protected-files";

/** The snapshot shape — one row in CodebaseHealth. */
export interface HealthSnapshot {
  cycleNumber: number;
  testCount: number;
  testFail: number;
  tscErrors: number;
  lintErrors: number;
  protectedFileCount: number;
  ok: boolean;
  error?: string;
}

/** The trend — current + previous + the delta between them. */
export interface HealthTrend {
  current: HealthSnapshot;
  previous: HealthSnapshot | null;
  delta: {
    testCount: number;
    testFail: number;
    tscErrors: number;
    lintErrors: number;
  };
}

/** How often (in completed cycles) to capture a snapshot. */
export const HEALTH_SNAPSHOT_INTERVAL_CYCLES = 10;

/** Parse `bun test` output for pass/fail counts.
 *  Output line: "  522 pass\n  0 fail\nRan 522 tests across 69 files."
 *  Returns {testCount, testFail} or null if the output didn't parse. */
function parseTestOutput(output: string): { testCount: number; testFail: number } | null {
  // bun test's summary line: "Ran N tests across M files."
  const ranMatch = output.match(/Ran\s+(\d+)\s+tests?\s+across\s+\d+\s+files?/i);
  const passMatch = output.match(/^\s*(\d+)\s+pass\b/im);
  const failMatch = output.match(/^\s*(\d+)\s+fail\b/im);
  if (ranMatch) {
    return {
      testCount: parseInt(ranMatch[1], 10),
      testFail: failMatch ? parseInt(failMatch[1], 10) : 0,
    };
  }
  // Fallback: pass + fail
  if (passMatch || failMatch) {
    const pass = passMatch ? parseInt(passMatch[1], 10) : 0;
    const fail = failMatch ? parseInt(failMatch[1], 10) : 0;
    return { testCount: pass + fail, testFail: fail };
  }
  return null;
}

/** Count tsc errors from `tsc --noEmit` output.
 *  Each error line: "src/foo.ts(12,3): error TS2307: ..."
 *  Returns the count of lines matching the error pattern. */
function countTscErrors(output: string): number {
  // tsc errors: "<file>(<line>,<col>): error TSxxxx: <msg>"
  const matches = output.match(/:\s*error\s+TS\d+:/g);
  return matches ? matches.length : 0;
}

/** Count eslint errors from `eslint .` output.
 *  Each error: "<file>\n  <line>:<col>  <rule>  <severity>\n  <msg>"
 *  Returns the count of "error" severity lines. */
function countLintErrors(output: string): number {
  // eslint summary: "✖ N problems (M errors, K warnings)"
  const summaryMatch = output.match(/(\d+)\s+error/i);
  if (summaryMatch) return parseInt(summaryMatch[1], 10);
  // Fallback: count lines with "  error  " (the per-error severity column)
  const errorLines = output.match(/^\s+\d+:\d+\s+error\s+/gm);
  return errorLines ? errorLines.length : 0;
}

/** Run a command synchronously, return {stdout, stderr, exitCode}. */
function runSync(cmd: string, args: string[], timeoutMs: number): {
  stdout: string;
  stderr: string;
  exitCode: number | null;
} {
  try {
    const r = spawnSync(cmd, args, {
      cwd: PROJECT_ROOT,
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.status,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: msg, exitCode: null };
  }
}

/**
 * Capture one health snapshot by running the cheap aggregate signals.
 * Returns the snapshot (ok=false + error if any step failed critically).
 * Never throws — callers can use this in a fire-and-forget cycle hook.
 *
 * Cost: ~3-4s wall-clock (test ~1.6s + tsc ~2s + eslint ~0.3s). Called
 * every N cycles, so amortized ~0.3-0.4s per cycle. Acceptable.
 */
export function captureHealthSnapshotSync(cycleNumber: number): HealthSnapshot {
  const base: HealthSnapshot = {
    cycleNumber,
    testCount: 0,
    testFail: 0,
    tscErrors: 0,
    lintErrors: 0,
    protectedFileCount: PROTECTED_FILES.size,
    ok: true,
  };

  let firstError: string | undefined;

  // Tests (timeout 30s — the suite is ~1.6s, 30s is generous)
  const test = runSync("bun", ["test"], 30_000);
  const parsed = parseTestOutput(test.stdout + "\n" + test.stderr);
  if (parsed) {
    base.testCount = parsed.testCount;
    base.testFail = parsed.testFail;
  } else if (test.exitCode !== 0 && test.exitCode !== null) {
    // bun test exits 1 on failures; if we couldn't parse the count but
    // the exit was non-zero, record the failure honestly.
    base.testFail = -1; // sentinel: "tests failed, count unknown"
    if (!firstError) firstError = `test exit ${test.exitCode}, output unparsable`;
  }

  // tsc (timeout 60s — full project typecheck)
  const tsc = runSync("bun", ["x", "tsc", "--noEmit"], 60_000);
  base.tscErrors = countTscErrors(tsc.stdout + "\n" + tsc.stderr);
  if (tsc.exitCode === null && !firstError) {
    firstError = `tsc timed out or crashed`;
  }

  // eslint (timeout 60s)
  const lint = runSync("bun", ["x", "eslint", "."], 60_000);
  base.lintErrors = countLintErrors(lint.stdout + "\n" + lint.stderr);
  if (lint.exitCode === null && !firstError) {
    firstError = `eslint timed out or crashed`;
  }

  if (firstError) {
    base.ok = false;
    base.error = firstError;
  }

  return base;
}

/** Async wrapper — persists the snapshot to the CodebaseHealth table.
 *  Best-effort: if the DB is unavailable, returns the snapshot anyway
 *  (the caller can still log it). */
export async function captureAndPersistHealthSnapshot(
  cycleNumber: number,
): Promise<HealthSnapshot> {
  const snapshot = captureHealthSnapshotSync(cycleNumber);
  try {
    await db.codebaseHealth.create({
      data: {
        cycleNumber: snapshot.cycleNumber,
        testCount: snapshot.testCount,
        testFail: snapshot.testFail,
        tscErrors: snapshot.tscErrors,
        lintErrors: snapshot.lintErrors,
        protectedFileCount: snapshot.protectedFileCount,
      },
    });
  } catch (err) {
    // DB unavailable — return the snapshot with ok=false + error so
    // the caller knows it wasn't persisted. The measurement itself
    // still happened; just not recorded.
    const msg = err instanceof Error ? err.message : String(err);
    snapshot.ok = false;
    snapshot.error = snapshot.error ? `${snapshot.error}; db: ${msg}` : `db: ${msg}`;
  }
  return snapshot;
}

/** Read the latest N snapshots for the trend. Returns newest-first. */
export async function getRecentHealthSnapshots(limit = 2): Promise<HealthSnapshot[]> {
  try {
    const rows = await db.codebaseHealth.findMany({
      orderBy: { capturedAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({
      cycleNumber: r.cycleNumber,
      testCount: r.testCount,
      testFail: r.testFail,
      tscErrors: r.tscErrors,
      lintErrors: r.lintErrors,
      protectedFileCount: r.protectedFileCount,
      ok: true,
    }));
  } catch (err) {
    // Surface the error so a stale Prisma Client (e.g. created before a
    // schema push added the codebaseHealth model) is diagnosable instead
    // of silently returning []. The Next.js dev server caches the Prisma
    // Client on globalThis; a db:push mid-session requires a dev-server
    // restart to pick up the regenerated client.
    console.error("[health-metrics] getRecentHealthSnapshots failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** Compute the trend: current vs previous + deltas. Returns null if
 *  there are fewer than 1 snapshot. */
export async function getHealthTrend(): Promise<HealthTrend | null> {
  const snapshots = await getRecentHealthSnapshots(2);
  if (snapshots.length === 0) return null;
  const current = snapshots[0];
  const previous = snapshots.length > 1 ? snapshots[1] : null;
  return {
    current,
    previous,
    delta: {
      testCount: current.testCount - (previous?.testCount ?? 0),
      testFail: current.testFail - (previous?.testFail ?? 0),
      tscErrors: current.tscErrors - (previous?.tscErrors ?? 0),
      lintErrors: current.lintErrors - (previous?.lintErrors ?? 0),
    },
  };
}

/**
 * A digest block for the lesson distiller. Returns null when the trend is
 * healthy or absent — the distiller only sees this signal when the
 * codebase actually got WORSE, so a distilled lesson carries real weight
 * ("the loop's recent work made the codebase worse — distill what to
 * avoid"). This is the outcome-driven distillation hook: the EXTERNAL
 * objective (health) feeds the INTERNAL learning (lessons).
 *
 * Worsening = ANY of: tests fell, tsc errors rose, lint errors rose,
 * test failures rose. A flat trend (all deltas zero) does NOT fire —
 * flat means "the loop's work isn't moving the needle, but isn't
 * breaking things either," which is a curiosity-drive signal, not a
 * distillation signal.
 */
export async function getHealthTrendDigest(): Promise<string | null> {
  const trend = await getHealthTrend();
  if (!trend || !trend.previous) return null; // need 2+ snapshots
  const d = trend.delta;
  const worsening =
    d.testCount < 0 || d.testFail > 0 || d.tscErrors > 0 || d.lintErrors > 0;
  if (!worsening) return null;
  const parts: string[] = [];
  if (d.testCount < 0) parts.push(`tests fell by ${Math.abs(d.testCount)}`);
  if (d.testFail > 0) parts.push(`test failures rose by ${d.testFail}`);
  if (d.tscErrors > 0) parts.push(`tsc errors rose by ${d.tscErrors}`);
  if (d.lintErrors > 0) parts.push(`lint errors rose by ${d.lintErrors}`);
  return `Codebase health worsened since last snapshot (cycle ${trend.previous.cycleNumber} → ${trend.current.cycleNumber}): ${parts.join("; ")}. The loop's recent mutations made the codebase WORSE — distill a general lesson about what pattern of change to AVOID.`;
}
