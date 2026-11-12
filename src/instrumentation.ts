/**
 * Next.js instrumentation hook — runs once at server startup.
 *
 * Registers global handlers for unhandled rejections and uncaught exceptions.
 * The self-enhancement loop and autonomous loop already have their own
 * try/catch around every cycle, but a native-module rejection or a deeply-
 * nested async path (LLM SDK, Prisma engine, better-sqlite3) can escape
 * those catches and reach the process level. Without these handlers, Bun
 * terminates the process on the first unhandled rejection — killing the
 * server, the UI, and any in-flight cycle. With them, the error is logged
 * and the process survives; the loop's own error handling reports the
 * cycle failure through its normal postmortem path.
 *
 * This file is outside the loop's scan scopes (src/lib/pipeline, src/app,
 * src/components) so the loop can never mutate its own crash handler.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    process.on("unhandledRejection", (reason) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      // Swallow — the loop's cycle-level try/catch reports real failures
      // through postmortems. This handler only prevents process death.
      console.error(
        `[INSTRUMENTATION] unhandledRejection (swallowed, process survived): ${msg.slice(0, 200)}`
      );
    });
    process.on("uncaughtException", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[INSTRUMENTATION] uncaughtException (swallowed, process survived): ${msg.slice(0, 200)}`
      );
    });

    // ── LOOP WEBSOCKET MINI-SERVICE AUTO-LAUNCH ──────────────────────
    // The dashboard's real-time stream (use-loop-socket.ts → Caddy →
    // port 3003) depends on this sidecar, but nothing ever launched it —
    // the client reconnected forever (reconnectionAttempts: Infinity)
    // and the UI silently ran on HTTP-poll fallback. Spawn it once per
    // process if its health endpoint doesn't already answer. The
    // globalThis guard + health probe make it idempotent across hot
    // reloads and restarts; fire-and-forget so a slow spawn never blocks
    // server start.
    void (async () => {
      const slot = globalThis as unknown as { __loopWsServiceSpawned?: boolean };
      if (slot.__loopWsServiceSpawned) return;
      slot.__loopWsServiceSpawned = true;
      try {
        const res = await fetch("http://localhost:3003/health", {
          signal: AbortSignal.timeout(800),
        });
        if (res.ok) {
          console.log("[INSTRUMENTATION] loop-ws-service already live on :3003");
          return;
        }
      } catch {
        /* not running — spawn it below */
      }
      try {
        const { spawn } = await import("child_process");
        const path = await import("path");
        const cwd = path.join(process.cwd(), "mini-services", "loop-ws-service");
        const child = spawn("bun", ["index.ts"], {
          cwd,
          stdio: "ignore",
          detached: true,
        });
        child.unref();
        console.log("[INSTRUMENTATION] loop-ws-service spawned on :3003 (detached)");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[INSTRUMENTATION] loop-ws-service spawn failed: ${msg.slice(0, 200)}`
        );
      }
    })();

    // ── LOOP WORKER AUTO-HEAL (the loop's real home since the split) ──
    // The self-enhancement loop runs in mini-services/loop-worker (:3004),
    // NOT in this process. ensureWorkerRunning() is idempotent: it
    // health-probes and only respawns when down (same detached-spawn
    // pattern as the WS sidecar above). Fire-and-forget so a cold worker
    // boot (Prisma + TS compiler import graph) never delays server start;
    // control routes share the same self-heal via the respawn guard.
    try {
      const { ensureWorkerRunning } = await import(
        "./lib/pipeline/autonomous/loop-worker-client"
      );
      void ensureWorkerRunning().catch(() => {
        /* the worker self-heals again on the next status poll */
      });
      console.log("[INSTRUMENTATION] loop worker health probe scheduled (:3004)");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[INSTRUMENTATION] loop worker self-heal could not start: ${msg.slice(0, 200)}`
      );
    }

    // ── Z.AI CORTEX AUTO-INJECTION (before the splash screen) ────────
    // Runs at SERVER BOOT — before the first HTTP request, so before the
    // boot splash fetches /api/boot/scan. The injection establishes the
    // z-ai-web-dev-sdk connection (ZAI.create + a one-shot ping) and
    // caches it on the shared globalThis slot — the SAME SDK instance
    // every llmComplete call in the pipeline reuses. The splash then
    // reports the live state on its Z.AI CORTEX POST line. Dynamic
    // import (not top-level) so this only loads in the nodejs runtime;
    // fire-and-forget so a slow provider never blocks server start.
    try {
      const { warmZaiCortex } = await import(
        "./lib/pipeline/llm/agent-llm"
      );
      warmZaiCortex();
      console.log(
        `[INSTRUMENTATION] Z.ai cortex injection started (SDK handshake + ping in flight)`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[INSTRUMENTATION] Z.ai cortex injection could not start: ${msg.slice(0, 200)}`
      );
    }
  }
}
