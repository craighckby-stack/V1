/**
 * Single source of truth for the project root (external audit, finding 6).
 *
 * ~17 pipeline files used to hardcode `/home/z/my-project` — the sandbox
 * path of the original development environment. Running the repo anywhere
 * else (a different sandbox, a local clone, another Colab runtime) silently
 * broke every gate that reads files: the verifier read the WRONG tsconfig,
 * the postmortem store wrote to a nonexistent tree, the scan walked a
 * directory that doesn't exist.
 *
 * Detection: every supported entry point already runs with cwd = the
 * project root — the dev server is started from it, and the verifier child
 * process is spawned with `cwd: PROJECT_ROOT`. So we validate cwd against
 * the two markers every instance of this repo has (package.json + prisma/
 * schema.prisma) and use it when they match.
 *
 * Fallback: the original sandbox path, so behavior in the development
 * sandbox is byte-for-byte identical to before (cwd IS that path there).
 *
 * This file lives under core/ — a PROTECTED_PREFIX (audit 3) — so the
 * self-improvement loop can never redirect its own root resolution.
 *
 * Pure leaf: fs + path only, no imports from the pipeline. Importable from
 * server code, API routes, and the standalone verify-refactor child.
 */

import { existsSync } from "fs";
import { join } from "path";

function detectProjectRoot(): string {
  const cwd = process.cwd();
  if (
    existsSync(join(cwd, "package.json")) &&
    existsSync(join(cwd, "prisma", "schema.prisma"))
  ) {
    return cwd;
  }
  // Not running from the repo root (unexpected invocation, or a future
  // entry point we didn't anticipate) — fall back to the sandbox path so
  // the deployed environment keeps working exactly as before.
  return "/home/z/my-project";
}

export const PROJECT_ROOT: string = detectProjectRoot();
