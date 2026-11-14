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
} catch {
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

async function main() {
  // Dynamic imports: the entire pipeline graph (Prisma client, z-ai SDK,
  // TypeScript compiler) loads only after the env above is in place.
  const { liveSelfEnhanceLoop } = await import(
    "../../src/lib/pipeline/autonomous/self-enhance-loop"
  );
  const agentLlm = await import("../../src/lib/pipeline/llm/agent-llm");

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
          return json({
            running: loop.isRunning(),
            stats: loop.getStats(),
            logs: loop.getLogs(),
            currentFile: loop.getCurrentFile(),
            // The AUTHORITATIVE LLM gate for loop work lives in this
            // process now — the UI's 429 countdown reads it from here.
            llmGate: agentLlm.llmGateInfo(),
            saturation: loop.getSaturation(),
          });
        }

        if (req.method !== "POST") {
          return json({ error: "method not allowed" }, 405);
        }

        // Mirror of POST /api/self-enhance/start (armed write stays on the
        // server; this only drives the runtime).
        if (url === "/start") {
          if (loop.isContinuous()) {
            return json({
              started: true,
              alreadyRunning: true,
              message: "Continuous self-enhancement already running",
            });
          }
          loop.runContinuous().catch((err) => {
            console.error("[LOOP-WORKER] continuous loop crashed:", err);
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
          const wasRunning = loop.isContinuous();
          if (wasRunning) loop.stop();
          loop.runContinuous().catch((err) => {
            console.error("[LOOP-WORKER] reboot restart crashed:", err);
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
          const result = await loop.runCycle();
          return json(result);
        }

        // Mirror of POST /api/self-enhance/rescan
        if (url === "/rescan") {
          const scan = await loop.rescan();
          return json({ ok: true, ...scan });
        }

        // Mirror of POST /api/self-enhance/unlock  body: { filePath }
        if (url === "/unlock") {
          let body: { filePath?: string };
          try {
            body = (await req.json()) as { filePath?: string };
          } catch (e) {
            return json({ ok: false, error: "Invalid JSON body provided: Could not parse request body" }, 400);
          }

          if (!body || typeof body !== 'object' || !body.filePath || typeof body.filePath !== 'string' || body.filePath.trim() === '') {
            return json({ ok: false, error: "filePath must be a non-empty string in the request body" }, 400);
          }
          
          const result = loop.unlockFile(body.filePath);
          return json({ ok: result.unlocked, ...result });
        }

        // Mirror of POST /api/self-enhance/skip
        if (url === "/skip") {
          const result = await loop.skipNext();
          return json(result);
        }

        return json({ error: "not found" }, 404);
      } catch (err) {
        // Catch errors from loop operations or unexpected runtime issues
        const errorMessage = (err as Error).message || "An unknown internal error occurred during request processing";
        console.error("[LOOP-WORKER] Request handling error:", err);
        return json({ error: errorMessage }, 500);
      }
    },
  });

  console.log(`[LOOP-WORKER] listening on 0.0.0.0:${PORT} (pid ${process.pid})`);
  console.log("[LOOP-WORKER] self-enhance loop loaded; armed tier governs auto-start");
}

// A telemetry/worker process must stay alive: log and continue, never let
// one bad request or a stray rejection kill the loop mid-gate-chain.
process.on("uncaughtException", (err) => {
  console.error("[LOOP-WORKER] UNCAUGHT EXCEPTION (worker stays up):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[LOOP-WORKER] UNHANDLED REJECTION (worker stays up):", err);
});

main().catch((err) => {
  console.error("[LOOP-WORKER] fatal boot error:", err);
  process.exit(1);
});