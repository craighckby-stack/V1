/**
 * fleet-harvester - detached fleet-history harvester service.
 *
 * STEP 2: adapted githubClient.ts (btoa->Buffer) + new aiOrchestrator.ts
 * using z-ai-web-dev-sdk (Gemini removed). This entry boots the health
 * endpoint on port 3010 and a /api/llm-test smoke route that pings the
 * Z.AI cortex the harvester will use for ambiguous-commit classification.
 *
 * The real HTTP surface (/api/harvest, /api/status), the scheduler, and
 * the headless harvest runner are added in step 4.
 */

import { createServer } from "node:http";

const PORT = 3010;

// /api/llm-test fires a REAL LLM call (cortex ping) — through the
// gateway's XTransformPort pattern this port is externally reachable,
// so an unthrottled smoke route is a cost-abuse vector (unauthenticated
// LLM invocation on demand). One call per 60s, in-process; the route is
// a smoke test, never a load path. (operator, 2026-11-23)
let lastLlmTestAt = 0;
const LLM_TEST_COOLDOWN_MS = 60_000;

const server = createServer(async (req, res) => {
  // Safely determine URL, defaulting to root if req.url is missing
  const urlString = req.url || "/";
  let url: URL;
  try {
    url = new URL(urlString, `http://localhost:${PORT}`);
  } catch (e) {
    // Handle malformed URL path gracefully
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("Bad Request: Invalid URL path");
    return;
  }

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        phase: "step-2-llm-adapted",
        service: "fleet-harvester",
        port: PORT,
        llmProvider: "z-ai-web-dev-sdk",
        geminiRemoved: true,
        ts: Date.now(),
      }),
    );
    return;
  }
  if (url.pathname === "/api/llm-test") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
      return;
    }
    const now = Date.now();
    const timeSinceLastTest = now - lastLlmTestAt;

    if (timeSinceLastTest < LLM_TEST_COOLDOWN_MS) {
      const retryIn = Math.ceil((LLM_TEST_COOLDOWN_MS - timeSinceLastTest) / 1000);
      res.writeHead(429, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: `llm-test cooldown — retry in ${retryIn}s (one smoke call per 60s)`,
        }),
      );
      return;
    }

    try {
      // Dynamic import is necessary here but we ensure the await structure is correct.
      const { testLlmConnection } = await import("./src/lib/aiOrchestrator");
      const result = await testLlmConnection();
      
      // Only update timestamp upon successful execution
      lastLlmTestAt = Date.now(); 
      
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      let msg: string;
      if (err instanceof Error) {
        msg = `LLM connection failed: ${err.message}`;
      } else {
        msg = `LLM connection failed due to unknown error: ${String(err)}`;
      }
      // Provide actionable error context to the client.
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`[fleet-harvester] step-2 listening on :${PORT} (LLM: z-ai-web-dev-sdk)`);
});

// Enhanced process exit handling to ensure server is properly closed
const gracefulShutdown = (signal: string) => {
  console.log(`[fleet-harvester] received ${signal}, shutting down gracefully...`);
  server.close(() => {
    console.log("[fleet-harvester] server closed");
    process.exit(0);
  });
  
  // Force exit after 10 seconds if server doesn't close cleanly
  setTimeout(() => {
    console.log("[fleet-harvester] force exiting after timeout");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle uncaught exceptions and unhandled promise rejections
process.on("uncaughtException", (err) => {
  console.error("[fleet-harvester] uncaught exception:", err);
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[fleet-harvester] unhandled rejection at:", promise, "reason:", reason);
  gracefulShutdown("unhandledRejection");
});