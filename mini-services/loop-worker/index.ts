/**
 * Loop Worker (port 3004) — the self-enhancement loop, extracted from the
 * Next.js server process.
 *
 * WHY THIS EXISTS (the "worker split" refactor):
 *   The loop used to run as a `globalThis.__selfEnhanceLoop` singleton
 *   INSIDE the Next.js dev server. That single decision caused an entire
 *   class of complexity:
 *     - hot-swap's globalThis pin-clearing machinery (Turbopack module
 *       graphs re-create singletons per compile; the reaper could restore
 *       STALE code — see postmortem operator-edit-module-reload.json)
 *     - the in-memory-typecheck dance (Turbopack must never see a broken
 *       file, because the loop shares the process with the compiler)
 *     - event-loop coupling: every spawnSync gate froze all /api/* polls
 *   A dedicated worker deletes the class: the loop is just a Bun process.
 *   Next.js becomes a pure UI + read-only proxy over the worker and DB.
 *
 * CONTRACT: every endpoint mirrors the JSON shape of the /api/self-enhance/*
 * route it replaced, so the dashboard needs zero changes. Armed-state
 * (.git/info/loop-self-enhance-armed.json) stays SERVER-owned: control
 * routes write the intent tier, the worker's constructor auto-start honors
 * it at boot — exactly the pre-split semantics.
 *
 * NO --hot, deliberately: this process runs the loop that MUTATES the very
 * source files --hot watches. A mid-cycle hot-restart would abort an
 * in-flight gate chain (the exact failure mode the in-memory typecheck was
 * built to avoid). Restarts are operator actions or instrumentation
 * respawns — never file-watch reactions.
 *
 * ORACLE EVENTS: this process sets LOOP_WORKER=1 so oracle-events.ts
 * dual-writes its ring-buffer events to the Next.js server's ingest
 * endpoint — the console stream keeps one ring, one sequence space, and
 * the UI never notices the loop changed processes.
 */

import { readFileSync } from "fs";
import { join } from "path";

const PORT = 3004;
/** mini-services/loop-worker → project root (two levels up). */
const PROJECT_ROOT = join(import.meta.dir, "..", "..");

