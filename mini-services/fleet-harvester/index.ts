/**
 * fleet-harvester - detached fleet-history harvester service.
 *
 * STEP 1 SCAFFOLD ONLY.
 * This entry boots a minimal health endpoint on port 3010 so the service is
 * startable (`bun run dev` -> `bun --hot index.ts`) and auto-restarts on
 * file changes. The real HTTP surface (/api/harvest, /api/status), the
 * scheduler, and the headless harvest runner are added in step 4.
 *
 * The verbatim GitHistory-Sync utils live under src/lib/ and the schema
 * contract under src/types/. They have no runtime deps and are exercised
 * by `bun test` (src/lib/core.test.ts). Nothing here reads .env yet.
 */

import { createServer } from "node:http";

const PORT = 3010;

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        phase: "step-1-scaffold",
        service: "fleet-harvester",
        port: PORT,
        ts: Date.now(),
      }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`[fleet-harvester] step-1 scaffold listening on :${PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
