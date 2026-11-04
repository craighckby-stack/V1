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
