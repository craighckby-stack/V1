/**
 * Refactor verifier — runs as a child process spawned by the self-enhance loop.
 *
 * Usage: echo "<refactored code>" | bun run src/lib/pipeline/autonomous/verify-refactor.ts <filePath>
 *
 * Reads the file path from argv[2] and the refactored code from stdin.
 * Runs THREE gates in order (cheap → expensive):
 *   1. STRUCTURAL — destructive truncation, import stripping, symbol drop,
 *      test deletion, license stripping. The REAL signal beyond typecheck.
 *      Cheap (regex-based, no compiler). Catches the LLM doing things that
 *      compile but are destructive.
 *   2. SYNTAX — fast AST parse. Catches broken template literals, etc.
 *   3. TYPECHECK — full in-memory TypeScript typecheck (same as `tsc --noEmit`).
 *      Expensive (~10s). Only runs if structure + syntax pass.
 *
 * Prints JSON result to stdout. Exits 0 on success, 1 on any gate failure.
 *
 * Nothing is written to disk — Turbopack never sees the refactored code.
 *
 * The structural gate reads the ORIGINAL file from disk to compare against.
 * This is the key addition: typecheck alone proves "compiles", the
 * structural gate proves "didn't break the public API / didn't drop tests /
 * didn't strip imports / wasn't truncated".
 */

import { typecheckRefactor, syntaxCheck } from "./in-memory-typecheck";
import { validateStructure } from "./structural-validator";
import { readFileSync } from "fs";
import { resolve } from "path";

const PROJECT_ROOT = "/home/z/my-project";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log(JSON.stringify({ ok: false, errors: ["No file path provided"] }));
    process.exit(1);
  }

  // Read refactored code from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const refactoredCode = Buffer.concat(chunks).toString("utf-8");

  if (!refactoredCode || refactoredCode.trim().length === 0) {
    console.log(JSON.stringify({ ok: false, errors: ["No code provided on stdin"] }));
    process.exit(1);
  }

  // Gate 1: STRUCTURAL — compare against the original on disk.
  // Catches destructive refactors that would still compile.
  let originalCode = "";
  try {
    originalCode = readFileSync(resolve(PROJECT_ROOT, filePath), "utf-8");
  } catch {
    // If the original can't be read (new file?), skip structural — typecheck will catch issues
  }
  if (originalCode) {
    const structure = validateStructure(filePath, originalCode, refactoredCode);
    if (!structure.ok) {
      console.log(JSON.stringify({
        ok: false,
        errors: structure.issues.map((i) => `[${i.code}] ${i.message}`),
      }));
      process.exit(1);
    }
  }

  // Gate 2: SYNTAX — fast AST parse.
  const syntax = syntaxCheck(refactoredCode);
  if (!syntax.ok) {
    console.log(JSON.stringify({ ok: false, errors: [syntax.error ?? "Syntax error"] }));
    process.exit(1);
  }

  // Gate 3: TYPECHECK — full in-memory tsc.
  const result = typecheckRefactor(filePath, refactoredCode);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, errors: [err.message] }));
  process.exit(1);
});
