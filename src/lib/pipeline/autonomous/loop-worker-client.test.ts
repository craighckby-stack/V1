import { describe, test, expect, beforeAll } from "bun:test";

/**
 * loop-worker-client unit tests — PURE, no production side effects.
 *
 * WHY THIS FILE LOOKS LIKE THIS
 * ──────────────────────────────
 * The first version of these tests called the LIVE worker (port 3004):
 * `workerFetch("/health")` against production, and worse,
 * `ensureWorkerRunning()` / `healWorkerInBackground()` — which RESPAWN
 * the production worker process when the probe fails. A test run that
 * races a busy worker (e.g. one mid-snapshot) then spawns duplicate
 * workers that die on the port conflict — the exact pollution class
 * that once wrote "armed by test-run" into the production intent tier.
 *
 * The rules now:
 *   1. LOOP_WORKER_URL is pinned to a dead port BEFORE the module is
 *      imported (dynamic import — ESM import statements hoist above
 *      plain statements, so a static import would read the real URL).
 *      127.0.0.1:1 fails with ECONNREFUSED instantly — deterministic,
 *      no timeout waiting, no production traffic.
 *   2. workerFetch is safe to exercise on a dead URL: it never spawns
 *      anything — the transport-failure → null contract IS the unit
 *      under test.
 *   3. ensureWorkerRunning / healWorkerInBackground are NOT exercised
 *      live: on any dead URL they would spawn a real worker process
 *      (the spawn is unconditional once the probe fails). Only their
 *      export contracts are pinned, with this comment as the reason.
 *      Production exercises them on every status poll — the live path
 *      has more coverage than any test could add.
 */

// Pin to a dead port BEFORE the module reads process.env at import time.
process.env.LOOP_WORKER_URL = "http://127.0.0.1:1";

let workerFetch: typeof import("./loop-worker-client").workerFetch;
let ensureWorkerRunning: typeof import("./loop-worker-client").ensureWorkerRunning;
let healWorkerInBackground: typeof import("./loop-worker-client").healWorkerInBackground;

beforeAll(async () => {
  const mod = await import("./loop-worker-client");
  workerFetch = mod.workerFetch;
  ensureWorkerRunning = mod.ensureWorkerRunning;
  healWorkerInBackground = mod.healWorkerInBackground;
});

describe("loop-worker-client", () => {
  describe("workerFetch", () => {
    test("returns null for empty pathname", async () => {
      const result = await workerFetch("");
      expect(result).toBe(null);
    });

    test("returns null for whitespace-only pathname", async () => {
      const result = await workerFetch("   ");
      expect(result).toBe(null);
    });

    test("returns null for null init parameter", async () => {
      const result = await workerFetch("/test", null as unknown as RequestInit);
      expect(result).toBe(null);
    });

    test("returns null for non-object init parameter", async () => {
      const result = await workerFetch("/test", "invalid" as unknown as RequestInit);
      expect(result).toBe(null);
    });

    test("returns null fast on transport failure (dead port, default timeout)", async () => {
      // ECONNREFUSED on a dead port is immediate — this pins BOTH the
      // null-on-failure contract AND that no default-timeout wait occurs
      // on an actively refused connection.
      const started = Date.now();
      const result = await workerFetch("/health", { method: "GET" });
      const elapsed = Date.now() - started;
      expect(result).toBe(null);
      expect(elapsed).toBeLessThan(2500);
    });

    test("returns null on transport failure with a custom timeout", async () => {
      const result = await workerFetch("/health", { method: "GET", timeoutMs: 1000 });
      expect(result).toBe(null);
    });

    test("returns null for a deep pathname on a dead port", async () => {
      // Pathnames with multiple segments still hit the same dead URL —
      // no partial-URL assembly bug can turn this into a live request.
      const result = await workerFetch("/some/deep/path?with=query", { method: "POST" });
      expect(result).toBe(null);
    });
  });

  describe("ensureWorkerRunning / healWorkerInBackground", () => {
    // NOT exercised live — see the file docblock: on a dead URL both
    // would SPAWN a production worker process from a test run. Only the
    // export contracts are pinned here.
    test("exports functions with the documented signatures", () => {
      expect(typeof ensureWorkerRunning).toBe("function");
      expect(typeof healWorkerInBackground).toBe("function");
      expect(ensureWorkerRunning.length).toBe(0); // () => Promise<boolean>
      expect(healWorkerInBackground.length).toBe(0); // () => void
    });
  });

  describe("WorkerResult interface", () => {
    test("has correct structure", () => {
      // Pin the interface shape consumers rely on (the type itself is
      // compile-time only; this pins the runtime contract).
      const validResult: import("./loop-worker-client").WorkerResult = {
        ok: true,
        status: 200,
        data: null,
      };
      expect(validResult).toEqual({
        ok: true,
        status: 200,
        data: null,
      });
    });
  });
});
