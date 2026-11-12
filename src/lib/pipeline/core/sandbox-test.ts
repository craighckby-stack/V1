/**
 * Sandbox test runner — the full closure of external-audit finding 1.
 *
 * The audit's PRIMARY defect: the test gate wrote the candidate mutation to
 * the LIVE file so `bun test` could import it. During the test window:
 *   - Turbopack could hot-reload the unverified candidate into the app.
 *   - A process crash could strand it on disk (the write-ahead journal in
 *     test-gate-journal.ts fixed the stranding, but the exposure window
 *     itself remained — a journal restores AFTER the damage window opened).
 *
 * This module eliminates the live-write entirely. The candidate NEVER
 * touches the real tree. Instead:
 *
 *   1. A throwaway copy of the project skeleton is built at
 *      <root>/.loop-sandbox/verify-XXXX/: src/ tree, tsconfig.json,
 *      package.json, prisma/ (the detectProjectRoot markers), a symlink to
 *      the real node_modules/ (dependency resolution without a 300MB copy),
 *      and — when the SQLite DB is small — a COPY of the DB with .env
 *      rewritten so tests that touch Prisma write to the sandbox DB, not
 *      the live one.
 *   2. The overlay files (the candidate mutation, or a newly drafted test)
 *      are written INTO the sandbox at their project-relative paths.
 *   3. `bun test` runs with cwd = the sandbox. Relative imports, the `@/`
 *      alias (tsconfig paths), and node_modules all resolve inside the
 *      sandbox; anything reading PROJECT_ROOT (core/paths.ts) resolves to
 *      the sandbox because the markers are there — modules under test
 *      operate on the candidate tree, never on the live one.
 *   4. The sandbox is deleted on every exit path, and only ever removed if
 *      it really lives under .loop-sandbox/ (paranoia guard on rmSync).
 *
 * Consequences, vs the audit's three bullets:
 *   - Turbopack can NOT observe the candidate (it never leaves the sandbox,
 *     which sits outside src/ and is gitignored).
 *   - The app can NOT hot-reload it (same reason).
 *   - A crash can NOT strand it (the sandbox is disposable; nothing in the
 *     live tree was ever modified). The crash journal stays armed as
 *     defense-in-depth for legacy states and any future code path that
 *     reintroduces live writes — see test-gate-journal.ts.
 *
 * Fail-closed: if the sandbox cannot be built or the runner errors, the
 * result is passed:false. A mutation we could not test is a rejected
 * mutation — never a silently-passed one (audit finding 2's principle).
 *
 * Pure leaf module: fs/path/child_process only. Lives under core/ — a
 * PROTECTED_PREFIX (audit 3) — so the loop can never weaken its own
 * isolation. No DB, no LLM, no pipeline imports (paths.ts is the sole
 * exception: it is itself a protected pure leaf).
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join, relative, isAbsolute } from "path";
import { spawn } from "child_process";
import { PROJECT_ROOT } from "./paths";

export interface SandboxOverlay {
  /** Absolute REAL path of the file being overridden in the sandbox. */
  path: string;
  /** The content to place at the sandbox location instead. */
  content: string;
}

export interface SandboxTestResult {
  passed: boolean;
  reason: string;
  testCount: number;
}

/** Where sandboxes live. Outside src/ (Turbopack never watches it),
 * gitignored (git add -A can never sweep it), wiped per run. */
const SANDBOX_PARENT = join(PROJECT_ROOT, ".loop-sandbox");

/** DBs larger than this are not copied — the sandbox falls back to the
 * real DATABASE_URL (behavioral parity with the pre-sandbox test runs)
 * rather than burning disk/time per verification. 32MB is ~100x the
 * current db/custom.db. */
const MAX_DB_COPY_BYTES = 32 * 1024 * 1024;

/** Build the sandbox skeleton. Returns the sandbox root, or null when a
 * mandatory piece is missing (caller fails closed on null). */
