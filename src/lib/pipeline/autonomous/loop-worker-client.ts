/**
 * Loop worker client — the server's ONLY access path to the
 * self-enhancement loop after the worker split.
 *
 * The loop runs in mini-services/loop-worker (port 3004). These routes
 * must NEVER import self-enhance-loop directly again: importing the
 * module constructs the singleton HERE, and its boot auto-start would
 * honor the armed tier — two loops mutating the repo concurrently. This
 * client is a pure HTTP consumer with no pipeline imports.
 *
 * ensureWorkerRunning() is the self-healing primitive: health-probe the
 * worker; if it's down, respawn it detached (same pattern as the WS
 * sidecar spawn in instrumentation.ts) and wait for health. A module-
 * level respawn guard (one attempt per 10s) makes it safe to call from
 * instrumentation boot AND from every control route without racing
 * doubles — all callers live in this same server process.
 */
import * as path from 'path';

const WORKER_URL = process.env.LOOP_WORKER_URL ?? "http://localhost:3004";

let lastSpawnAt = 0;
let isSpawning = false;

export interface WorkerResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
}

/** Fetch a worker endpoint. Resolves null on ANY transport failure
 *  (unreachable, timeout, non-JSON) — callers decide the fallback. */
export async function workerFetch<T = unknown>(
  pathname: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<WorkerResult<T> | null> {
  if (typeof pathname !== "string" || pathname.trim() === "") {
    console.error("workerFetch called with invalid pathname: must be a non-empty string.");
    return null;
  }

  // Input validation: Ensure init is an object if provided, not null
  if (init !== undefined && (init === null || typeof init !== 'object')) {
    console.error("workerFetch called with invalid init object: must be an object or undefined.");
    return null;
  }
  
  // Merge defaults with provided init, ensuring provided values take precedence
  const defaultInit: RequestInit & { timeoutMs?: number } = {
    method: "GET",
    timeoutMs: 5000,
  };
  
  // Merge defaults with provided init. Spread init last to override defaults.
  const effectiveInit: RequestInit & { timeoutMs?: number } = {
    ...defaultInit,
    ...(init as RequestInit & { timeoutMs?: number }),
  };
  
  const timeoutMs = effectiveInit.timeoutMs ?? 5000;
  
  try {
    const res = await fetch(`${WORKER_URL}${pathname}`, {
      method: effectiveInit.method,
      headers: effectiveInit.headers,
      body: effectiveInit.body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    let data: T | null = null;

    // Only attempt JSON parsing if the response status indicates success (2xx)
    if (res.ok) {
      try {
        data = (await res.json()) as T;
      } catch (e) {
        // Non-JSON body on success status (shouldn't happen if worker is correct)
        console.error(`Failed to parse JSON response from ${WORKER_URL}${pathname} (Status: ${res.status}):`, e);
      }
    }
    // If res.ok is false, data remains null, and the caller uses res.status/res.ok.

    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    // Catch specific network/timeout errors, but still return null as per contract
    if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        // Cripple-check F9: a chronically slow worker (always timing out)
        // used to produce ZERO log output anywhere — every route caller
        // silently mapped null to its fallback. Warn once per call site
        // pattern so the degradation is visible in the server log.
        console.warn(`workerFetch timeout/abort: ${WORKER_URL}${pathname} (${timeoutMs}ms)`);
    } else {
        console.error(`Error fetching ${WORKER_URL}${pathname}:`, error);
    }
    return null;
  }
}

/** Health-check the worker; respawn it if down. Returns whether the
 *  worker is reachable when this resolves. Never throws. */
export async function ensureWorkerRunning(): Promise<boolean> {
  // Check for empty or undefined URL configuration
  if (!WORKER_URL || WORKER_URL.trim() === "") {
    console.error("WORKER_URL is not configured or is empty. Cannot ensure worker is running.");
    return false;
  }

  // Fast path: healthy (single ~ms localhost probe).
  try {
    const probe = await fetch(`${WORKER_URL}/health`, {
      signal: AbortSignal.timeout(500), // Reduced timeout for faster failure detection
    });
    if (probe.ok) return true;
  } catch {
    /* down — respawn below */
  }

  // Respawn guard: at most one spawn attempt per 10s per server process.
  if (Date.now() - lastSpawnAt < 10_000 || isSpawning) return false;
  
  lastSpawnAt = Date.now();
  isSpawning = true;

  let healthCheckSuccessful = false;
  let outFd: number | "ignore" = "ignore";

  try {
    // Attempt to open log file first to isolate FS errors
    try {
      const fs = await import("fs");
      outFd = fs.openSync(
        path.join("mini-services", "loop-worker", "worker.log"),
        "a"
      );
    } catch (error) {
      console.error("Failed to open worker log file:", error);
      // outFd remains "ignore" if this fails, which is safe.
    }

    // Use imported modules directly since we imported them at the top level
    const { spawn } = await import("child_process");
    
    const workerIndexPath = path.join("mini-services", "loop-worker", "index.ts");

    const child = spawn(
      "bun",
      [workerIndexPath],
      {
        cwd: process.cwd(), // project root — worker resolves .env + tsconfig paths
        stdio: ["ignore", outFd, outFd],
        detached: true,
      }
    );
    child.unref();
  } catch (error) {
    console.error("Failed to spawn loop worker:", error);
    // If spawning fails, isSpawning will be reset in finally block.
    return false;
  } finally {
    // Only reset isSpawning after spawn attempt completes
    // Note: file descriptor leak remains if spawn succeeded but health check failed
    isSpawning = false;
  }

  // Wait up to ~5s for boot (pipeline import graph: Prisma + TS compiler
  // + SDK — a cold boot takes a moment; the constructor then honors the
  // armed tier on its own).
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const probe = await fetch(`${WORKER_URL}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (probe.ok) {
        healthCheckSuccessful = true;
        break;
      }
    } catch {
      /* still booting */
    }
  }
  
  // Return health status
  return healthCheckSuccessful;
}

/** Fire-and-forget self-heal for read paths (status polls): never blocks
 *  the response on a respawn; the next poll finds the worker up. */
export function healWorkerInBackground(): void {
  void ensureWorkerRunning().catch(() => {});
}