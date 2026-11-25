/**
 * run-batch.ts — the episodic batch runner (operator, 2026-11-23).
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────
 * The 10-week observation window needs the system to run on a scheduler,
 * not on a live device. GitHub Actions provides the scheduler; this
 * script is what the scheduler calls. It:
 *
 *   1. RESTORE — imports the learning state from loop-state/db/*.json
 *      (the durable export from the previous run). On a fresh runner
 *      the DB is empty; the JSON is the only thing that traveled.
 *   2. PRE-FLIGHT — typecheck + lint + freeze check. If any gate fails,
 *      the batch ABORTS and writes a heartbeat with the failure reason.
 *      This is the extinction defense: a mutation that broke the boot
 *      path or the type system cannot silently corrupt a 10-week run.
 *   3. RUN — calls the loop's runCycle() N times (or until a time budget
 *      expires). Each cycle is a full mutation attempt (scan → LLM →
 *      gate chain → push). The freeze is checked before EVERY cycle —
 *      if the operator freezes mid-run (remotely, via the panic
 *      workflow), this script stops on the next cycle.
 *   4. EXPORT — writes the updated learning state to loop-state/db/*.json
 *      so the next run inherits the compounding layer.
 *   5. HEARTBEAT — writes loop-state/last-run.json with the run's stats.
 *      The heartbeat-check workflow reads this file daily and alerts if
 *      it's stale — the extinction-detection primitive.
 *
 * WHY DIRECT IMPORT, NOT HTTP
 * ────────────────────────────
 * The worker (mini-services/loop-worker/index.ts) serves the loop over
 * HTTP on :3004 for the dashboard scenario. In a headless batch, HTTP
 * adds port races, respawn complexity, and a second process to manage
 * — all problems we've already observed. Direct import is simpler: one
 * process, no ports, no respawn, the same loop engine. The freeze
 * check that the worker's /trigger does is replicated here (the freeze
 * is a file read, not an HTTP call — it's the same code either way).
 *
 * ENVIRONMENT
 * ───────────
 * In GitHub Actions, secrets arrive as environment variables (LLM keys,
 * LOOP_API_KEY, the PAT). Locally, this script loads .env the same way
 * the worker does. The script is therefore runnable both ways — the
 * workflow just adds the secrets layer.
 *
 * PROTECTION
 * ──────────
 * This file is on the protected list — the loop can never rewrite its
 * own boot path. Same rule as dev.sh, the watchdog, and the DB tier.
 *
 * Usage:
 *   bun scripts/run-batch.ts                    ← defaults (15 cycles or 20 min)
 *   bun scripts/run-batch.ts --cycles=30         ← 30 cycles
 *   bun scripts/run-batch.ts --minutes=30        ← 30-minute budget
 *   bun scripts/run-batch.ts --state=loop-state  ← override state dir
 *   bun scripts/run-batch.ts --dry-run           ← pre-flight only, no cycles
 */

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// Atomic write (tmp + rename) — pure fs leaf, safe to import before the
// .env loader runs. The heartbeat is read by the heartbeat-check workflow
// and the dashboard; a torn last-run.json (process dies mid-write on a
// runner) would read as corrupt and mask a healthy batch as an extinction
// signal. rename(2) is atomic on POSIX — readers see old or new, never
// partial. (2026-11-25 audit A: the four bare writeFileSync call sites
// that matter most now route through atomicWriteFileSync.)
import { atomicWriteFileSync } from "../src/lib/pipeline/core/atomic-file";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── ENV: load .env if present (local runs; Actions uses secrets → env) ─
try {
  const envSrc = readFileSync(join(PROJECT_ROOT, ".env"), "utf-8");
  for (const line of envSrc.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
} catch {
  /* no .env — rely on inherited environment (GitHub Actions secrets) */
}

// The oracle scheduler is timer+DB work that belongs to a long-lived
// process; in a short batch we don't want it firing mid-cycle.
process.env.ORACLE_SCHEDULER_DISABLED = "1";
// The dual-write bridge (oracle-events → server ingest) is for the
// dashboard; headless batches don't need it.
process.env.LOOP_WORKER = "1";

// ── ARG PARSING ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
let maxCycles = 15;
let maxMinutes = 20;
let stateDir = "loop-state";
let dryRun = false;

for (const a of args) {
  if (a.startsWith("--cycles=")) maxCycles = parseInt(a.slice(9), 10) || maxCycles;
  else if (a.startsWith("--minutes=")) maxMinutes = parseInt(a.slice(10), 10) || maxMinutes;
  else if (a.startsWith("--state=")) stateDir = a.slice(8);
  else if (a === "--dry-run") dryRun = true;
}

const STATE_ABS = path.resolve(PROJECT_ROOT, stateDir);
const HEARTBEAT_PATH = join(STATE_ABS, "last-run.json");
const DEADLINE_MS = Date.now() + maxMinutes * 60 * 1000;

// ── CRASH BACKOFF / CIRCUIT BREAKER (2026-11-25 audit A) ─────────────
// The old loop treated a crashed cycle as free: log it, move on to the
// next cycle immediately. On a systemic break (a broken import graph, a
// dead LLM credential, an API outage) that burned all 15 cycles on the
// SAME failure in minutes, produced 15 identical postmortems, and — worst
// — the fast retry loop hid the outage's duration. Now: exponential
// backoff between a crash and the next attempt, and a circuit breaker
// that aborts the batch after 4 CONSECUTIVE crashes (a transient LLM hiccup
// recovers; a systemic break shouldn't consume the whole time budget).
const CRASH_BACKOFF_MS = [5_000, 15_000, 45_000];
const MAX_CONSECUTIVE_CRASHES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Heartbeat {
  at: string;
  ok: boolean;
  cyclesAttempted: number;
  cyclesCompleted: number;
  branchesBefore: number;
  branchesAfter: number;
  frozen: boolean;
  preflight: { typecheck: boolean; lint: boolean; reason?: string };
  error?: string;
  durationMs: number;
}

function writeHeartbeat(partial: Partial<Heartbeat>): void {
  mkdirSync(STATE_ABS, { recursive: true });
  const beat: Heartbeat = {
    at: new Date().toISOString(),
    ok: false,
    cyclesAttempted: 0,
    cyclesCompleted: 0,
    branchesBefore: 0,
    branchesAfter: 0,
    frozen: false,
    preflight: { typecheck: false, lint: false },
    durationMs: 0,
    ...partial,
  };
  // Atomic write — see the import comment. rename(2) guarantees the
  // heartbeat-check workflow never reads a torn JSON.
  atomicWriteFileSync(HEARTBEAT_PATH, JSON.stringify(beat, null, 2) + "\n");
}

// ── PRE-FLIGHT: typecheck + lint (the extinction defense) ─────────────
// A mutation that breaks the type system or the lint rules could still
// pass the loop's own gates (the in-memory typecheck is per-file, not
// whole-project). This is the whole-project gate the loop doesn't run
// on itself. If it fails, the batch aborts — the 10-week run stops
// rather than propagating a broken state.
function preflight(): { typecheck: boolean; lint: boolean; reason?: string } {
  // TIMEOUT 240s (2026-11-25 audit A): the old 120s occasionally misfired
  // on a COLD GitHub Actions runner — bunx resolving the toolchain from an
  // empty npm cache on the first preflight looked exactly like a hung
  // compiler, spawnSync returned SIGTERM, and the batch aborted with
  // "tsc exited null" — the extinction defense firing on infrastructure,
  // not on a real mutation. 240s covers a cold bunx resolve (~60-90s) with
  // headroom for the actual typecheck (~40s warm). The loop's own gates
  // are unaffected; this is the whole-project gate only.
  console.log("[batch] pre-flight: typecheck");
  const tsc = spawnSync("bunx", ["tsc", "--noEmit"], { cwd: PROJECT_ROOT, encoding: "utf8", timeout: 240_000 });
  if (tsc.status !== 0) {
    const reason = `tsc exited ${tsc.status}: ${(tsc.stderr || tsc.stdout).slice(0, 500)}`;
    console.error(`[batch] pre-flight FAILED (typecheck): ${reason}`);
    return { typecheck: false, lint: false, reason };
  }
  console.log("[batch] pre-flight: typecheck OK");

  console.log("[batch] pre-flight: lint");
  const eslint = spawnSync("bunx", ["eslint", "."], { cwd: PROJECT_ROOT, encoding: "utf8", timeout: 240_000 });
  if (eslint.status !== 0) {
    const reason = `eslint exited ${eslint.status}: ${(eslint.stderr || eslint.stdout).slice(0, 500)}`;
    console.error(`[batch] pre-flight FAILED (lint): ${reason}`);
    return { typecheck: true, lint: false, reason };
  }
  console.log("[batch] pre-flight: lint OK");
  return { typecheck: true, lint: true };
}

// ── BRANCH COUNT (for the heartbeat — the observable growth signal) ──
async function countLoopBranches(): Promise<number> {
  try {
    const { getStoredTarget } = await import("../src/lib/pipeline/autonomous/push-target");
    const target = await getStoredTarget();
    if (!target?.token) return 0;
    const res = await fetch(
      `https://api.github.com/repos/${target.repo}/branches?per_page=100`,
      { headers: { Authorization: `Bearer ${target.token}`, Accept: "application/vnd.github.v3+json" } }
    );
    if (!res.ok) return 0;
    const data = (await res.json()) as { name: string }[];
    return data.filter((b) => /^loop-\d+$/.test(b.name)).length;
  } catch {
    return 0;
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  const t0 = Date.now();
  console.log(`[batch] start — ${maxCycles} cycles or ${maxMinutes}min budget, state=${stateDir}${dryRun ? " (DRY RUN)" : ""}`);

  // 1. RESTORE
  console.log("[batch] step 1/5: restore learning state from JSON");
  const restore = spawnSync("bun", ["scripts/loop-state.ts", "import", stateDir], {
    cwd: PROJECT_ROOT, encoding: "utf8", timeout: 60_000,
  });
  if (restore.status !== 0) {
    console.error(`[batch] RESTORE FAILED (exit ${restore.status}): ${restore.stdout}${restore.stderr}`);
    writeHeartbeat({ ok: false, error: `restore failed: ${restore.status}`, durationMs: Date.now() - t0, preflight: { typecheck: false, lint: false } });
    return 1;
  }
  console.log(restore.stdout);

  // 2. PRE-FLIGHT
  console.log("[batch] step 2/5: pre-flight (typecheck + lint)");
  const pf = preflight();
  if (!pf.typecheck || !pf.lint) {
    writeHeartbeat({ ok: false, error: `pre-flight failed: ${pf.reason}`, durationMs: Date.now() - t0, preflight: pf });
    return 1;
  }

  // Freeze check — the system must be explicitly unfrozen to start.
  const { isMutationFrozen, readMutationFreezeState } = await import(
    "../src/lib/pipeline/autonomous/mutation-freeze"
  );
  const frozen = isMutationFrozen();
  if (frozen) {
    const state = readMutationFreezeState();
    console.log(`[batch] FROZEN — refusing to run cycles. Freeze state: ${JSON.stringify(state)}`);
    writeHeartbeat({ ok: true, frozen: true, preflight: pf, durationMs: Date.now() - t0, error: "frozen — operator must unfreeze before the batch can run cycles" });
    console.log("[batch] heartbeat written. To start the 10-week run: unfreeze the system (operator PIN), then re-trigger the workflow.");
    return 0;
  }

  if (dryRun) {
    console.log("[batch] dry-run complete — pre-flight passed, no cycles run");
    writeHeartbeat({ ok: true, frozen: false, preflight: pf, durationMs: Date.now() - t0, error: "dry-run" });
    return 0;
  }

  // 3. RUN
  console.log(`[batch] step 3/5: run ${maxCycles} cycles (or ${maxMinutes}min)`);
  const branchesBefore = await countLoopBranches();
  const { liveSelfEnhanceLoop } = await import(
    "../src/lib/pipeline/autonomous/self-enhance-loop"
  );
  const agentLlm = await import("../src/lib/pipeline/llm/agent-llm");
  agentLlm.warmZaiCortex();
  const loop = liveSelfEnhanceLoop();

  let cyclesCompleted = 0;
  let cyclesAttempted = 0;
  let consecutiveCrashes = 0;
  for (let i = 0; i < maxCycles; i++) {
    if (Date.now() > DEADLINE_MS) {
      console.log(`[batch] time budget (${maxMinutes}min) reached after ${i} cycles`);
      break;
    }
    // Re-check freeze before every cycle — if the operator panics-freezes
    // mid-run, we stop cleanly on the next iteration.
    if (isMutationFrozen()) {
      console.log(`[batch] freeze detected mid-run at cycle ${i} — stopping`);
      break;
    }
    cyclesAttempted++;
    console.log(`[batch] cycle ${i + 1}/${maxCycles} (deadline in ${Math.round((DEADLINE_MS - Date.now()) / 1000)}s)`);
    try {
      const result = await loop.runCycle();
      const enhanced = result.filesEnhanced ?? 0;
      const scanned = result.filesScanned ?? 0;
      console.log(`[batch] cycle ${i + 1} done — scanned=${scanned} enhanced=${enhanced}`);
      cyclesCompleted++;
      consecutiveCrashes = 0;
    } catch (err) {
      consecutiveCrashes++;
      console.error(`[batch] cycle ${i + 1} CRASHED (${consecutiveCrashes} consecutive):`, err instanceof Error ? err.message : err);
      // Continue — one bad cycle shouldn't kill the whole batch.
      // CIRCUIT BREAKER: 4 consecutive crashes means something systemic
      // broke (import graph, credential, API). Burn no more cycles/time —
      // abort and let the heartbeat carry the failure honestly.
      if (consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
        const reason = `circuit breaker: ${consecutiveCrashes} consecutive crashed cycles — aborting batch (last error: ${err instanceof Error ? err.message : String(err)})`;
        console.error(`[batch] ${reason}`);
        writeHeartbeat({
          ok: false,
          cyclesAttempted,
          cyclesCompleted,
          preflight: pf,
          error: reason,
          durationMs: Date.now() - t0,
        });
        return 1;
      }
      // BACKOFF before the next attempt — exponential (5s/15s/45s, then
      // hold). Gives a rate-limited LLM or a flapping API room to recover
      // instead of hammering it, and spreads identical failures out in the
      // timeline instead of stacking them back-to-back.
      const backoff = CRASH_BACKOFF_MS[Math.min(consecutiveCrashes - 1, CRASH_BACKOFF_MS.length - 1)];
      console.log(`[batch] backing off ${backoff / 1000}s before next attempt`);
      await sleep(backoff);
    }
  }

  // 4. EXPORT
  console.log("[batch] step 4/5: export learning state to JSON");
  const branchesAfter = await countLoopBranches();
  const exportRun = spawnSync("bun", ["scripts/loop-state.ts", "export", stateDir], {
    cwd: PROJECT_ROOT, encoding: "utf8", timeout: 60_000,
  });
  if (exportRun.status !== 0) {
    console.error(`[batch] EXPORT FAILED (exit ${exportRun.status}): ${exportRun.stdout}${exportRun.stderr}`);
    // Still write the heartbeat — the cycles ran, the state just didn't save.
  } else {
    console.log(exportRun.stdout);
  }

  // 5. HEARTBEAT
  console.log("[batch] step 5/5: write heartbeat");
  writeHeartbeat({
    ok: true,
    frozen: false,
    cyclesAttempted,
    cyclesCompleted,
    branchesBefore,
    branchesAfter,
    preflight: pf,
    durationMs: Date.now() - t0,
  });

  console.log(`[batch] done — ${cyclesCompleted}/${cyclesAttempted} cycles, ${branchesAfter - branchesBefore} new branches, ${Date.now() - t0}ms`);
  return 0;
}

main().catch((err) => {
  console.error("[batch] FATAL:", err instanceof Error ? err.stack : err);
  writeHeartbeat({ ok: false, error: `fatal: ${err instanceof Error ? err.message : String(err)}`, durationMs: 0, preflight: { typecheck: false, lint: false } });
  process.exit(1);
});