function buildSandbox(): { root: string; dbOverride?: string } | null {
  mkdirSync(SANDBOX_PARENT, { recursive: true });
  const root = mkdtempSync(join(SANDBOX_PARENT, "verify-"));

  try {
    // Project skeleton: the src tree + the files that make the sandbox a
    // self-consistent "project root" for bun (tsconfig paths), tsc
    // (tsconfig include), and core/paths.ts (package.json + prisma markers).
    cpSync(join(PROJECT_ROOT, "src"), join(root, "src"), { recursive: true });
    cpSync(join(PROJECT_ROOT, "tsconfig.json"), join(root, "tsconfig.json"));
    cpSync(join(PROJECT_ROOT, "package.json"), join(root, "package.json"));
    cpSync(join(PROJECT_ROOT, "prisma"), join(root, "prisma"), { recursive: true });

    // Dependencies resolve through a symlink — no node_modules copy.
    symlinkSync(join(PROJECT_ROOT, "node_modules"), join(root, "node_modules"), "dir");

    // DB isolation: rewrite DATABASE_URL to a sandbox copy when possible so
    // tests that write through Prisma mutate the disposable DB, not the
    // live one. Audit 3 (F11): the old fallback when the copy was skipped
    // (DB >32MB — it is already 178MB — unreadable, or .env unparseable)
    // was to INHERIT the real URL, so LLM-drafted tests executed against
    // PRODUCTION data. Now the fallback is a blank sandbox DB file: a
    // DB-dependent test FAILS (missing tables) and the gate rejects the
    // candidate — fail-closed isolation instead of silent live-DB access.
    let dbOverride: string | undefined;
    let dbIsolated = false;
    try {
      const envSrc = readFileSync(join(PROJECT_ROOT, ".env"), "utf-8");
      const m = envSrc.match(/^DATABASE_URL=file:(.+)$/m);
      if (m) {
        const raw = m[1].trim();
        const dbPath = isAbsolute(raw) ? raw : join(PROJECT_ROOT, raw);
        if (existsSync(dbPath)) {
          const size = statSync(dbPath).size;
          if (size <= MAX_DB_COPY_BYTES) {
            const rel = relative(PROJECT_ROOT, dbPath);
            // Only copy DBs that live inside the project (a DB elsewhere on
            // disk belongs to the environment, not to this repo).
            if (rel && !rel.startsWith("..")) {
              const sandboxDb = join(root, rel);
              mkdirSync(join(sandboxDb, ".."), { recursive: true });
              cpSync(dbPath, sandboxDb);
              // WAL mode keeps recent commits in -wal/-shm sidecars — copy
              // them too when present, or the sandbox DB is a stale snapshot.
              for (const suffix of ["-wal", "-shm"]) {
                const sidecar = `${dbPath}${suffix}`;
                if (existsSync(sidecar)) {
                  try {
                    cpSync(sidecar, `${sandboxDb}${suffix}`);
                  } catch {
                    /* sidecar vanished mid-copy (checkpoint race) — the main
                       file copy still stands; worst case is a stale snapshot */
                  }
                }
              }
              dbOverride = `file:${sandboxDb}`;
              // Also write a sandbox .env: anything that reads the file
              // directly (rather than process.env) gets the same override.
              const envSandbox = envSrc.replace(
                /^DATABASE_URL=file:.+$/m,
                `DATABASE_URL=${dbOverride}`
              );
              writeFileSync(join(root, ".env"), envSandbox, "utf-8");
              dbIsolated = true;
            }
          }
        }
      }
    } catch {
      // No .env / unreadable / copy failed — fall through to the blank-DB
      // isolation below (audit 3: never inherit the live URL).
    }
    if (!dbIsolated) {
      // Audit 3 (F11): FAIL-CLOSED isolation — point the sandbox at a BLANK
      // DB file inside the sandbox. Prisma opens it (creating an empty
      // SQLite file), and any query fails with "table does not exist" →
      // the test fails → the candidate is rejected. DB-independent tests
      // still pass, so this only rejects mutations whose tests genuinely
      // need production data (which must never be touched).
      const blankDb = join(root, "db", "sandbox-blank.db");
      try {
        mkdirSync(join(root, "db"), { recursive: true });
        writeFileSync(blankDb, "", { flag: "w" });
        dbOverride = `file:${blankDb}`;
        try {
          const envSrc2 = readFileSync(join(PROJECT_ROOT, ".env"), "utf-8");
          writeFileSync(
            join(root, ".env"),
            envSrc2.replace(/^DATABASE_URL=file:.+$/m, `DATABASE_URL=${dbOverride}`),
            "utf-8"
          );
        } catch {
          writeFileSync(join(root, ".env"), `DATABASE_URL=${dbOverride}\n`, "utf-8");
        }
        console.warn(
          `[SANDBOX] live DB too large/unreadable for copy — using BLANK isolated DB (${blankDb}). ` +
            `DB-dependent tests will fail by design (fail-closed isolation, audit 3 F11).`
        );
      } catch {
        // Could not even create the blank file — run with NO override but
        // an explicitly nulled DATABASE_URL so Prisma fails fast rather
        // than silently connecting to production.
        dbOverride = "file:/nonexistent-sandbox-db-fail-closed.db";
      }
    }

    return { root, dbOverride };
  } catch (err) {
    // Setup failure must not leak a half-built sandbox.
    safeRemoveSandbox(root);
    return null;
  }
}

