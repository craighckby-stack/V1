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

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
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
    try {
      const { testLlmConnection } = await import("./src/lib/aiOrchestrator");
      const result = await testLlmConnection();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      let msg: string;
      if (err instanceof Error) {
        msg = err.message;
      } else {
        msg = String(err);
      }
      // Provide full error context without arbitrary slicing, as the client should handle length.
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

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));