// ── ENV: load the project .env BEFORE any pipeline import ────────────────
// The pipeline needs DATABASE_URL (Prisma) and LLM keys at import time.
// Bun auto-loads .env from CWD, but the worker may be spawned from the
// project root OR its own dir — so load explicitly and never override
// variables the spawner already set.
try {
  const envSrc = readFileSync(join(PROJECT_ROOT, ".env"), "utf-8");
  for (const line of envSrc.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
} catch (err) {
  console.error("[LOOP-WORKER] Failed to load .env file:", err instanceof Error ? err.stack : err);
  /* no .env — rely on inherited environment */
}
// Activates the oracle-events dual-write bridge (worker → server ingest).
process.env.LOOP_WORKER = "1";

// Never boot a second oracle scheduler here: the scheduler is timer+DB
// work that belongs to the server process (it boots on first oracle API
// route import there). oracle-auto does NOT import it, so no guard is
// strictly needed — this env flag is belt-and-suspenders for any future
// transitive import.
process.env.ORACLE_SCHEDULER_DISABLED = "1";

// Fail-closed warning fires at most once per worker process.
let warnedKeyMissing = false;

async function main() {
  // Dynamic imports: the entire pipeline graph (Prisma client, z-ai SDK,
  // TypeScript compiler) loads only after the env above is in place.
  const { liveSelfEnhanceLoop } = await import(
    "../../src/lib/pipeline/autonomous/self-enhance-loop"
  );
  const agentLlm = await import("../../src/lib/pipeline/llm/agent-llm");
  // Operator mutation freeze — pure leaf module (fs+path only), safe to
  // import statically, but kept here with the graph for symmetry. Read
  // LIVE on every check: the control route writes the shared file and
  // this process sees it on the next guard evaluation, no restart.
  const freeze = await import(
    "../../src/lib/pipeline/autonomous/mutation-freeze"
  );
  // Health metrics — powers the periodic baseline check below (keeps the
  // dashboard's health trend flowing even while the loop is stopped or
  // frozen: the system keeps watching its own codebase integrity).
  const healthMetrics = await import(
    "../../src/lib/pipeline/autonomous/health-metrics"
  );

  // Warm the Z.AI cortex in THIS process — the loop's LLM calls happen
  // here now; the server's warm-up no longer covers them.
  agentLlm.warmZaiCortex();

  const loop = liveSelfEnhanceLoop();
  // NOTE: no explicit start call — the constructor's boot auto-start
  // honors the armed tier (.git/info/loop-self-enhance-armed.json), the
  // same contract the in-server loop had. Control routes write that tier.

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url).pathname;
      try {
        // Liveness — used by the server's ensureWorkerRunning() respawn
        // logic and /api/health.
        if (url === "/health") {
          return json({
            ok: true,
            running: loop.isRunning(),
            continuous: loop.isContinuous(),
            pid: process.pid,
          });
        }

        // Mirror of GET /api/self-enhance/status — identical shape.
        if (url === "/status") {
          // Await the durable-stats hydration gate before snapshotting so
          // the first poll after a boot returns the real persisted
          // counters, not the pre-hydration zeros (which would show as
          // cycles:0 while the self-model panel already has historical
          // attempts bootstrapped from the corpus). The promise never
          // rejects and resolves in <1s on a warm boot (file read), so
          // the added latency is negligible after the first poll.
          await loop.whenStatsReady();
          const freezeState = freeze.readMutationFreezeState();
          return json({
            running: loop.isRunning(),
            stats: loop.getStats(),
            logs: loop.getLogs(),
            currentFile: loop.getCurrentFile(),
            // The AUTHORITATIVE LLM gate for loop work lives in this
            // process now — the UI's 429 countdown reads it from here.
            llmGate: agentLlm.llmGateInfo?.(),
            saturation: loop.getSaturation(),
            // Operator mutation-freeze state — read from the shared
            // wipe-proof file so the dashboard shows the lock even if
            // this worker was booted before the freeze landed. The
            // server-side status route re-reads the same file, so the
            // two sources can never disagree for more than a poll.
            mutationFrozen: freezeState?.frozen === true,
            freezeState: freezeState?.frozen ? freezeState : null,
            // Operator master-unlock flag (secret master PIN 4444 /
            // LOOP_MASTER_PIN — NOT in the README). While true, the
            // UI skips the per-file PIN prompt and unlocks directly.
            // Resets on worker restart. See self-enhance-loop.ts
            // `masterUnlocked` field comment for the full rationale.
            masterUnlocked: loop.isMasterUnlocked(),
            // Honest live-branch accounting vs the monotonic loop-NN
            // counter (which is a lifetime mutation tally, not a live
            // count). Surfaces the retention drain's last result so the
            // dashboard can show "N live / max loop-M" instead of letting
            // "loop-1012" read as ~1000 branches. Null before the first
            // drain that ran; refreshes on the next push.
            branchRetention: loop.getBranchRetention(),
          });
        }

        if (req.method !== "POST") {
          return json({ error: "method not allowed" }, 405);
        }

        // ── API-KEY GATE, FAIL-CLOSED (operator, 2026-11-23) ────────────
        // This port is reachable through the gateway's XTransformPort
        // pattern — the /unlock PIN re-validation below exists for exactly
        // that reason, and the freeze checks on /start /reboot /trigger
        // have the same rationale. The same contract must hold for the
        // API key: src/middleware.ts gates the app's mutating routes,
        // but these POST mirrors are a SECOND mutating surface. Without
        // this gate, the app-side hardening is bypassable by talking to
        // :3004 directly (start/stop/reboot/trigger/skip/rescan with no
        // auth at all). Semantics mirror the middleware exactly:
        //   LOOP_API_KEY unset  → 503 fail-closed (the gate LOCKS, not opens)
        //   wrong/missing key  → 401
        // The worker loads the project .env at boot (see the ENV block
        // above), so the key configured for the app is available here.
        // GET /health and /status stay open — read-only, used by the
        // server's respawn probe and the status proxy.
        const expectedKey = process.env.LOOP_API_KEY;
        if (!expectedKey) {
          if (!warnedKeyMissing) {
            warnedKeyMissing = true;
            console.error(
              "[LOOP-WORKER] LOOP_API_KEY is not set — mutating worker endpoints are LOCKED (fail-closed). " +
                "Set LOOP_API_KEY in the project .env to enable them with the x-loop-key header."
            );
          }
          return json(
            {
              error:
                "mutation gate locked — LOOP_API_KEY is not configured on the worker (fail-closed). Set it in .env, then send it as the x-loop-key header.",
            },
            503
          );
        }
        if (req.headers.get("x-loop-key") !== expectedKey) {
          return json(
            { error: "unauthorized — mutating worker endpoints require the x-loop-key header." },
            401
          );
        }

        // Mirror of POST /api/self-enhance/start (armed write stays on the
        // server; this only drives the runtime).
        if (url === "/start") {
          // Operator mutation freeze: refuse to launch the continuous
          // loop. The edge route already refused (and never wrote
          // armed:true), but this port is reachable via the gateway's
          // XTransformPort pattern — the freeze must hold here too.
          if (freeze.isMutationFrozen()) {
            return json(
              {
                started: false,
                frozen: true,
                error: freeze.mutationFreezeNotice(),
              },
              423
            );
          }
          if (loop.isContinuous()) {
            return json({
              started: true,
              alreadyRunning: true,
              message: "Continuous self-enhancement already running",
            });
          }
          loop.runContinuous().catch((err) => {
            console.error("[LOOP-WORKER] continuous loop crashed:", err instanceof Error ? err.stack : err);
          });
          return json({ started: true });
        }

        // Mirror of POST /api/self-enhance/stop (runtime only; the armed
        // tier was already cleared server-side).
        if (url === "/stop") {
          loop.stop();
          return json({ stopped: true });
        }

        // Mirror of POST /api/self-enhance/reboot: stop → (armed already
        // re-written server-side) → fresh runContinuous.
        if (url === "/reboot") {
          if (freeze.isMutationFrozen()) {
            return json(
              {
                rebooted: false,
                frozen: true,
                error: freeze.mutationFreezeNotice(),
              },
              423
            );
          }
          const wasRunning = loop.isContinuous();
          if (wasRunning) loop.stop();
          loop.runContinuous().catch((err) => {
            console.error("[LOOP-WORKER] reboot restart crashed:", err instanceof Error ? err.stack : err);
          });
          return json({
            rebooted: true,
            running: true,
            wasRunning,
            armed: true,
            message: wasRunning
              ? "Self-enhancement loop rebooted — in-flight cycle aborted, fresh loop started with the new provider chain. Armed state persisted — it auto-starts on the next system boot too."
              : "Self-enhancement loop started — running with the new provider chain. Armed state persisted — it auto-starts on the next system boot too.",
          });
        }

        // Mirror of POST /api/self-enhance/trigger (cooldown is enforced
        // at the server route — the edge is the right place for it).
        if (url === "/trigger") {
          if (freeze.isMutationFrozen()) {
            return json(
              {
                filesScanned: 0,
                filesEnhanced: 0,
                results: [],
                frozen: true,
                error: freeze.mutationFreezeNotice(),
              },
              423
            );
          }
          const result = await loop.runCycle();
          return json(result);
        }

        // Mirror of POST /api/self-enhance/rescan
        if (url === "/rescan") {
          const scan = await loop.rescan();
          return json({ ok: true, ...scan });
        }

        // Mirror of POST /api/self-enhance/unlock  body: { filePath, pin? }
        // The PIN is validated HERE as well (not only at the Next edge
        // route) because this port is reachable through the gateway's
        // XTransformPort pattern — the edge route alone is not enough.
        // Never log the submitted PIN; log only the outcome + path.
        //
        // TWO PIN TIERS (operator + master), 2026-11-17:
        //   - operator PIN (LOOP_UNLOCK_PIN, default "691"): documented
        //     ONCE mid-README. The friction gate. Unlocks one file per
        //     entry.
        //   - master PIN (LOOP_MASTER_PIN, default "4444"): NOT in the
        //     README — operator-only secret. Entering it once flips
        //     `loop.masterUnlocked` to true for the rest of this worker
        //     process's life; while true, every subsequent [unlock]
        //     request (with or without a PIN) auto-passes — the
        //     operator's active management session no longer needs a
        //     PIN per file. Resets on worker restart (a natural "new
        //     session" boundary; persisting it would be a permanent
        //     silent bypass, which is the exact thing the friction gate
        //     exists to prevent).
        // The master PIN protects nothing the operator PIN doesn't
        // already protect — the real code-safety boundary is
        // protected-files + the gate chain, which no PIN can bypass.
        if (url === "/unlock") {
          let body;
          try {
            body = await req.json();
          } catch {
            return json({ ok: false, error: "Invalid JSON in request body" }, 400);
          }

          if (!body || typeof body !== "object" || !("filePath" in body)) {
            return json({ ok: false, error: "filePath is required in request body" }, 400);
          }

          const { filePath, pin } = body as { filePath?: unknown; pin?: unknown };
          if (!filePath || typeof filePath !== "string") {
            return json({ ok: false, error: "filePath must be a non-empty string" }, 400);
          }

          const operatorPin = ((process.env.LOOP_UNLOCK_PIN ?? "").trim() || "691");
          const masterPin = ((process.env.LOOP_MASTER_PIN ?? "").trim() || "4444");
          const pinStr = typeof pin === "string" ? pin.trim() : "";

          // Gate decision order:
          //   1. master PIN submitted → activate master mode + unlock
          //      (this is the "done once, passes the rest" entry).
          //   2. master mode already active → unlock directly, PIN or
          //      no PIN (the operator already proved knowledge this
          //      session). Return masterUnlocked:true so the edge +
          //      UI can sync their state.
          //   3. operator PIN submitted → normal single-file unlock.
          //   4. no PIN and master not active → 400 (pin required).
          //   5. PIN present but matches neither → 403 (wrong PIN).
          if (pinStr === masterPin) {
            loop.setMasterUnlocked();
            const result = loop.unlockFile(filePath);
            console.log(`[LOOP-WORKER] unlock (master) for ${filePath}: ${result.unlocked ? "ok" : result.reason}`);
            return json({ ok: result.unlocked, ...result, masterUnlocked: true });
          }
          if (loop.isMasterUnlocked()) {
            const result = loop.unlockFile(filePath);
            console.log(`[LOOP-WORKER] unlock (master-auto) for ${filePath}: ${result.unlocked ? "ok" : result.reason}`);
            return json({ ok: result.unlocked, ...result, masterUnlocked: true });
          }
          if (pinStr === operatorPin) {
            const result = loop.unlockFile(filePath);
            console.log(`[LOOP-WORKER] unlock (operator) for ${filePath}: ${result.unlocked ? "ok" : result.reason}`);
            return json({ ok: result.unlocked, ...result });
          }
          if (!pinStr) {
            console.warn(`[LOOP-WORKER] unlock refused for ${filePath}: no PIN and master mode not active`);
            return json(
              {
                ok: false,
                error: 'pin is required — the operator PIN is documented mid-README ("Why it can\'t go rogue")',
              },
              400
            );
          }
          console.warn(`[LOOP-WORKER] unlock refused for ${filePath}: wrong PIN`);
          return json(
            {
              ok: false,
              error: 'wrong operator PIN — see the README\'s safety section ("Why it can\'t go rogue")',
            },
            403
          );
        }

        // Mirror of POST /api/self-enhance/skip
        if (url === "/skip") {
          const result = await loop.skipNext();
          return json(result);
        }

        return json({ error: "not found" }, 404);
      } catch (err) {
        const error = err instanceof Error ? err.message : "Unknown error";
        console.error("[LOOP-WORKER] Request failed:", err instanceof Error ? err.stack : err);
        return json({ error }, 500);
      }
    },
  });

  console.log(`[LOOP-WORKER] listening on 0.0.0.0:${PORT} (pid ${process.pid})`);
  console.log("[LOOP-WORKER] self-enhance loop loaded; armed tier governs auto-start");

  // ── BASELINE HEALTH MONITOR (operator freeze companion) ──────────────
  // The loop's own cycle hook (captureAndPersistHealthSnapshot every N
  // cycles) stops firing when the loop is stopped or frozen — but the
  // dashboard's health trend is the operator's window into codebase
  // integrity (tests / tsc / lint), which matters MOST in a frozen
  // system: if anything ever breaks the locked state (a stray edit, a
  // disk fault, a bad actor), the trend must show it. This timer keeps
  // the snapshot stream alive regardless of loop state.
  //
  // ASYNC MODE (mandatory here): the checks run via the non-blocking
  // runner (mode:"async") — a ~20s snapshot window must never block
  // this process's HTTP loop. The first rollout used the sync capture:
  // /health went unresponsive for the snapshot's duration, the server's
  // respawn logic misread it as a dead worker, and respawn attempts
  // piled up on the port conflict (harmless but noisy, and a genuinely
  // dead worker would have been masked by the noise).
  //
  // Cost: ~3-20s of child processes every 15 minutes; first snapshot 90s
  // after boot so a fresh worker reports promptly without racing the
  // boot hydration.
  const HEALTH_MONITOR_INTERVAL_MS = 15 * 60 * 1000;
  const runHealthSnapshot = async (why: string) => {
    try {
      const cycleNumber = loop.getStats().cyclesCompleted;
      const snapshot = await healthMetrics.captureAndPersistHealthSnapshot(
        cycleNumber,
        { mode: "async" }
      );
      if (!snapshot.ok) {
        console.warn(
          `[LOOP-WORKER] health snapshot (${why}) captured with errors:`,
          snapshot.error ?? "unknown"
        );
      }
    } catch (err) {
      // Best-effort by contract — a failed snapshot never kills the worker.
      console.error(
        "[LOOP-WORKER] health snapshot failed (monitor continues):",
        err instanceof Error ? err.message : String(err)
      );
    }
  };
  setTimeout(() => {
    void runHealthSnapshot("boot");
  }, 90_000).unref?.();
  const healthTimer = setInterval(() => {
    void runHealthSnapshot("interval");
  }, HEALTH_MONITOR_INTERVAL_MS);
  healthTimer.unref?.();
  console.log(
    `[LOOP-WORKER] baseline health monitor armed — async snapshot every ${HEALTH_MONITOR_INTERVAL_MS / 60000}min (tests/tsc/lint), independent of loop state`
  );
}

// A telemetry/worker process must stay alive: log and continue, never let
// one bad request or a stray rejection kill the loop mid-gate-chain.
process.on("uncaughtException", (err) => {
  console.error("[LOOP-WORKER] UNCAUGHT EXCEPTION (worker stays up):", err instanceof Error ? err.stack : err);
});
process.on("unhandledRejection", (err) => {
  console.error("[LOOP-WORKER] UNHANDLED REJECTION (worker stays up):", err instanceof Error ? err.stack : err);
});

main().catch((err) => {
  console.error("[LOOP-WORKER] fatal boot error:", err instanceof Error ? err.stack : err);
  process.exit(1);
});