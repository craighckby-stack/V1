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

const WORKER_URL = process.env.LOOP_WORKER_URL ?? "http://localhost:3004";

let lastSpawnAt = 0;

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
  const timeoutMs = init?.timeoutMs ?? 5000;
  try {
    const res = await fetch(`${WORKER_URL}${pathname}`, {
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => null)) as T | null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return null;
  }
}

/** Health-check the worker; respawn it if down. Returns whether the
 *  worker is reachable when this resolves. Never throws. */
export async function ensureWorkerRunning(): Promise<boolean> {
  // Fast path: healthy (single ~ms localhost probe).
  try {
    const probe = await fetch(`${WORKER_URL}/health`, {
      signal: AbortSignal.timeout(1200),
    });
    if (probe.ok) return true;
  } catch {
    /* down — respawn below */
  }

  // Respawn guard: at most one spawn attempt per 10s per server process.
  // Without this, a burst of polls while the worker boots would spawn a
  // fork bomb; with it, concurrent callers share one attempt.
  if (Date.now() - lastSpawnAt < 10_000) return false;
  lastSpawnAt = Date.now();

  try {
    const { spawn } = await import("child_process");
    const path = await import("path");
    const child = spawn(
      "bun",
      [path.join("mini-services", "loop-worker", "index.ts")],
      {
        cwd: process.cwd(), // project root — worker resolves .env + tsconfig paths
        stdio: "ignore",
        detached: true,
      }
    );
    child.unref();
  } catch {
    return false;
  }

  // Wait up to ~5s for boot (pipeline import graph: Prisma + TS compiler
  // + SDK — a cold boot takes a moment; the constructor then honors the
  // armed tier on its own).
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const probe = await fetch(`${WORKER_URL}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (probe.ok) return true;
    } catch {
      /* still booting */
    }
  }
  return false;
}

/** Fire-and-forget self-heal for read paths (status polls): never blocks
 *  the response on a respawn; the next poll finds the worker up. */
export function healWorkerInBackground(): void {
  void ensureWorkerRunning().catch(() => {});
}
