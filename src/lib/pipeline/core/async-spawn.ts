/**
 * Async child-process runner — the non-blocking replacement for the verify
 * path's spawnSync gates.
 *
 * WHY THIS EXISTS:
 *   spawnSync blocks the Node.js event loop for the child's full runtime
 *   (up to 120s for a schema `db:push`, 60s for a verify-refactor typecheck).
 *   The self-enhance loop runs as a `globalThis.__selfEnhanceLoop` singleton
 *   INSIDE the Next.js server process, so it shares the event loop with the
 *   HTTP handlers. While a spawnSync verify gate was in flight, every API
 *   poll (/api/autonomous/status, /api/self-enhance/status, /api/hot-swap/status)
 *   stalled for the gate's full duration — the dashboard froze mid-cycle.
 *
 *   `spawn` + Promise fixes this WITHOUT changing what the child does: the
 *   child runs the exact same command with the exact same args, stdin, cwd,
 *   env, and timeout — the parent simply awaits its exit asynchronously
 *   instead of busy-waiting on the event loop. The return contract (status,
 *   stdout, stderr) is identical to spawnSync's, so every caller's fail-closed
 *   logic is preserved bit-for-bit.
 *
 * Pure leaf: depends on `child_process` only — no DB, no LLM, no pipeline
 * imports. Safe to use from any module (including schema-gate, which mutates
 * the system's own memory substrate and must not gain hidden coupling).
 */

import { spawn } from "child_process";

export interface RunChildOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Bytes written to the child's stdin before it is closed. Mirrors
   *  spawnSync's `input` option. */
  input?: string;
  /** Kills the child with SIGKILL after this many ms and resolves with
   *  status:null + timedOut:true — the same outcome spawnSync's `timeout`
   *  produces (status null on kill). 0 / undefined = no timeout. */
  timeoutMs?: number;
}

export interface RunChildResult {
  /** Exit code, or null when the child was killed (timeout / error / signal). */
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a child process asynchronously. Never rejects — spawn errors and
 *  timeouts are mapped to { status: null, ... } so callers' `status !== 0`
 *  fail-closed checks behave identically to the old spawnSync paths. */
export function runChildAsync(
  cmd: string,
  args: string[],
  opts: RunChildOptions = {}
): Promise<RunChildResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // spawn itself threw (e.g. bad executable) — fail-closed.
      resolve({
        status: null,
        stdout: "",
        stderr: `[spawn error] ${(err as Error).message}`,
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (status: number | null, timedOut = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.stdin?.end(); } catch { /* already closed */ }
      resolve({ status, stdout, stderr, timedOut });
    };

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dying */ }
        finish(null, true);
      }, opts.timeoutMs);
    }

    // Suppress unhandled stream errors — a child that exits before reading
    // all of stdin would otherwise emit EPIPE on the writable side and crash
    // the parent process via the global unhandledRejection handler.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
    child.on("error", (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));

    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}