/** Delete a sandbox — but ONLY if it is really under SANDBOX_PARENT.
 * A path-handling bug must never turn this into `rm -rf` on the project. */
function safeRemoveSandbox(root: string): void {
  const rel = relative(SANDBOX_PARENT, root);
  if (rel.startsWith("..") || isAbsolute(rel)) return; // not ours — refuse
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort: a stale sandbox dir is garbage-collected by nothing,
       but it is gitignored and outside src/ — it cannot affect the app. */
  }
}

/** Child env: inherit everything, override DATABASE_URL when the sandbox
 * has an isolated DB copy. process.env inside the dev server already
 * carries the REAL url (Next.js loads .env at boot), so the explicit
 * override is what actually redirects Prisma to the sandbox DB. */
function childEnv(dbOverride?: string): NodeJS.ProcessEnv {
  if (!dbOverride) return process.env;
  return { ...process.env, DATABASE_URL: dbOverride };
}

/** Map a real absolute path to its location inside the sandbox. Throws if
 * the path escapes the project root — overlays/tests must be project files. */
function sandboxPath(sandboxRoot: string, realPath: string): string {
  const rel = relative(PROJECT_ROOT, realPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing to map out-of-project path: ${realPath}`);
  }
  return join(sandboxRoot, rel);
}

/** Async child runner — the non-blocking replacement for this module's
 *  spawnSync calls. spawnSync blocked the shared server event loop for the
 *  child's full runtime (up to 120s for a sandbox `tsc --noEmit`); `spawn` +
 *  Promise yields the loop back to HTTP handlers while the child works.
 *  Same { status, stdout, stderr } contract as spawnSync — fail-closed
 *  (status null on kill/error/timeout) so callers' `status !== 0` checks
 *  behave identically.
 *
 *  Inlined here (not imported from core/async-spawn) to preserve this
 *  module's pure-leaf import invariant: fs/path/child_process + paths.ts
 *  only. The loop self-checks this invariant and protects this file —
 *  widening the import surface would weaken the sandbox's isolation. */
function runChild(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ status: null, stdout: "", stderr: `[spawn error] ${(err as Error).message}`, timedOut: false });
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
        try { child.kill("SIGKILL"); } catch { /* dying */ }
        finish(null, true);
      }, opts.timeoutMs);
    }
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
    child.on("error", (err) => { stderr += `\n[spawn error] ${err.message}`; finish(null); });
    child.on("close", (code) => finish(code));
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/**
 * Run test files against overlaid candidate content, fully isolated from
 * the live tree. Nothing on the real filesystem is modified — not the
 * candidate file, not the test files, not the DB (when isolation applies).
 *
 * @param overlays files whose sandbox copies differ from disk (the
 *                 candidate mutation, and/or newly drafted test files)
 * @param testFiles absolute REAL paths of test files to execute; each is
 *                  run as `bun test <relpath>` with cwd = sandbox root
 * @param perTestTimeoutMs per-test-file spawn timeout (default 30s)
 */
export async function runTestsInSandbox(
  overlays: SandboxOverlay[],
  testFiles: string[],
  perTestTimeoutMs = 30_000
): Promise<SandboxTestResult> {
  if (testFiles.length === 0) {
    return { passed: true, reason: "no test files to run", testCount: 0 };
  }
  const sandbox = buildSandbox();
  if (!sandbox) {
    return {
      passed: false,
      reason: "sandbox setup failed — cannot verify without isolation (fail-closed)",
      testCount: 0,
    };
  }
  try {
    // Overlay the candidates. A write failure here means the overlay path
    // escaped the project (sandboxPath guard) or the disk is full — either
    // way, fail closed rather than test the wrong code.
    try {
      for (const o of overlays) {
        const target = sandboxPath(sandbox.root, o.path);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, o.content, "utf-8");
      }
    } catch (err) {
      return {
        passed: false,
        reason: `sandbox overlay failed: ${(err as Error).message}`,
        testCount: 0,
      };
    }

    let totalTests = 0;
    for (const testFile of testFiles) {
      const relInSandbox = relative(PROJECT_ROOT, testFile);
      const result = await runChild("bun", ["test", relInSandbox], {
        cwd: sandbox.root,
        timeoutMs: perTestTimeoutMs,
        env: childEnv(sandbox.dbOverride),
      });
      totalTests++;
      if (result.status !== 0) {
        const stderr = ((result.stderr || "") + (result.stdout || "")).slice(0, 300);
        return {
          passed: false,
          reason: `test failed (sandboxed): ${relInSandbox} — ${stderr.slice(0, 200)}`,
          testCount: totalTests,
        };
      }
    }
    return {
      passed: true,
      reason: `${testFiles.length} test file(s) passed (sandboxed)`,
      testCount: totalTests,
    };
  } catch (err) {
    return {
      passed: false,
      reason: `sandbox test runner error: ${(err as Error).message}`,
      testCount: 0,
    };
  } finally {
    safeRemoveSandbox(sandbox.root);
  }
}

/**
 * Typecheck overlaid content in the sandbox (tsc --noEmit with cwd =
 * sandbox root). Used by the ratchet: a drafted test file must typecheck
 * BEFORE it is ever written to the live tree. Full-project check, same
 * semantics as the old root-level run — pre-existing errors elsewhere are
 * visible but only errors naming the caller's file matter (caller filters).
 *
 * Returns the raw combined output + exit status; never throws.
 */
export async function typecheckInSandbox(
  overlays: SandboxOverlay[],
  timeoutMs = 120_000
): Promise<{ status: number | null; output: string }> {
  const sandbox = buildSandbox();
  if (!sandbox) {
    return { status: null, output: "sandbox setup failed — typecheck not run (fail-closed)" };
  }
  try {
    try {
      for (const o of overlays) {
        const target = sandboxPath(sandbox.root, o.path);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, o.content, "utf-8");
      }
    } catch (err) {
      return { status: null, output: `sandbox overlay failed: ${(err as Error).message}` };
    }
    const tsc = await runChild("bunx", ["tsc", "--noEmit"], {
      cwd: sandbox.root,
      timeoutMs: timeoutMs,
      env: childEnv(sandbox.dbOverride),
    });
    return {
      status: tsc.status,
      output: `${tsc.stdout}${tsc.stderr}`,
    };
  } catch (err) {
    return { status: null, output: `sandbox typecheck error: ${(err as Error).message}` };
  } finally {
    safeRemoveSandbox(sandbox.root);
  }
}
