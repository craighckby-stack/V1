/**
 * Self-Enhance Loop — the system enhances its OWN source code.
 *
 * Instead of fetching a remote repo, mutating, and pushing back, this loop:
 *   1. Scans /home/z/my-project/src/lib/pipeline/ for .ts files (its own code)
 *   2. For each file: reads it, LLM-refactors it, verifies with tsc --noEmit
 *   3. If it compiles: writes the refactored code LIVE (hot-reload picks it up)
 *   4. If it doesn't compile: reverts and records a postmortem
 *   5. After each successful enhancement: git add + commit + push (the proof)
 *
 * The GitHub push contains the CURRENT live state of the running system.
 * When you see a commit on GitHub, that's exactly what the server is running.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { join, relative, resolve, basename, dirname } from "path";
import { createHash } from "crypto";
import { llmComplete, extractSummaryAndCode, llmCooldownMs } from "../llm/agent-llm";
import { conductLlmDebate } from "../llm/debate-llm";
import { postmortemStore } from "../postmortem/postmortem-store";
import { queryRelevantPostmortems, formatAncestralPromptBlock } from "../postmortem/ancestral-rag";
import { pushCurrentState, getLastBranchNumber, setLastBranchNumber, formatLoopBranch } from "./push-target";
import { db } from "@/lib/db";
import { generateTasks } from "./self-task-generator";
import { detectTruncation, stripComments, stripLiteralsAndComments } from "./code-analysis";
import { autoProphecyAfterCycle } from "../oracle/oracle-auto";
import {
  TARGET_FILES,
  SCAN_SCOPES,
  SCHEMA_TARGET,
  SATURATION_THRESHOLD,
  getSaturationThreshold,
  type FileSaturation,
  type SaturationMap,
  classifyGrowth,
} from "./saturation";
import { isProtectedPath } from "./protected-files";
import {
  getLessonsForPrompt,
  getPromotedProcedures,
  formatLessonsBlock,
  formatOperatingConstraintsBlock,
  markInjected,
  recordLessonOutcome,
  maybeDistill,
  seedLessons,
  type LessonRow,
} from "./lesson-store";
import { applySchemaMutation } from "./schema-gate";
// ── Compounding-intelligence v2 (D1-D8). The integrity-chain modules
// (lapse-detector, meta-params, meta-tuner, mutation-corpus,
// lessons-markdown, red-team/*) are PROTECTED — see protected-files.ts.
// dreamer + reflection stay advisory/mutable: their outputs pass
// through the existing gates.
import { recordLessonLapse } from "./lapse-detector";
import { maybeReflectAfterFailure } from "./reflection";
import {
  classifyGateOutcome,
  recordMutationAttempt,
  firstMeaningfulLine,
  getRejectedTransformsForFile,
  formatRejectedTransformsBlock,
} from "./mutation-corpus";
import { maybeDream, getRatchetDraft } from "./dreamer";
import { noteAttemptOutcome, maybeMetaTune } from "./meta-tuner";
import { seedMetaParams } from "./meta-params";
import { runTestAttacker, ATTACKER_INTERVAL } from "../red-team/test-attacker";
import { runGateIntegrityProbes, PROBE_INTERVAL } from "../red-team/gate-integrity-probe";

const PIPELINE_SRC_DIR = "/home/z/my-project/src/lib/pipeline";
const DISPLAY_SRC_DIR = "/home/z/my-project/src/app/display";
const PROJECT_ROOT = "/home/z/my-project";

/** D4 (corpus): 16-hex sha of a source string — compact provenance for
 *  "what did the file look like when this was attempted". */
function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/**
 * Find test files that cover the given source file.
 *
 * Looks for `*.test.ts` files that either:
 *   - Sit next to the source file (same name, .test.ts suffix)
 *   - Import the source file by its relative path
 *
 * This is the test-gate infrastructure for Direction 4 (tests as the gate).
 * Right now no test files exist in the project, so this returns [] and the
 * test gate is a no-op. The infrastructure is ready for when tests are added.
 */
function findTestFilesFor(sourceFilePath: string): string[] {
  const dir = dirname(sourceFilePath);
  // Strip the ACTUAL extension. basename(p, ".ts") leaves ".tsx" files
  // unchanged, so `console-stream.tsx` used to look for a co-located test
  // named `console-stream.tsx.test.ts` — never finding `console-stream.test.tsx`
  // (audit 2, item 13).
  const ext = sourceFilePath.endsWith(".tsx") ? ".tsx" : ".ts";
  const base = basename(sourceFilePath, ext);
  const testFiles: string[] = [];

  // 1. Co-located test file: foo.ts -> foo.test.ts, foo.tsx -> foo.test.tsx
  const coLocated = join(dir, `${base}.test${ext}`);
  if (existsSync(coLocated)) testFiles.push(coLocated);

  // 2. Scan the directory for .test.ts/.test.tsx files that import the source
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !(entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx"))) continue;
      const testPath = join(dir, entry.name);
      if (testPath === coLocated) continue; // already added
      try {
        const testContent = readFileSync(testPath, "utf-8");
        // Check if it imports the source file by name
        if (testContent.includes(`from "./${base}"`) || testContent.includes(`from './${base}'`)) {
          testFiles.push(testPath);
        }
      } catch {
        /* unreadable — skip */
      }
    }
  } catch {
    /* dir unreadable — skip */
  }

  return testFiles;
}

/**
 * System prompt for the test-writer (the ratchet).
 *
 * Characterization tests PIN the module's current observable behavior. Once
 * written, the test gate runs them on every future refactor of the module —
 * a refactor that changes pinned behavior is rejected. Each pass either adds
 * pins (tightening the contract) or refactors within them. That is the
 * ratchet: behavior gets increasingly locked while implementation gets
 * increasingly clean.
 */

/**
 * Extract the actual exported symbols from a TypeScript source string.
 * Used by the ratchet to inject the REAL export list into the test-writer
 * prompt, killing the #1 failure mode: the LLM hallucinating export names
 * that don't exist in the module (e.g. inventing `extractTopLevelExports`
 * when the file has `extractTopLevelFunctions`, or `SECURITY_THRESHOLD` when
 * the file has `SECURITY_LIMIT`). With the real list in the prompt, the LLM
 * is told "import ONLY these names" and the SyntaxError-on-import failures
 * stop.
 *
 * Regex-based (not a full AST) — fast, no dependency, good enough for a
 * prompt HINT. Strips comments + string/template literals first so the
 * regexes don't match inside them. Misses destructuring exports
 * (`export const { a, b } = obj`) and wildcard re-exports (`export * from`)
 * — both are rare in this codebase and the LLM seeing 90% of the real list
 * is enough to stop the hallucination pattern.
 *
 * Returns the export names + a "kind" label per name (function, class,
 * const, interface, type, enum, value, default). Kinds matter because:
 *   - interface/type exports are TYPE-ONLY — the prompt tells the LLM to
 *     `import type` them, never as runtime values (avoids "imported as a
 *     value but is a type" typecheck errors).
 *   - default exports need `import X from './base'` (no braces).
 */
export function extractExports(source: string): { names: string[]; kinds: Record<string, string> } {
  const names: string[] = [];
  const kinds: Record<string, string> = {};
  const seen = new Set<string>();
  const add = (name: string, kind: string) => {
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
      kinds[name] = kind;
    }
  };

  // Mask comments, string/template literals AND regex literals with the real
  // TypeScript scanner (code-analysis.ts). The previous order-sensitive regex
  // chain stripped comments BEFORE strings, so the `//` in a URL string
  // literal ate the rest of its line and the string regex then paired quotes
  // across lines — swallowing real export declarations (audit 2: for
  // sanitizer.ts, `sanitizeAndGovern` went missing from this list, which the
  // test-writer prompt calls "EXACTLY these symbols").
  const stripped = stripLiteralsAndComments(source);

  let m: RegExpExecArray | null;
  // export [async] function foo
  const funcRe = /export\s+(?:async\s+)?function\s*(?:\*)?\s+(\w+)/g;
  while ((m = funcRe.exec(stripped))) add(m[1], "function");
  // export class Foo
  const classRe = /export\s+class\s+(\w+)/g;
  while ((m = classRe.exec(stripped))) add(m[1], "class");
  // export const foo / export let foo
  const constRe = /export\s+(?:const|let)\s+(\w+)/g;
  while ((m = constRe.exec(stripped))) add(m[1], "const");
  // export interface Foo
  const ifaceRe = /export\s+interface\s+(\w+)/g;
  while ((m = ifaceRe.exec(stripped))) add(m[1], "interface");
  // export type Foo
  const typeRe = /export\s+type\s+(\w+)/g;
  while ((m = typeRe.exec(stripped))) add(m[1], "type");
  // export enum Foo
  const enumRe = /export\s+enum\s+(\w+)/g;
  while ((m = enumRe.exec(stripped))) add(m[1], "enum");
  // export { foo, bar as baz, qux } — re-exports. Use the ALIAS (baz), not the
  // local name (bar), since that's what the importing test will use.
  const reexportRe = /export\s*\{([^}]+)\}/g;
  while ((m = reexportRe.exec(stripped))) {
    const list = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    for (const item of list) {
      const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
      const name = asMatch ? asMatch[2] : item.split(/\s+as\s+/)[0].trim();
      if (/^\w+$/.test(name)) add(name, "value");
    }
  }
  // export default — note it separately; tests import it without braces.
  if (/export\s+default\b/.test(stripped)) add("__default", "default");

  return { names, kinds };
}

/** Format the export list for injection into the ratchet prompt. Returns a
 *  human-readable bulleted list like:
 *    - foo (function)
 *    - Bar (class)
 *    - baz (const)
 *    - Qux (interface — import type)
 *    - default (import without braces)
 *  Returns "" if the module has no exports (the prompt then says "no
 *  exports — write only smoke tests that import the module doesn't crash"). */
function formatExportList(exps: { names: string[]; kinds: Record<string, string> }): string {
  if (exps.names.length === 0) return "(none — this module has no named exports)";
  return exps.names
    .map((n) => {
      const k = exps.kinds[n];
      if (k === "default") return `- default (import WITHOUT braces: \`import X from "./base"\`)`;
      if (k === "interface" || k === "type")
        return `- ${n} (${k} — TYPE-ONLY: use \`import type { ${n} }\`)`;
      return `- ${n} (${k})`;
    })
    .join("\n");
}

const TEST_WRITER_SYSTEM = `You are a test engineer writing characterization tests for a TypeScript module inside an autonomous self-improvement pipeline. The tests you write become a PERMANENT behavioral contract: future refactors of this module will be REJECTED if they break your tests.

Your job: write bun:test tests that PIN the module's CURRENT observable behavior.

Rules:
- Import { describe, test, expect } from "bun:test"
- Import the module under test using a relative path (e.g. from "./moduleName")
- The user prompt will give you the EXACT list of exports this module provides. Import ONLY those names — do NOT invent exports. If the prompt says the module exports \`foo\` and \`Bar\`, you may import \`foo\` and \`Bar\` and NOTHING ELSE from this module. Inventing export names like \`extractTopLevelExports\` when the real export is \`extractTopLevelFunctions\` causes a SyntaxError at import time and rejects your test.
- For interface and type exports, use \`import type { X }\` — they are TYPE-ONLY and cannot be imported as runtime values.
- For default exports, use \`import X from "./base"\` (no braces).
- Test the EXPORTED functions/classes with realistic inputs, including edge cases (empty strings, boundary numbers, null/undefined only where the signature allows them)
- Assert CONCRETE expected values derived from reading the implementation — compute the expected output yourself from the logic, do not call the function to obtain it
- EVERY test() callback MUST contain at least one expect() call. A test with no assertions is rejected. Do not write skeleton tests like \`test('does X', () => {})\` — always assert.
- NO tautological tests: never expect(f(x)).toBe(f(x)), never expect(x).toBe(x), never assertions that always pass
- Do NOT re-implement the module's logic inside the test to compute the expected value
- If an export's behavior depends on external state (DB, network, filesystem, env), test only the pure logic; skip integration-heavy paths
- Write 3-8 focused tests inside one describe block
- Do not test implementation details that refactoring may legitimately change; test observable outputs

Worked example (the pattern to follow):
Given a source file \`./add.ts\`:
\`\`\`typescript
export function add(a: number, b: number): number { return a + b; }
export const ZERO = 0;
export interface AddResult { sum: number; }
\`\`\`
The prompt would tell you: "exports: - add (function), - ZERO (const), - AddResult (interface — TYPE-ONLY)".
A CORRECT test:
\`\`\`typescript
import { describe, test, expect } from "bun:test";
import { add, ZERO, type AddResult } from "./add";

describe("add", () => {
  test("returns the sum of two positive numbers", () => {
    expect(add(2, 3)).toBe(5);  // computed from the implementation: 2+3=5
  });
  test("returns ZERO when both inputs are 0", () => {
    expect(add(ZERO, ZERO)).toBe(0);
  });
});
\`\`\`
A WRONG test (do NOT do this):
\`\`\`typescript
import { add, extractSum } from "./add";  // WRONG: extractSum does not exist
describe("add", () => {
  test("adds numbers", () => {});  // WRONG: no expect()
  test("adds", () => { expect(add(2, 3)).toBe(7); });  // WRONG: 2+3 is 5, not 7
});
\`\`\`

OUTPUT FORMAT (mandatory):
- First, a SHORT summary starting with "## Changes" listing which behaviors you pinned.
- Then the complete test file in a single fenced \`\`\`typescript block.`;

// Files the system should NOT modify (would break the loop itself).
// Imported from protected-files.ts — the SINGLE shared set (audit 2: the
// loop's set and the task-generator's set had drifted apart). Re-exported
// so the /api/self-enhance/files route keeps reporting the real set.
export { PROTECTED_FILES } from "./protected-files";
import { PROTECTED_FILES } from "./protected-files";

export interface SelfEnhanceResult {
  filePath: string;
  enhanced: boolean;
  reason: string;
  oldBytes: number;
  newBytes: number;
  diffBytes: number;
  llmUsed: boolean;
  llmLatencyMs: number;
  compiled: boolean;
  pushed: boolean;
  commitSha?: string;
}

class SelfEnhanceLoop {
  private running = false;
  private continuous = false;
  private currentFile: string | null = null;
  // Per-enhancement branch: when set, ALL gitPush calls in this enhanceFile
  // (test pin + enhancement) push to this branch instead of the configured
  // seed branch. Computed at enhanceFile start from lastBranchNumber + 1.
  // Cleared at enhanceFile end (success or fail). The counter is bumped in
  // the DB only after the enhancement push succeeds — failed attempts don't
  // consume a branch number.
  private currentCycleBranch: string | null = null;
  // Fix B: count consecutive cycles where every file was deferred due to the
  // shared LLM rate-limit gate. After 3 such cycles, log a loud "LLM quota
  // exhausted" message so the user knows the loop is alive but blocked (not
  // hung, not crashed — just waiting for the gate to open). The loop does NOT
  // auto-stop: when the gate clears, it resumes automatically. Reset on any
  // file that actually attempts an LLM call (success or non-cooldown failure).
  private consecutiveCooldownCycles = 0;
  private quotaExhaustedLogged = false;
  // Run-token (generation counter). Incremented by stop(). Each runCycle /
  // enhanceFile captures the value at start; if it changes mid-run (because
  // the user stopped and possibly started again), the in-flight work breaks
  // out of its for-loop / returns early instead of running to completion
  // against a stale `running` flag. This is the fix for the stop-then-start
  // race: previously stop() set running=false, which (a) didn't break the
  // for-loop in runCycle (it kept iterating files for ~6min), and (b) defeated
  // the `if (this.running) return` guard so a new start could spawn a second
  // concurrent cycle sharing currentCycleBranch / currentFile.
  private runId = 0;
  // LESSON FEEDBACK channel: the ids of the lessons injected into the
  // CURRENT enhanceFile's prompt. Set at prompt-build time, consumed by
  // runCycle right after the verdict lands (pass → helped, fail →
  // hindered; fail-matching-lesson → lapse, D1). The loop is strictly
  // serial (one file at a time), so an instance field is a safe
  // hand-off. Cleared at the top of every enhanceFile so a stale list
  // can never feed back twice.
  private lastLessonIds: string[] = [];
  // D4 (corpus): per-attempt provenance scratch, same hand-off pattern
  // as lastLessonIds. Set inside enhanceFile/enhanceSchema at the
  // points where the originals/proposals/summaries are in scope;
  // consumed by runCycle's corpus writer after the verdict.
  private lastAttemptInfo: {
    originalSha: string;
    mutatedSha: string | null;
    transformSummary: string | null;
    branchNumber: number | null;
  } = { originalSha: "", mutatedSha: null, transformSummary: null, branchNumber: null };
  // Ratchet: per-file test-writing attempt tracking. After 2 failed attempts
  // (bad tests, untestable module, LLM trouble), stop retrying — but forget
  // failures older than 30 minutes, so an intermittent 429 window doesn't
  // permanently skip a module for the rest of the server's life.
  private testWriteAttempts = new Map<string, { attempts: number; at: number }>();
  // Per-file saturation state (phase 1: lockout-on-stable). Keyed by
  // repo-relative path. A file is LOCKED OUT after SATURATION_THRESHOLD
  // consecutive no-growth cycles. Locked files are skipped by runCycle —
  // no LLM calls, no quota burn. The user unlocks via the UI (or a server
  // restart resets everything, which is a natural "new pass" boundary).
  private saturation = new Map<string, FileSaturation>();
  private stats = {
    totalScanned: 0,
    totalEnhanced: 0,
    totalReverted: 0,
    totalPushed: 0,
    testsWritten: 0,
    cyclesCompleted: 0,
    tasksGenerated: 0,
    lastEnhancementAt: null as string | null,
  };
  private logs: Array<{
    timestamp: string;
    message: string;
    type: "info" | "success" | "warn" | "error";
  }> = [];

  private log(message: string, type: "info" | "success" | "warn" | "error" = "info") {
    const entry = {
      timestamp: new Date().toLocaleTimeString(),
      message,
      type,
    };
    this.logs.unshift(entry);
    if (this.logs.length > 500) this.logs.pop();
    const prefix =
      type === "success" ? "✓" : type === "warn" ? "⚠" : type === "error" ? "✗" : "→";
    console.log(`[SELF-ENHANCE] ${prefix} ${message}`);
  }

/**
 * Scan for files to enhance. Full-scope mode (TARGET_FILES empty):
 * every enabled SCAN_SCOPE, minus protected paths, plus the Prisma
 * schema as a special single-file target. Focus mode (TARGET_FILES
 * non-empty): only the listed files. Either way, PROTECTED_FILES /
 * PROTECTED_PREFIXES are the hard floor — isProtectedPath filters
 * every candidate.
 */
  private scanFiles(): string[] {
    const focus = TARGET_FILES.length > 0;
    const allowSet = new Set(TARGET_FILES);
    const files: string[] = [];
    const scan = (dir: string, extensions: string[]) => {
      let entries: import("fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // directory doesn't exist yet
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, extensions);
        } else {
          const isTs = entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts");
          const isTsx = entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx");
          const matches =
            (extensions.includes(".ts") && isTs) ||
            (extensions.includes(".tsx") && isTsx);
          if (matches) {
            const relPath = relative(PROJECT_ROOT, fullPath);
            // Two filters: (1) not protected (the hard floor — engine,
            // control surface, control API subtree), (2) in the allowlist
            // when focus mode is on.
            if (!isProtectedPath(relPath) && (!focus || allowSet.has(relPath))) {
              files.push(fullPath);
            }
          }
        }
      }
    };
    for (const scope of SCAN_SCOPES) {
      scan(join(PROJECT_ROOT, scope.dir), scope.extensions);
    }
    // The Prisma schema — only in full-scope mode, never in focus mode
    // (focus means the operator named specific files; the schema is never
    // named by accident).
    if (!focus && existsSync(join(PROJECT_ROOT, SCHEMA_TARGET))) {
      files.push(join(PROJECT_ROOT, SCHEMA_TARGET));
    }
    return files;
  }

  /**
   * Detect truncated LLM output. Delegates to the parser-based
   * implementation in code-analysis.ts — see that file for why raw
   * character counting produced false positives on perfectly valid files
   * (brace imbalance inside strings/regexes read as "truncation", and each
   * false positive recorded a bogus "LLM hit its output token limit"
   * postmortem that then poisoned the next prompt).
   */
  private checkTruncation(code: string, original: string, filePath?: string): { truncated: boolean; reason?: string } {
    return detectTruncation(code, original, filePath);
  }

  /**
   * Verify a refactored file IN MEMORY — spawns the verify-refactor script
   * as a child process, passes the refactored code via stdin, and returns
   * whether it typechecks. NOTHING is written to disk — Turbopack never
   * sees the refactored code until it passes verification.
   */
  private verifyRefactor(filePath: string, refactoredCode: string): { ok: boolean; errors: string[] } {
    try {
      const result = spawnSync(
        "bun",
        ["run", "src/lib/pipeline/autonomous/verify-refactor.ts", filePath],
        {
          cwd: PROJECT_ROOT,
          input: refactoredCode,
          timeout: 60000,
          encoding: "utf-8",
        }
      );

      const stdout = (result.stdout || "").trim();
      if (!stdout) {
        const stderr = (result.stderr || "").slice(0, 200);
        return { ok: false, errors: [`Verifier produced no output${stderr ? `: ${stderr}` : ""}`] };
      }

      try {
        const parsed = JSON.parse(stdout) as { ok: boolean; errors: string[] };
        return parsed;
      } catch {
        return { ok: false, errors: [`Verifier output not JSON: ${stdout.slice(0, 200)}`] };
      }
    } catch (err) {
      return { ok: false, errors: [`Verifier failed to run: ${(err as Error).message}`] };
    }
  }

  /**
   * Git commit and push the current live state via the configured push target
   * (authenticated; see push-target.ts). Falls back to commit-only when no
   * target is configured.
   */
  private async gitPush(message: string): Promise<{ pushed: boolean; commitSha?: string }> {
    try {
      const outcome = await pushCurrentState({
        message,
        ...(this.currentCycleBranch ? { branchOverride: this.currentCycleBranch } : {}),
      });
      if (outcome.pushed) {
        this.log(`Pushed to GitHub: ${outcome.commitSha} (${outcome.repo})`, "success");
        return { pushed: true, commitSha: outcome.commitSha };
      }
      if (!outcome.error) {
        // No changes to commit and nothing new to push
        return { pushed: false };
      }
      if (outcome.commitSha) {
        this.log(`Committed ${outcome.commitSha} but push failed: ${outcome.error}`, "warn");
      } else {
        this.log(`Push skipped: ${outcome.error}`, "warn");
      }
      return { pushed: false, commitSha: outcome.commitSha };
    } catch (err) {
      this.log(`Git operation failed: ${(err as Error).message}`, "error");
      return { pushed: false };
    }
  }

  /**
   * Detect banner-style comments: decorative separator lines (====, ----, ****,
   * ────, ════) or attribution/branding phrases. Plain JSDoc docstrings do NOT match.
   */
  private static looksLikeBanner(comment: string): boolean {
    // A line that is essentially a separator run, optionally prefixed with "//"
    const hasSeparatorLine = /(^|\n)\s*(?:\/\/)?\s*[=*\-#~─═]{4,}\s*(?=\n|$)/.test(comment);
    // Attribution / branding phrases
    const hasBranding =
      /enhanced by|mutated by|refactored by|auto-generated|auto-refactor/i.test(comment);
    return hasSeparatorLine || hasBranding;
  }

  /**
   * Strip a LEADING banner comment (block or line-comment style) from refactored
   * output. Conservative: only strips if it matches banner heuristics, so
   * legitimate file docstrings survive.
   */
  private stripBannerComments(code: string): { code: string; stripped: boolean } {
    let out = code;

    // Leading block comment
    const blockMatch = out.match(/^\/\*+\s*[\s\S]*?\*+\/\s*/);
    if (blockMatch && SelfEnhanceLoop.looksLikeBanner(blockMatch[0])) {
      out = out.slice(blockMatch[0].length);
      return { code: out.replace(/^\s*\n/, ""), stripped: true };
    }

    // Leading run of // line comments
    const lineMatch = out.match(/^(?:[ \t]*\/\/[^\n]*\n)+/);
    if (lineMatch && SelfEnhanceLoop.looksLikeBanner(lineMatch[0])) {
      out = out.slice(lineMatch[0].length);
      return { code: out.replace(/^\s*\n/, ""), stripped: true };
    }

    return { code: out, stripped: false };
  }

  /**
   * DEBATE GATE — a second LLM reviews the proposed refactor before write.
   *
   * The typecheck gate proves "compiles". The structural validator proves
   * "didn't drop exports / wasn't truncated". NEITHER proves "the change is
   * semantically correct and safe." A second LLM (Security + Architecture +
   * Lead tribunal from debate-llm.ts) evaluates the candidate code and can
   * REJECT or REQUIRES_REWRITE it. This is the missing semantic gate — the
   * typecheck can't catch "added a null check that breaks the happy path."
   *
   * If the debate LLM is unavailable, fall back to APPROVED (don't block
   * the whole loop on the second-LLM being down — the first gate already
   * passed typecheck + structural).
   */
  private async debateGate(
    filePath: string,
    originalCode: string,
    refactoredCode: string,
    changeSummary: string
  ): Promise<{ approved: boolean; reason: string; verdict?: string; deferred?: boolean }> {
    try {
      const topic = `Proposed refactor of ${relative(PROJECT_ROOT, filePath)}: ${changeSummary.slice(0, 200)}`;
      const result = await conductLlmDebate(topic, refactoredCode, filePath);
      const consensus = result.verdict.consensus;

      if (consensus === "APPROVED" || consensus === "CONDITIONAL_APPROVAL") {
        return { approved: true, reason: `Debate: ${consensus}`, verdict: consensus };
      }
      // REJECTED or REQUIRES_REWRITE
      return {
        approved: false,
        reason: `Debate rejected (${consensus}): ${result.verdict.leadSummary ?? "no rationale"}`,
        verdict: consensus,
      };
    } catch (err) {
      // FAIL CLOSED (audit 2). This used to return approved:true so an LLM
      // outage wouldn't block the loop — but that let refactors go live (and
      // tests get pinned) with ZERO semantic review during exactly the
      // moments the LLM layer is least trustworthy. It also contradicted
      // debate-llm.ts's own "NO FALLBACK" contract. Now an unavailable
      // tribunal DEFERS the file: no postmortem, no failure counter, no
      // reverted stat — the loop's cooldown gate handles the wait and the
      // file is retried when the tribunal can actually run.
      const msg = (err as Error).message ?? "unknown error";
      const rateLimited = /\b429\b|rate.?limit|cooldown|too many requests/i.test(msg);
      return {
        approved: false,
        deferred: true,
        reason: rateLimited
          ? `Debate tribunal rate-limited — deferring: ${msg.slice(0, 100)}`
          : `Debate tribunal unavailable — deferring (fail-closed): ${msg.slice(0, 100)}`,
      };
    }
  }

  /**
   * TEST GATE — run any test files that cover the target file.
   *
   * This is THE real signal from DIRECTIONS.md (Direction 4: tests as the
   * gate). Typecheck proves "compiles". Tests prove "behavior preserved."
   *
   * Finds test files that import the target file and runs them with `bun test`.
   * If any test fails, REJECT the refactor (don't write, don't push).
   * If no tests exist for the file, the gate passes (no signal = no block).
   *
   * The refactored code must be written to disk for the test runner to see
   * it — BUT we only write if typecheck already passed, and we REVERT
   * immediately if tests fail. The window is small and the typecheck gate
   * already guaranteed it compiles.
   */
  private testGate(filePath: string, refactoredCode: string): { passed: boolean; reason: string; testCount: number } {
    const relPath = relative(PROJECT_ROOT, filePath);
    const testFiles = findTestFilesFor(filePath);
    if (testFiles.length === 0) {
      return { passed: true, reason: "no tests for this file", testCount: 0 };
    }

    // Write the refactored code so the test runner sees it
    const originalOnDisk = readFileSync(filePath, "utf-8");
    writeFileSync(filePath, refactoredCode, "utf-8");

    try {
      let failures = 0;
      let totalTests = 0;
      for (const testFile of testFiles) {
        const result = spawnSync("bun", ["test", testFile], {
          cwd: PROJECT_ROOT,
          timeout: 30000,
          encoding: "utf-8",
        });
        totalTests++;
        if (result.status !== 0) {
          failures++;
          const stderr = (result.stderr || "").slice(0, 300);
          // Revert immediately so the broken code isn't live
          writeFileSync(filePath, originalOnDisk, "utf-8");
          return {
            passed: false,
            reason: `test failed: ${testFile} — ${stderr.slice(0, 200)}`,
            testCount: totalTests,
          };
        }
      }
      return { passed: true, reason: `${testFiles.length} test file(s) passed`, testCount: totalTests };
    } catch (err) {
      // Revert on any unexpected error
      writeFileSync(filePath, originalOnDisk, "utf-8");
      return { passed: false, reason: `test runner error: ${(err as Error).message}`, testCount: 0 };
    }
  }

  /**
   * SATURATION CHECK — is this refactor actually meaningful, or just churn?
   *
   * Strips comments and whitespace from both original and refactored code,
   * then compares. If the only changes are comments/whitespace/renamed
   * locals, it's cosmetic churn — skip the write+push+debate cycle entirely.
   * EMG's "SATURATION EQUILIBRIUM PROTOCOL": if the code is already optimal,
   * output NO_CHANGES_NEEDED. We detect the equivalent after the fact.
   */
  private isCosmeticChange(original: string, refactored: string): boolean {
    // Mask comments with the real scanner (code-analysis.ts), then strip all
    // whitespace, then compare. Comment churn is cosmetic; code and string
    // content are not. The old regex chain stripped `//` inside STRING
    // literals too, so a real change after a URL on the same line looked
    // cosmetic (audit 2).
    const strip = (s: string) => stripComments(s).replace(/\s+/g, "");
    return strip(original) === strip(refactored);
  }

  /**
   * ANTI-TAUTOLOGY CHECK — reject test files that assert nothing real.
   *
   * A test that always passes pins nothing — it's a fake pin. The ratchet
   * is only as strong as its weakest test, so generated tests are checked
   * for the classic tautology patterns before they're ever run:
   *   - doesn't import the module under test (tests nothing)
   *   - fewer than 2 test blocks (too thin to be a contract)
   *   - fewer expect() calls than tests (a test without assertions)
   *   - literal self-comparisons: expect(X).toBe(X)
   *   - simple-expression self-comparisons: expect(f(1)).toBe(f(1))
   * The debate gate adds semantic review on top of these mechanical checks.
   */
  private antiTautologyCheck(testCode: string, importBase: string): { ok: boolean; issues: string[] } {
    const issues: string[] = [];

    // Must import the module under test (relative import from the same dir)
    if (!testCode.includes(`from "./${importBase}"`)) {
      issues.push(`does not import the module under test (expected 'from "./${importBase}"')`);
    }

    // Need at least 2 test blocks to be a meaningful contract
    const testBlocks = (testCode.match(/\btest\s*\(/g) ?? []).length;
    if (testBlocks < 2) {
      issues.push(`only ${testBlocks} test() block(s) — need at least 2`);
    }

    // Every test needs at least one assertion
    const expects = (testCode.match(/\bexpect\s*\(/g) ?? []).length;
    if (testBlocks > 0 && expects < testBlocks) {
      issues.push(`${expects} expect() call(s) for ${testBlocks} test(s) — every test needs assertions`);
    }

    // Literal self-comparison: expect(true).toBe(true), expect(5).toBe(5), expect(x).toBe(x)
    const selfCompare = /expect\s*\(\s*([^()]+?)\s*\)\s*\.\s*toBe\s*\(\s*([^()]+?)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = selfCompare.exec(testCode)) !== null) {
      if (m[1].trim() === m[2].trim()) {
        issues.push(`tautological assertion: expect(${m[1].trim()}).toBe(${m[2].trim()}) — asserts nothing`);
        break; // one report is enough
      }
    }

    return { ok: issues.length === 0, issues };
  }

  /**
   * THE RATCHET — write characterization tests for an untested module.
   *
   * This is Direction 4 made real: the system writes its own tests, the
   * tests become the gate for every future refactor of that module. Each
   * pass either adds pins (tightening the behavioral contract) or refactors
   * within them. Behavior gets increasingly locked while implementation
   * gets increasingly clean — and a refactor that breaks a pin is rejected
   * by the test gate built in the previous step.
   *
   * Gates on the generated test file (in order):
   *   1. truncation + anti-tautology (mechanical, instant)
   *   2. WRITE TEMP → `bun test` — must PASS on the current code
   *      (a test failing on current code pins wrong behavior — reject it,
   *      do NOT "fix" the code to match a generated test)
   *   3. `tsc --noEmit` — type errors in the test file → reject
   *   4. debate gate (semantic review: is this a real behavioral test?)
   *   5. keep + push. The pin is live.
   *
   * On any failure: DELETE the test file (it was new — nothing imports it,
   * so the live system was never at risk) and record the attempt. After 2
   * failed attempts per file, stop trying (don't burn LLM budget retrying).
   *
   * Test files are write-once: the refactor scan excludes *.test.ts, so the
   * system can never weaken its own pins. The ratchet only tightens.
   */
  private async writeTestsForFile(filePath: string): Promise<boolean> {
    const relPath = relative(PROJECT_ROOT, filePath);
    // Strip the real extension (.ts/.tsx) — same bug as findTestFilesFor:
    // basename(p, ".ts") left .tsx sources with their extension attached, so
    // the ratchet wrote/looked for `console-stream.tsx.test.ts`.
    const ext = filePath.endsWith(".tsx") ? ".tsx" : ".ts";
    const base = basename(filePath, ext);
    const testPath = join(dirname(filePath), `${base}.test${ext}`);

    if (existsSync(testPath)) return false; // already pinned
    const now = Date.now();
    // `let`, not `const`: when the decay branch fires we must forget the
    // stale record, otherwise the (rec?.attempts ?? 0) + 1 below would still
    // read the pre-decay counter and the 30-min forget window would be a
    // no-op. Bug surfaced by the audit: a file first tried at 12:40 showed
    // "attempt 2" at 1:38 — the decay didn't reset it.
    let rec = this.testWriteAttempts.get(relPath);
    // Decay: forget failures older than 30 minutes — intermittent 429 windows
    // shouldn't permanently skip a module
    if (rec && now - rec.at > 30 * 60 * 1000) {
      this.testWriteAttempts.delete(relPath);
      rec = undefined;
    }
    if (rec && rec.attempts >= 2) {
      return false; // known-failed recently — don't burn LLM budget retrying
    }
    // NOTE (audit 2): no pre-increment. The attempt counter is only bumped
    // AFTER a real (non-rate-limited) LLM call completes below. Previously
    // the increment happened before the call, so two gate deferrals (each
    // returning instantly with rateLimited:true) burned both attempts and
    // locked the module out for 30 minutes — against the "defer, don't
    // burn an attempt" contract in agent-llm.ts.

    try {
      const source = readFileSync(filePath, "utf-8");
      if (source.length > 12000) return false; // too large for the LLM prompt

      this.log(`Ratchet: writing characterization tests for ${relPath} (attempt ${(rec?.attempts ?? 0) + 1})...`, "info");

      // Inject the REAL export list so the LLM can't hallucinate names. This
      // is the #1 ratchet failure mode: without the list, the LLM invents
      // exports like `extractTopLevelExports` (when the real one is
      // `extractTopLevelFunctions`) and the test fails at import time with
      // `SyntaxError: Export named 'X' not found`. With the list, the LLM
      // is told exactly what it can import.
      const exps = extractExports(source);
      const exportList = formatExportList(exps);

      // D3 (dreamer): an idle-time DRAFT for this module may exist — a
      // speculative characterization test drafted while the loop was
      // waiting. ADVISORY ONLY: hand it over as a starting point. Every
      // import and expectation still passes through the real ratchet
      // gates below (anti-tautology, bun-test-pass, tsc, debate); a bad
      // draft dies there and cost one prompt slot.
      const draft = getRatchetDraft(relPath);
      const draftBlock = draft
        ? `\nA DRAFT from the idle-time dreamer (speculative, NEVER trusted blindly — verify every import against the export list above and every expected value against the implementation; discard anything that doesn't check out):\n\`\`\`typescript\n${draft.slice(0, 6000)}\n\`\`\`\n`
        : "";

      const userPrompt = `Module to pin: ${relPath}

This module exports EXACTLY these symbols (import ONLY from "./${base}", do NOT invent any other export names):
${exportList}

Source:
\`\`\`typescript
${source}
\`\`\`
${draftBlock}
Write ${base}.test.ts — a bun:test characterization suite pinning this module's current observable behavior. Compute expected values yourself from the implementation (read the logic, work out the output, assert that exact value). Every test() must contain at least one expect(). Output the summary first, then the test file.`;

      const llmResult = await llmComplete({
        systemPrompt: TEST_WRITER_SYSTEM,
        userPrompt,
        temperature: 0.2,
        onRetry: (info) => {
          const backoff = info.isRateLimit ? `${Math.round(info.delayMs / 1000)}s` : `${info.delayMs}ms`;
          this.log(`LLM retry attempt ${info.attempt}/${info.maxAttempts} (${info.isRateLimit ? "429" : "err"} — backing off ${backoff}) for ratchet/${relPath}`, "info");
        },
      });
      if (!llmResult.ok && llmResult.rateLimited) {
        // Gate deferral — NOT an attempt. The runCycle loop sleeps out the
        // cooldown and this module is retried fresh when the gate opens.
        this.log(`Ratchet: deferring test-writing for ${relPath} — LLM on cooldown (${(llmResult.error ?? "").slice(0, 90)})`, "warn");
        return false;
      }
      // A real LLM call was consumed — count it as an attempt NOW (success
      // or failure): if this pin doesn't survive the gates below, the next
      // try is attempt N+1, and after 2 the module is left alone for 30 min.
      this.testWriteAttempts.set(relPath, { attempts: (rec?.attempts ?? 0) + 1, at: now });
      if (!llmResult.ok) {
        this.log(`Ratchet: test-writing LLM unavailable for ${relPath}: ${(llmResult.error ?? "").slice(0, 120)}`, "warn");
        return false;
      }

      const { summary, code } = extractSummaryAndCode(llmResult.content);
      if (!code || !code.trim()) {
        this.log(`Ratchet: LLM returned no test code for ${relPath}`, "warn");
        return false;
      }

      // Gate 1: truncation + anti-tautology (mechanical, instant)
      const truncation = this.checkTruncation(code, "", testPath);
      if (truncation.truncated) {
        this.log(`Ratchet: rejected test for ${relPath} (truncated: ${truncation.reason})`, "warn");
        return false;
      }
      const taut = this.antiTautologyCheck(code, base);
      if (!taut.ok) {
        this.log(`Ratchet: rejected test for ${relPath} — ${taut.issues.join("; ")}`, "warn");
        return false;
      }

      // Gate 2: write temp + run — the tests must PASS on the CURRENT code.
      // A failing test pins wrong behavior (or found a real bug — but the
      // system doesn't get to redefine behavior via its own generated tests,
      // so conservative policy: reject the test, keep the code).
      writeFileSync(testPath, code, "utf-8");
      const run = spawnSync("bun", ["test", testPath], {
        cwd: PROJECT_ROOT,
        timeout: 60000,
        encoding: "utf-8",
      });
      if (run.status !== 0) {
        const stderr = ((run.stderr || "") + (run.stdout || "")).slice(0, 250);
        rmSync(testPath);
        this.log(`Ratchet: rejected test for ${relPath} (fails on current code — pins wrong behavior): ${stderr}`, "warn");
        return false;
      }

      // Gate 3: typecheck — errors mentioning the test file → reject.
      // (Pre-existing errors elsewhere are not the test's fault — bun test
      // already proved the test runs; tsc-scoped errors are what matter.)
      const tsc = spawnSync("bunx", ["tsc", "--noEmit"], {
        cwd: PROJECT_ROOT,
        timeout: 120000,
        encoding: "utf-8",
      });
      const tscOut = `${tsc.stdout || ""}${tsc.stderr || ""}`;
      if (tsc.status !== 0 && tscOut.includes(`${base}.test.ts`)) {
        rmSync(testPath);
        this.log(`Ratchet: rejected test for ${relPath} (typecheck errors in the test file)`, "warn");
        return false;
      }

      // Gate 4: debate — semantic review of the test file
      const debate = await this.debateGate(filePath, source, code, `characterization tests: ${summary.slice(0, 200)}`);
      if (!debate.approved) {
        rmSync(testPath);
        if (debate.deferred) {
          // Tribunal unavailable (429 window / parse failure) — fail-closed.
          // The pin is retried on a later pass; it is NOT counted as a
          // rejection (the attempt was already recorded above).
          this.log(`Ratchet: deferring test pin for ${relPath} — debate tribunal unavailable, not auto-approving (fail-closed)`, "warn");
        } else {
          this.log(`Ratchet: rejected test for ${relPath} by debate: ${debate.reason.slice(0, 150)}`, "warn");
        }
        return false;
      }

      // All gates passed — the pin is LIVE. Future refactors of this module
      // now run against these tests (the test gate finds co-located tests).
      this.stats.testsWritten++;
      const testCount = (code.match(/\btest\s*\(/g) ?? []).length;
      this.log(`Ratchet: PINNED ${relPath} with ${testCount} characterization tests — future refactors run against them (${debate.reason})`, "success");

      const pushResult = await this.gitPush(`test: pin behavior of ${relPath}\n\n${summary}\n\n(characterization tests — the ratchet: refactors that break these are rejected)`);
      if (pushResult.pushed) {
        this.log(`Ratchet: pushed test pin ${pushResult.commitSha}`, "success");
      }
      return true;
    } catch (err) {
      // Clean up any partially-written test file — never leave a broken pin
      try {
        if (existsSync(testPath)) rmSync(testPath);
      } catch {
        /* ignore */
      }
      this.log(`Ratchet: error writing tests for ${relPath}: ${(err as Error).message}`, "error");
      return false;
    }
  }

  /**
   * Enhance a single file: LLM refactor → verify tsc → write live → git push.
   */
  async enhanceFile(filePath: string): Promise<SelfEnhanceResult> {
    const relPath = relative(PROJECT_ROOT, filePath);
    this.currentFile = relPath;
    const startTime = Date.now();
    // Capture the current run generation. If stop() fires during this
    // enhanceFile (incrementing runId), we abort at the next checkpoint
    // (after the ratchet, before the LLM enhance call) instead of running
    // the full ~150s backoff + typecheck + push against a stale run.
    const myRun = this.runId;

    // ── SCHEMA PATH ── prisma/schema.prisma doesn't go through the
    // tsc/AST/debate chain (none of those apply to a non-TS DSL). It
    // gets its own prompt and the additive-only schema gate. Routed
    // here, before the ratchet — you can't characterization-test a
    // schema, and the schema gate IS the gate.
    if (relPath === SCHEMA_TARGET) {
      return this.enhanceSchema(filePath, myRun);
    }

    // Compute this enhancement's branch: loop-{N+1} where N is the last
    // successful enhancement's number. Stored on the instance so every
    // gitPush in this enhanceFile (test pin + enhancement) targets the
    // same branch — one full mutation = one branch.
    const lastN = await getLastBranchNumber();
    const thisN = lastN + 1;
    this.currentCycleBranch = formatLoopBranch(thisN);
    this.log(`Branch for this mutation: ${this.currentCycleBranch}`, "info");

    const result: SelfEnhanceResult = {
      filePath: relPath,
      enhanced: false,
      reason: "",
      oldBytes: 0,
      newBytes: 0,
      diffBytes: 0,
      llmUsed: false,
      llmLatencyMs: 0,
      compiled: false,
      pushed: false,
    };

    try {
      // 1. Read the current file
      const originalCode = readFileSync(filePath, "utf-8");
      result.oldBytes = originalCode.length;
      // D4 (corpus): provenance for this attempt — what the source looked
      // like before anyone touched it. Set here (top of the attempt) so
      // every downstream return path carries it via lastAttemptInfo.
      this.lastAttemptInfo = {
        originalSha: sha16(originalCode),
        mutatedSha: null,
        transformSummary: null,
        branchNumber: thisN,
      };

      // 1a. Skip files that are too large for the LLM to refactor without truncating.
      // The model's output token limit means files over ~12KB often get cut off
      // mid-comment, producing syntax errors that waste a full typecheck cycle.
      const MAX_FILE_BYTES = 12000;
      if (originalCode.length > MAX_FILE_BYTES) {
        result.reason = `Skipped (file too large: ${originalCode.length}b > ${MAX_FILE_BYTES}b)`;
        this.log(`Skipped ${relPath} (${originalCode.length}b — too large for LLM, would truncate)`, "info");
        return result;
      }

      // 1b. THE RATCHET — pin untested modules with characterization tests
      // BEFORE refactoring. The pins become the gate for the refactor in
      // this same pass (and all future ones): if the refactor below breaks
      // a pinned behavior, the test gate rejects it. Each pass either adds
      // pins or refactors within them. Test files are write-once (the scan
      // excludes *.test.ts), so the system can never weaken its own pins.
      // Protected files are skipped: they're the gate itself (importing the
      // loop singleton in a test would have side effects).
      if (!PROTECTED_FILES.has(relPath)) {
        await this.writeTestsForFile(filePath);
      }

      // Run-token checkpoint (Fix C): if stop() fired during the ratchet,
      // bail before the LLM enhance call. Token-only (audit 2): checking
      // `!this.continuous` here is what broke the MANUAL trigger — a
      // one-shot cycle runs with continuous=false and used to abort every
      // file as "Stopped during ratchet". stop() always bumps runId, so the
      // token alone covers both modes.
      if (myRun !== this.runId) {
        result.reason = "Stopped during ratchet";
        this.log(`Aborting enhance for ${relPath} — stop requested`, "warn");
        return result;
      }

      // Fix B: gate checkpoint. If the ratchet just set the gate (or it was
      // already active), defer the enhance call — don't burn a 2-attempt LLM
      // call that will immediately 429 and re-set the gate at a higher
      // escalation level. The for-loop in runCycle will sleep until the gate
      // opens before attempting the next file.
      const cooldownAfterRatchet = llmCooldownMs();
      if (cooldownAfterRatchet > 0) {
        result.reason = `Deferred (LLM cooldown — ${Math.round(cooldownAfterRatchet / 1000)}s)`;
        this.log(`Deferring enhance for ${relPath} — LLM on cooldown (${Math.round(cooldownAfterRatchet / 1000)}s remaining)`, "warn");
        return result;
      }

      // 2. Check for postmortem constraints
      const postmortem = await postmortemStore.getConstraintsForFile(
        "self",
        "main",
        relPath
      );

      // 2b. Ancestral RAG (concept: DARLEK_CAAN queryAncestralWisdom / GRAFT 3).
      // The per-file postmortem (above) only sees THIS file's history.
      // The ancestral query pulls VERIFIED postmortems from OTHER files
      // whose symptom/evidence/constraints match a keyword derived
      // from this file's path + (if present) its current symptom. So a
      // syntax-drop failure on foo.ts teaches a constraint that surfaces
      // when enhancing bar.ts. Local, synchronous, zero LLM cost.
      const ancestralKeyword =
        (postmortem.symptom ? postmortem.symptom + " " : "") +
        relPath.replace(/[\/\\]/g, " ").replace(/\.[a-z]+$/, "");
      let ancestralBlock = "";
      try {
        const ancestral = await queryRelevantPostmortems({
          keyword: ancestralKeyword,
          excludeFilePath: relPath,
          repo: "self",
          limit: 5,
        });
        ancestralBlock = formatAncestralPromptBlock(ancestral);
      } catch {
        /* best-effort — ancestral RAG is an enhancement, not a gate */
      }

      // 3. LLM improvement — ask for REAL improvements, not cosmetic refactoring
      this.log(`Improving ${relPath}...`, "info");

      // 3-lessons. COMPOUNDING INTELLIGENCE — general lessons distilled
      // from aggregate history inject into EVERY enhance prompt (that's
      // the transfer: a lesson from pipeline failures shapes a UI
      // component mutation). The ids ride on the instance so runCycle
      // can feed the verdict back — see the wrapper after the enhanceFile
      // call in runCycle. Serial loop ⇒ instance field is safe.
      //
      // D2 two-track: PROMOTED procedures (active, lapsed 6+ times)
      // inject through a separate, unbounded Operating Constraints block
      // ABOVE the postmortem block — non-negotiable by position. The
      // bounded block carries the rest under a hard byte budget (D6).
      let operatingBlock = "";
      let lessonsBlock = "";
      this.lastLessonIds = [];
      try {
        const promoted: LessonRow[] = await getPromotedProcedures();
        const ls = await getLessonsForPrompt();
        const all = [...promoted, ...ls];
        if (all.length > 0) {
          this.lastLessonIds = all.map((x) => x.id);
          operatingBlock = formatOperatingConstraintsBlock(promoted);
          lessonsBlock = formatLessonsBlock(ls);
          await markInjected(this.lastLessonIds);
        }
      } catch {
        /* lessons are an amplifier, not a gate */
      }

      // 3-negatives. NEGATIVE CONSTRAINTS (RAS graft) — this file's
      // gate-rejected transforms from the mutation corpus, fed back as
      // do-not-reuse constraints EVERY cycle. The distiller sees the
      // aggregate shape once per DISTILL_INTERVAL; this block shows the
      // per-file exhausted space to the proposer itself. Directly saves
      // scarce LLM calls: a proposal the gates already rejected is a
      // wasted call in a 429-starved loop.
      let rejectedBlock = "";
      try {
        const rejected = await getRejectedTransformsForFile(relPath);
        rejectedBlock = formatRejectedTransformsBlock(rejected);
        if (rejectedBlock) {
          this.log(
            `Injecting ${rejected.length} rejected-transform constraint(s) for ${relPath} (corpus negative constraints)`,
            "info"
          );
        }
      } catch {
        /* amplifier, not a gate */
      }

      const refactorSystem = `You are a senior code reviewer improving a TypeScript file inside an autonomous self-improvement pipeline. Your changes will be typechecked and pushed to GitHub as the system's live state.

Your job: find and fix REAL issues. Do NOT make cosmetic changes (type annotations, magic numbers, syntax modernization). Those are pointless. Instead, look for:

1. BUGS: null/undefined crashes, missing error handling, unhandled edge cases, race conditions, off-by-one errors, resource leaks (unclosed handles)
2. ERROR HANDLING: bare try/catch that swallows errors, missing error context, unhelpful error messages. Add actionable error messages with context.
3. INPUT VALIDATION: functions that assume valid input and would crash or misbehave on bad input. Add guard clauses with clear errors.
4. PERFORMANCE: obvious inefficiencies — O(n²) where O(n) works, repeated computations in loops, unnecessary allocations, synchronous I/O that could be async.
5. SECURITY: injection risks, unsafe eval, hardcoded secrets, missing input sanitization.
6. DEAD CODE: unused imports, unreachable branches, commented-out code.

HARD RULES (violating any rule fails the pipeline):
- Preserve EVERY top-level exported symbol (function, class, interface, type, const). Do not rename or remove them.
- Do NOT add header comments, banners, or branding.
- Do NOT add unused interfaces or types.
- Do NOT change the public API signature of any export (parameter names, types, return type must stay the same).
- Keep changes focused — don't rewrite the whole file. Only fix real issues.
- If there are NO real issues to fix, output the original code unchanged.

OUTPUT FORMAT (mandatory):
- First, write a SHORT summary (1-5 bullet points) of what you changed and why. Start with "## Changes" on its own line.
- Then output the complete refactored code in a single fenced \`\`\`typescript block.
- Example:
## Changes
- Added null check in parseX() — could crash on undefined input
- Replaced bare catch with contextual error message in fetchY()
- Added input validation for limit parameter (negative values caused infinite loop)

\`\`\`typescript
// the full file with fixes applied
\`\`\`
${operatingBlock}${postmortem.hasActivePostmortem ? `\n${postmortem.promptBlock}\n` : ""}${rejectedBlock}${ancestralBlock}${lessonsBlock}`;

      const refactorUser = `File: ${relPath}\n\n\`\`\`typescript\n${originalCode}\n\`\`\`\n\nFind real bugs, error handling gaps, input validation issues, performance problems, security risks, or dead code in this file. Fix them. If nothing needs fixing, return the file unchanged. Output the summary first, then the code.`;

      const llmResult = await llmComplete({
        systemPrompt: refactorSystem,
        userPrompt: refactorUser,
        temperature: 0.2,
        onRetry: (info) => {
          const backoff = info.isRateLimit ? `${Math.round(info.delayMs / 1000)}s` : `${info.delayMs}ms`;
          this.log(`LLM retry attempt ${info.attempt}/${info.maxAttempts} (${info.isRateLimit ? "429" : "err"} — backing off ${backoff}) for enhance/${relPath}`, "info");
        },
      });

      result.llmLatencyMs = llmResult.latencyMs;

      if (!llmResult.ok) {
        // Fix A+B: the shared gate in agent-llm.ts handles 429 backoff. If
        // rateLimited is true, the call either returned instantly (gate was
        // already active) or just set the gate after 2 in-call retries. Either
        // way, DON'T do an additional per-file pause — the gate's cooldown is
        // the pause. Just defer and let the for-loop's gate check handle the
        // next file.
        if (llmResult.rateLimited) {
          const cd = llmCooldownMs();
          result.reason = `Deferred (LLM cooldown — ${Math.round(cd / 1000)}s)`;
          this.log(`Deferring enhance for ${relPath} — LLM on cooldown (${Math.round(cd / 1000)}s remaining)`, "warn");
        } else {
          // Non-rate-limit failure (network, parse, empty response).
          result.reason = `LLM unavailable: ${llmResult.error}`;
          this.log(`LLM unavailable for ${relPath}: ${llmResult.error}`, "warn");
        }
        return result;
      }

      // LLM succeeded — continue to verification

      // Extract the summary (what changed + why) AND the code from the response
      const { summary: changeSummary, code: refactoredCode } = extractSummaryAndCode(llmResult.content);
      // D4 (corpus): the transform signal — the first MEANINGFUL line of
      // the LLM's change summary (header skipped). Set BEFORE the gates so
      // rejected attempts carry them too (rejections are the corpus's main
      // signal).
      this.lastAttemptInfo.mutatedSha = refactoredCode ? sha16(refactoredCode) : null;
      this.lastAttemptInfo.transformSummary = firstMeaningfulLine(changeSummary);
      if (!refactoredCode || refactoredCode.trim().length === 0) {
        result.reason = "LLM returned no code";
        this.log(`LLM returned no code for ${relPath}`, "warn");
        return result;
      }

      // 3b. Mechanical guard: strip decorative banner comments the LLM
      // sometimes prepends to the code (defense-in-depth)
      const banner = this.stripBannerComments(refactoredCode);
      const cleanCode = banner.code;
      if (banner.stripped) {
        this.log(`Stripped decorative banner header from ${relPath} (LLM ignored the no-header rule)`, "warn");
      }

      result.llmUsed = true;
      result.newBytes = cleanCode.length;
      result.diffBytes = Math.abs(cleanCode.length - originalCode.length);

      // 3c. Detect truncated LLM output before the expensive typecheck.
      const truncation = this.checkTruncation(cleanCode, originalCode, filePath);
      if (truncation.truncated) {
        result.reason = `Rejected (LLM output truncated: ${truncation.reason})`;
        this.log(`Rejected ${relPath} (LLM output truncated: ${truncation.reason})`, "warn");
        await postmortemStore.recordFailure({
          repo: "self",
          branch: "main",
          filePath: relPath,
          failureType: "COMPILE_ERROR",
          symptom: `LLM output truncated: ${truncation.reason}`,
          evidence: `Original: ${originalCode.length}b, Refactored: ${cleanCode.length}b. The LLM hit its output token limit before finishing.`,
          constraints: `The previous refactor of ${relPath} was truncated by the LLM's output limit. Make smaller, more targeted changes — do not rewrite the whole file.`,
        });
        // NOTE (audit 2): totalReverted is counted ONCE, in runCycle, for any
        // result whose reason starts with "Rejected" — the per-site increment
        // here double-counted truncation, debate and test-gate rejections.
        return result;
      }

      // 4. Check if anything actually changed
      if (cleanCode.trim() === originalCode.trim()) {
        result.reason = "No issues found";
        this.log(`No change for ${relPath} (LLM found no real issues to fix)`, "info");
        return result;
      }

      // 4a. SATURATION CHECK — if the only changes are comments/whitespace, it's
      // cosmetic churn. Skip the expensive typecheck + debate + test gates.
      // EMG's saturation protocol: "if already optimal, output NO_CHANGES_NEEDED."
      if (this.isCosmeticChange(originalCode, cleanCode)) {
        result.reason = "Skipped (only cosmetic changes — comments/whitespace)";
        this.log(`Skipped ${relPath} (cosmetic-only change — no real improvement)`, "info");
        return result;
      }

      // 5. Verify the refactored code IN MEMORY — nothing is written to disk
      // until it passes typecheck. This prevents Turbopack from ever seeing
      // broken code (the root cause of the stale browser error).
      this.log(`Verifying ${relPath} (in-memory typecheck)...`, "info");
      const verification = this.verifyRefactor(filePath, cleanCode);
      result.compiled = verification.ok;

      if (!verification.ok) {
        // Refactor failed typecheck — do NOT write to disk. Turbopack never sees it.
        const errorSummary = verification.errors.slice(0, 3).join("; ");
        this.log(`Rejected ${relPath} (typecheck failed): ${errorSummary}`, "error");

        // Record postmortem so the next attempt gets warned
        await postmortemStore.recordFailure({
          repo: "self",
          branch: "main",
          filePath: relPath,
          failureType: "COMPILE_ERROR",
          symptom: `Refactored code failed in-memory typecheck: ${errorSummary}`,
          evidence: `Original: ${originalCode.length} bytes, Refactored: ${cleanCode.length} bytes. Errors: ${verification.errors.join("\n")}`,
          constraints: `The previous refactor of ${relPath} did not compile. Make smaller, safer changes. Preserve all type signatures exactly.`,
        });

        result.reason = "Rejected (typecheck failed — nothing written to disk)";
        return result;
      }

      // 5b. DEBATE GATE — a second LLM (Security + Architecture + Lead tribunal)
      // reviews the proposed refactor for semantic correctness. The typecheck
      // can't catch "added a null check that breaks the happy path." The debate
      // can. If REJECTED or REQUIRES_REWRITE, don't write.
      this.log(`Debating ${relPath} (second-LLM semantic review)...`, "info");
      const debate = await this.debateGate(filePath, originalCode, cleanCode, changeSummary);
      if (!debate.approved) {
        if (debate.deferred) {
          // Tribunal unavailable — fail-closed defer (see debateGate). Not a
          // rejection: no postmortem, no reverted count; reason starts with
          // "Deferred" so runCycle's deferred-counter tracks it.
          result.reason = `Deferred (debate tribunal unavailable — ${debate.reason.slice(0, 120)})`;
          this.log(`Deferring ${relPath} — debate tribunal unavailable, not auto-approving (fail-closed)`, "warn");
          return result;
        }
        this.log(`Rejected ${relPath} by debate: ${debate.reason}`, "warn");
        await postmortemStore.recordFailure({
          repo: "self",
          branch: "main",
          filePath: relPath,
          failureType: "REVIEW_REJECTED",
          symptom: `Debate rejected the refactor: ${debate.reason}`,
          evidence: `Change summary: ${changeSummary.slice(0, 500)}`,
          constraints: `The previous refactor of ${relPath} was rejected by the debate tribunal (${debate.verdict}). Address the review feedback before retrying.`,
        });
        result.reason = `Rejected by debate (${debate.verdict})`;
        return result;
      }
      this.log(`Debate approved ${relPath}: ${debate.reason}`, "success");

      // 5c. TEST GATE — run any test files that cover this source file.
      // This is THE real signal (Direction 4): tests prove behavior was preserved.
      // No tests exist yet, so this is a no-op gate — but the infrastructure is
      // ready. When tests are added, a refactor that breaks a test is rejected.
      const testResult = this.testGate(filePath, cleanCode);
      if (!testResult.passed) {
        this.log(`Rejected ${relPath} by test gate: ${testResult.reason}`, "warn");
        await postmortemStore.recordFailure({
          repo: "self",
          branch: "main",
          filePath: relPath,
          failureType: "OTHER",
          symptom: `Test gate failed: ${testResult.reason}`,
          evidence: `${testResult.testCount} test file(s) checked. The refactor broke existing behavior.`,
          constraints: `The previous refactor of ${relPath} broke existing tests. Do not change observable behavior.`,
        });
        result.reason = `Rejected by test gate: ${testResult.reason}`;
        // totalReverted counted once in runCycle ("Rejected" prefix) — the
        // inline increment double-counted (audit 2).
        return result;
      }
      if (testResult.testCount > 0) {
        this.log(`Test gate passed for ${relPath}: ${testResult.reason}`, "success");
      }

      // 6. Typecheck passed — NOW it's safe to write the improved code to the live file.
      // Turbopack will hot-reload it and see only valid code.
      // (If the test gate already wrote it, this is a no-op.)
      writeFileSync(filePath, cleanCode, "utf-8");

      // 9. Enhancement succeeded — the file is now LIVE (hot-reload will pick it up)
      result.enhanced = true;
      result.reason = changeSummary ? "Enhanced and live" : "Enhanced and live (no summary)";
      this.stats.totalEnhanced++;
      this.stats.lastEnhancementAt = new Date().toISOString();

      // Log the enhancement WITH the change summary so you can see WHAT was fixed
      const shortSummary = changeSummary
        ? changeSummary.split("\n").slice(0, 3).join(" | ").slice(0, 200)
        : "no summary provided";
      this.log(`Enhanced ${relPath} (${result.diffBytes}b diff): ${shortSummary}`, "success");

      // 10. Git commit + push (the proof) — include the change summary in the message
      const commitMessage = changeSummary
        ? `Self-enhancement: ${relPath}\n\n${changeSummary}\n\n(tsc verified, ${result.diffBytes}b diff)`
        : `Self-enhancement: ${relPath} (tsc verified, ${result.diffBytes}b diff)`;
      const pushResult = await this.gitPush(commitMessage);
      result.pushed = pushResult.pushed;
      result.commitSha = pushResult.commitSha;
      if (pushResult.pushed) {
        this.stats.totalPushed++;
        // Bump the per-cycle branch counter — this mutation now lives on
        // `loop-{thisN}` on the remote. The next enhanceFile will compute
        // `loop-{thisN+1}`. Failed attempts (this block not reached) leave
        // the counter untouched, so the next attempt reuses the same number.
        await setLastBranchNumber(thisN);
        this.log(`Mutation #${thisN} pinned to branch ${this.currentCycleBranch}`, "success");

        // ── HOT-SWAP (the point of "fully autonomous") ───────────────
        // The improved file is now on disk + GitHub. But the running
        // process is STILL using the OLD module from require.cache. A
        // self-improving system that has to be manually restarted to
        // benefit from its own improvements isn't autonomous. So: swap
        // the pipeline module subtree now, between cycles, so the next
        // cycle uses the new code. See core/hot-swap.ts.
        //
        // Fire-and-forget with a defensive catch: a swap failure must
        // NOT fail this enhancement (the commit + push already succeeded;
        // the swap is an optimization, not a gate). The hot-swap module
        // records its own postmortem on failure.
        if (relPath.startsWith("src/lib/pipeline/")) {
          try {
            const { hotSwapPipeline } = await import("../core/hot-swap");
            void hotSwapPipeline({
              reason: `post-enhancement swap: ${relPath}`,
            }).then((swapResult) => {
              if (swapResult.swapped) {
                this.log(
                  `HOT-SWAP: ${swapResult.pinsCleared.length} module(s) reloaded (${swapResult.durationMs}ms) — ` +
                  `next cycle uses the new code`,
                  "success"
                );
              } else if (!swapResult.pending) {
                // Not swapped and not pending (pending = will complete on
                // the next API request) — a real failure. Old code still
                // running; the broken code on disk is what needs fixing.
                this.log(
                  `HOT-SWAP FALLBACK: ${swapResult.reason} — old code still running, fix the broken code on disk`,
                  "error"
                );
              }
            });
          } catch (swapErr) {
            this.log(`HOT-SWAP skipped: ${(swapErr as Error).message.slice(0, 150)}`, "warn");
          }
        }
      }

      // 11. Resolve any postmortem for this file
      await postmortemStore.markResolved("self", "main", relPath);

      return result;
    } catch (err) {
      result.reason = `Error: ${(err as Error).message}`;
      this.log(`Error enhancing ${relPath}: ${(err as Error).message}`, "error");
      return result;
    } finally {
      // Whether the enhancement succeeded, failed at a gate, or threw: clear
      // the per-mutation branch. The next enhanceFile computes a fresh one
      // from the (possibly incremented) counter.
      this.currentCycleBranch = null;
    }
  }

  /**
   * Fix B: stoppable sleep until the shared LLM rate-limit gate opens. Polls
   * every 1s so stop() (which bumps runId) is noticed within 1s instead of
   * blocking for the full cooldown (up to 30min). Returns true if the gate
   * cleared, false if stop was requested during the wait.
   */
  private async waitForCooldown(myRun: number): Promise<boolean> {
    let lastProgressLog = Date.now();
    while (this.continuous && myRun === this.runId) {
      const ms = llmCooldownMs();
      if (ms <= 0) return true; // gate clear
      const chunk = Math.min(ms, 1000);
      await new Promise((r) => setTimeout(r, chunk));
      // Periodic progress log during long pauses (every 60s) so the
      // terminal doesn't look frozen during a 30-min cooldown. The UI
      // chip counts down every second; this keeps the log stream honest.
      if (Date.now() - lastProgressLog >= 60_000) {
        this.log(`LLM pause ongoing — ${Math.round(ms / 1000)}s remaining`, "warn");
        lastProgressLog = Date.now();
      }
    }
    return false; // stop requested
  }

  /**
   * ── SCHEMA MUTATION PATH ─────────────────────────────────────────
   * prisma/schema.prisma — the system's own memory substrate, mutated
   * under the strictest gate in the pipeline. The tsc/AST/debate chain
   * doesn't apply (not TypeScript); instead:
   *
   *   1. Postmortem check (same as files — the schema can carry scars)
   *   2. Lesson injection (same as files — compounding applies here too)
   *   3. LLM proposes an ADDITIVE change (new model or new defaulted
   *      field — the prompt states the contract)
   *   4. schema-gate: additive-only structural diff → prisma validate →
   *      db push → canary round-trip → auto-revert on any failure
   *   5. Debate gate on the semantic question (does this model make
   *      sense?) — AFTER the schema gate, so a bad structure never
   *      even reaches the tribunal
   *   6. Pass → commit + push like any other mutation
   *
   * The schema-gate's protected-model list (Postmortem, Lesson, etc.)
   * means the loop can GROW its memory but never EDIT or FORGET it.
   */
  private async enhanceSchema(filePath: string, myRun: number): Promise<SelfEnhanceResult> {
    const relPath = relative(PROJECT_ROOT, filePath);
    // Same branch contract as enhanceFile: this mutation targets
    // loop-{N+1}, bumped only on successful push.
    const lastN = await getLastBranchNumber();
    const thisN = lastN + 1;
    this.currentCycleBranch = formatLoopBranch(thisN);
    this.log(`Branch for this mutation: ${this.currentCycleBranch}`, "info");
    const result: SelfEnhanceResult = {
      filePath: relPath,
      enhanced: false,
      reason: "",
      oldBytes: 0,
      newBytes: 0,
      diffBytes: 0,
      llmUsed: false,
      llmLatencyMs: 0,
      compiled: false,
      pushed: false,
    };
    this.lastLessonIds = [];

    try {
      const original = readFileSync(filePath, "utf-8");
      result.oldBytes = original.length;
      // D4 (corpus): same provenance scratch as the file path.
      this.lastAttemptInfo = {
        originalSha: sha16(original),
        mutatedSha: null,
        transformSummary: null,
        branchNumber: thisN,
      };
      if (original.length > 12000) {
        result.reason = `Skipped (file too large: ${original.length}b)`;
        this.log(`Skipped ${relPath} (${original.length}b — too large for LLM)`, "info");
        return result;
      }

      // LLM gate check — same contract as the file path.
      const cd = llmCooldownMs();
      if (cd > 0) {
        result.reason = `Deferred (LLM cooldown — ${Math.round(cd / 1000)}s)`;
        this.log(`Deferring schema mutation — LLM on cooldown (${Math.round(cd / 1000)}s)`, "warn");
        return result;
      }

      // Postmortem constraints — the schema can fail too (a past
      // proposal that broke validate leaves a scar).
      const postmortem = await postmortemStore.getConstraintsForFile("self", "main", relPath);

      // Lessons — compounding applies to schema proposals as well.
      // D2 two-track, same as the file path: promoted procedures ride
      // the Operating Constraints block, the rest the bounded block.
      let operatingBlock = "";
      let lessonsBlock = "";
      try {
        const promoted: LessonRow[] = await getPromotedProcedures();
        const ls = await getLessonsForPrompt();
        const all = [...promoted, ...ls];
        if (all.length > 0) {
          this.lastLessonIds = all.map((x) => x.id);
          operatingBlock = formatOperatingConstraintsBlock(promoted);
          lessonsBlock = formatLessonsBlock(ls);
          await markInjected(this.lastLessonIds);
        }
      } catch {
        /* amplifier, not a gate */
      }

      // Negative constraints (RAS graft) — schema-rejected proposals
      // ride the same per-file block. Schema attempts are recorded in
      // the corpus with relPath "prisma/schema.prisma" (runCycle records
      // every enhanceFile result, and the schema path returns through
      // it), so rejected schema transforms accumulate here too.
      let rejectedBlock = "";
      try {
        const rejected = await getRejectedTransformsForFile(relPath);
        rejectedBlock = formatRejectedTransformsBlock(rejected);
        if (rejectedBlock) {
          this.log(
            `Injecting ${rejected.length} rejected-transform constraint(s) for schema (corpus negative constraints)`,
            "info"
          );
        }
      } catch {
        /* amplifier, not a gate */
      }

      this.log(`Proposing schema mutation for ${relPath}...`, "info");
      const system = `You are modifying the Prisma schema of a self-improving system — the schema IS the system's memory. This is the most dangerous file you can touch.

THE CONTRACT (the gate enforces this mechanically — violations are auto-reverted):
- ADDITIVE ONLY: you may ADD a whole new model block, or ADD new fields to an existing NON-PROTECTED model.
- New fields MUST be nullable (?) or carry @default() — existing rows must backfill.
- NEVER: remove a model, remove/rename a field, change a field type, touch the Postmortem/Lesson/GitPushTarget/LlmConfig/Prophecy/SystemFlag models, or edit the generator/datasource blocks.

A GOOD schema mutation:
- Adds a model the system's own pipeline would genuinely use (e.g. a new tracking table that some existing pipeline stage could read/write)
- Has a clear purpose stated in a /// doc comment on the model
- Uses sensible Prisma types + @default values

A BAD schema mutation:
- Renames or "cleans up" anything (destructive — instant revert)
- Adds a model nothing will ever read (dead weight)
- Duplicates an existing model's purpose

If there is NO genuinely useful additive change to make, output the original schema unchanged.

OUTPUT FORMAT:
First a SHORT summary starting with "## Changes", then the COMPLETE schema in a single \`\`\`prisma fenced block.
${operatingBlock}${postmortem.hasActivePostmortem ? `\n${postmortem.promptBlock}\n` : ""}${rejectedBlock}${lessonsBlock}`;

      const user = `Current prisma/schema.prisma:\n\n\`\`\`prisma\n${original}\n\`\`\`\n\nPropose an additive-only improvement, or return it unchanged if none is genuinely useful.`;

      const llmResult = await llmComplete({
        systemPrompt: system,
        userPrompt: user,
        temperature: 0.2,
        onRetry: (info) => {
          this.log(`LLM retry ${info.attempt}/${info.maxAttempts} (${info.isRateLimit ? "429" : "err"}) for schema mutation`, "info");
        },
      });
      result.llmLatencyMs = llmResult.latencyMs;

      if (!llmResult.ok) {
        if (llmResult.rateLimited) {
          const cd2 = llmCooldownMs();
          result.reason = `Deferred (LLM cooldown — ${Math.round(cd2 / 1000)}s)`;
          this.log(`Deferring schema mutation — LLM on cooldown`, "warn");
        } else {
          result.reason = `LLM unavailable: ${llmResult.error}`;
          this.log(`LLM unavailable for schema: ${llmResult.error}`, "warn");
        }
        return result;
      }

      if (myRun !== this.runId) {
        result.reason = "Stopped during schema proposal";
        return result;
      }

      const { summary: changeSummary, code: proposed } = extractSummaryAndCode(llmResult.content);
      // D4 (corpus): schema attempts carry the same transform signal.
      this.lastAttemptInfo.mutatedSha = proposed ? sha16(proposed) : null;
      this.lastAttemptInfo.transformSummary = firstMeaningfulLine(changeSummary);
      if (!proposed || proposed.trim().length === 0) {
        result.reason = "LLM returned no schema";
        return result;
      }
      if (proposed.trim() === original.trim()) {
        result.reason = "No issues found";
        this.log(`No schema change proposed (LLM found nothing worth adding)`, "info");
        return result;
      }
      result.llmUsed = true;
      result.newBytes = proposed.length;
      result.diffBytes = Math.abs(proposed.length - original.length);

      // ── THE SCHEMA GATE: additive check → validate → push → canary ──
      // Any failure auto-reverts the file AND re-pushes the original, so
      // the live DB and the file never desync.
      this.log(`Schema gate: checking additive-only diff...`, "info");
      const gate = applySchemaMutation(proposed);
      if (!gate.ok) {
        this.log(`Rejected schema mutation: ${gate.reason}`, "warn");
        await postmortemStore.recordFailure({
          repo: "self",
          branch: "main",
          filePath: relPath,
          failureType: "OTHER",
          symptom: `Schema gate rejected: ${gate.reason.slice(0, 160)}`,
          evidence: `Proposal ${proposed.length}b vs original ${original.length}b. ${gate.reason}`,
          constraints: `The previous schema proposal was rejected by the additive-only gate. Only NEW models or NEW defaulted/nullable fields on non-protected models are allowed. Never remove, rename, or retype anything.`,
        });
        result.reason = `Rejected by schema gate (${gate.reason.slice(0, 80)})`;
        return result;
      }
      result.compiled = true; // gate chain (validate+push+canary) passed
      this.log(`Schema gate PASSED: ${gate.reason}`, "success");

      // ── DEBATE: does this model actually make sense? ──
      const debate = await this.debateGate(filePath, original, proposed, changeSummary);
      if (!debate.approved) {
        if (debate.deferred) {
          // Revert the applied schema — a deferred tribunal is not an
          // approval, and the DB now carries a change nobody reviewed.
          const revert = applySchemaMutation(original);
          this.log(`Reverted schema (tribunal deferred): ${revert.ok ? "clean" : revert.reason}`, "warn");
          result.reason = `Deferred (debate tribunal unavailable)`;
          return result;
        }
        const revert = applySchemaMutation(original);
        this.log(`Rejected by debate, schema reverted (${revert.ok ? "clean" : revert.reason}): ${debate.reason}`, "warn");
        await postmortemStore.recordFailure({
          repo: "self",
          branch: "main",
          filePath: relPath,
          failureType: "REVIEW_REJECTED",
          symptom: `Debate rejected the schema change: ${debate.reason.slice(0, 160)}`,
          evidence: `Change summary: ${changeSummary.slice(0, 400)}`,
          constraints: `The previous schema change was rejected by the debate tribunal. Only propose models the pipeline genuinely needs.`,
        });
        result.reason = `Rejected by debate (${debate.verdict})`;
        return result;
      }

      // ── PASSED — the schema is live. Commit + push like any mutation. ──
      result.enhanced = true;
      result.reason = changeSummary ? "Enhanced and live" : "Enhanced and live (no summary)";
      this.stats.totalEnhanced++;
      this.stats.lastEnhancementAt = new Date().toISOString();
      const shortSummary = changeSummary
        ? changeSummary.split("\n").slice(0, 3).join(" | ").slice(0, 200)
        : "no summary provided";
      this.log(`Enhanced ${relPath} (${result.diffBytes}b diff): ${shortSummary}`, "success");

      const commitMessage = changeSummary
        ? `Self-enhancement: ${relPath}\n\n${changeSummary}\n\n(schema gate verified, ${result.diffBytes}b diff)`
        : `Self-enhancement: ${relPath} (schema gate verified, ${result.diffBytes}b diff)`;
      const pushResult = await this.gitPush(commitMessage);
      result.pushed = pushResult.pushed;
      result.commitSha = pushResult.commitSha;
      if (pushResult.pushed) {
        this.stats.totalPushed++;
        await setLastBranchNumber(thisN);
        this.log(`Schema mutation pinned to branch ${this.currentCycleBranch}`, "success");
      } else if (!pushResult.pushed) {
        this.log(`Schema push did not land (no changes or push declined) — schema file is still live, only the remote proof is missing`, "warn");
      }

      return result;
    } catch (e) {
      result.reason = `Error: ${(e as Error).message}`;
      this.log(`Schema mutation error: ${(e as Error).message}`, "error");
      return result;
    }
  }

  /**
   * Run one cycle: scan files, enhance each one sequentially.
   */
  async runCycle(): Promise<{ filesScanned: number; filesEnhanced: number; results: SelfEnhanceResult[] }> {
    if (this.running) {
      // Don't log — the continuous runner polls runCycle and this is normal
      return { filesScanned: 0, filesEnhanced: 0, results: [] };
    }
    this.running = true;
    this.currentFile = null;
    // Capture this cycle's generation. stop() increments runId; if it fires
    // mid-cycle, the for-loop below sees `myRun !== this.runId` and breaks.
    const myRun = this.runId;

    try {
      // ── Pause-before-scan (rate-limit gate) ──────────────────────────
      // If the shared LLM gate is active at cycle start, pause the WHOLE
      // cycle until it clears — do NOT scan and iterate files. Previously
      // the loop iterated all ~17 files during a cooldown: each file's
      // ratchet made a real LLM call that 429'd and RE-ESCALATED the gate
      // (2→5→15→30min) within a single cycle, then the per-file wait slept
      // the new cooldown, then the next file did it again. That churned
      // 4× 429s and 50+ min of waiting into one cycle. Now: one pause at
      // the top, then a fresh scan when the gate opens. Mid-cycle gate
      // escalations (a file's ratchet 429s) BREAK the for-loop so the next
      // cycle's start-pause handles the wait — one 429 per cooldown window.
      // Manual one-shot cycles skip this (continuous=false) and defer fast
      // at the enhanceFile checkpoint instead.
      if (this.continuous) {
        const cdAtStart = llmCooldownMs();
        if (cdAtStart > 0) {
          this.log(`LLM rate-limited — pausing cycle ${Math.round(cdAtStart / 1000)}s until cooldown clears (countdown in UI)`, "warn");
          const cleared = await this.waitForCooldown(myRun);
          if (!cleared) {
            this.log("Stop during cycle-start pause — cycle aborted", "warn");
            return { filesScanned: 0, filesEnhanced: 0, results: [] };
          }
          this.log("LLM cooldown cleared — starting cycle", "success");
        }
      }

      const files = this.scanFiles();
      // Cumulative scan count — increments every cycle so the counter visibly
      // moves (was `= files.length`, frozen at 16 forever, looked broken).
      this.stats.totalScanned += files.length;
      this.log(`Scanned ${files.length} files in src/lib/pipeline/`, "info");

      const results: SelfEnhanceResult[] = [];
      let enhanced = 0;
      let deferredThisCycle = 0;
      let lockedSkipped = 0;

      for (const file of files) {
        // Run-token check inside the for-loop. Token-ONLY (audit 2): the
        // old `!this.continuous ||` here broke the MANUAL trigger — a
        // one-shot cycle runs with continuous=false and used to break
        // before the first file, reporting "Cycle complete: 0 files".
        // stop() always bumps runId, so the token alone stops continuous
        // cycles within ~1 file while letting manual cycles run to
        // completion (or until an explicit stop).
        if (myRun !== this.runId) {
          this.log("Stop requested — breaking out of cycle", "warn");
          break;
        }
        const relPath = relative(PROJECT_ROOT, file);

        // ── Saturation lockout skip ──────────────────────────────────
        // A locked-out file is NOT mutated — no LLM call, no quota burn.
        // The user unlocked it (or restarted the server) to re-open it.
        // We count it so the cycle log shows "X/N (Y locked)" honestly.
        const sat = this.saturation.get(relPath);
        if (sat?.lockedOut) {
          lockedSkipped++;
          continue;
        }

        // Mid-cycle gate escalation: a previous file's ratchet 429'd and set
        // the gate. DON'T wait per-file then call enhanceFile (that re-escalated
        // 2→5→15→30min within one cycle — the churn). Instead BREAK the for-loop:
        // the cycle ends early (honest "X/N files"), runContinuous waits 5s,
        // and the NEXT cycle's start-of-cycle pause handles the cooldown.
        // Net: one 429 per cooldown window, not 17.
        // Manual one-shot cycles (continuous=false) skip this — they defer
        // fast at the enhanceFile checkpoint and return quickly.
        const cdBefore = llmCooldownMs();
        if (cdBefore > 0 && this.continuous) {
          this.log(`LLM cooldown escalated mid-cycle — ending cycle (will pause ${Math.round(cdBefore / 1000)}s before next cycle)`, "warn");
          break;
        }
        const result = await this.enhanceFile(file);
        results.push(result);
        if (result.enhanced) enhanced++;
        if (result.reason.startsWith("Rejected")) this.stats.totalReverted++;
        if (result.reason.startsWith("Deferred")) deferredThisCycle++;

        // ── COMPOUNDING FEEDBACK SUITE (D1/D4/D7/D8) ─────────────────
        // All best-effort: a feedback failure must never fail the cycle.
        // Only counts when the LLM actually produced a proposal (llmUsed)
        // — a deferred/unavailable call never saw the lessons in action.
        const hadRealProposal = result.llmUsed;
        const ids = hadRealProposal && this.lastLessonIds.length > 0 ? [...this.lastLessonIds] : [];
        this.lastLessonIds = [];
        const attemptInfo = { ...this.lastAttemptInfo };

        if (hadRealProposal) {
          // D8: the tuner's measurement window — attempts vs passes.
          noteAttemptOutcome(this.stats.cyclesCompleted + 1, true, result.enhanced);
        }

        // LESSON FEEDBACK (the measured half of compounding): pass →
          // helped, fail → hindered …
        if (ids.length > 0) {
          void recordLessonOutcome(ids, result.enhanced).catch(() => {
            /* feedback is best-effort */
          });
          // … and on a gate failure, D1 LAPSE DETECTION: did one of the
          // injected lessons COVER this exact failure? Then the LLM read
          // the rule and ignored it — the phrasing needs to get sharper,
          // and at 6+ lapses a procedure graduates to the Operating
          // Constraints block (D2 promotion).
          if (!result.enhanced && result.reason.startsWith("Rejected")) {
            void (async () => {
              try {
                const pm = await postmortemStore.getActivePostmortem("self", "main", relPath);
                if (pm) {
                  const lapse = await recordLessonLapse(ids, relPath, pm.failureType, pm.symptom);
                  if (lapse.lapsed > 0) {
                    this.log(
                      `LAPSE: ${lapse.lapsed} injected lesson(s) covered this failure and were ignored (${lapse.details.map((d) => `#${d.lapseCount}`).join(", ")}) — phrasing will sharpen; at 6+ a procedure promotes to Operating Constraints`,
                      "warn"
                    );
                  }
                  // D7 REFLEXION: one self-diagnosis call on repeat failures
                  // (attempts >= 2). Gate-checked inside; never steals quota.
                  const refl = await maybeReflectAfterFailure({
                    filePath: relPath,
                    failureType: pm.failureType,
                    symptom: pm.symptom,
                    constraints: pm.constraints,
                    attempts: pm.attempts,
                  });
                  if (refl.reflected) {
                    this.log(`REFLEXION: stored self-diagnosis for ${relPath} — it rides the next attempt's constraint block`, "info");
                  }
                }
              } catch {
                /* best-effort */
              }
            })();
          }
        }

        // D4 CORPUS: one row per attempt — the audit trail + the
        // distiller's transform signal. Deferred/unavailable attempts
        // are recorded too (they carry originalSha + outcome); only
        // llmUsed=false ones have no transformSummary.
        if (attemptInfo.originalSha) {
          void recordMutationAttempt({
            cycleNumber: this.stats.cyclesCompleted + 1,
            branchNumber: attemptInfo.branchNumber,
            filePath: relPath,
            gateOutcome: classifyGateOutcome(result.reason),
            originalSha: attemptInfo.originalSha,
            mutatedSha: attemptInfo.mutatedSha,
            lessonIdsInjected: ids,
            transformSummary: attemptInfo.transformSummary,
          }).catch(() => {
            /* corpus is an amplifier, not a gate */
          });
        }

        // ── Per-file saturation update ───────────────────────────────
        // Classify this cycle's outcome for THIS file and update its
        // saturation counter. Growth → reset. No-growth → increment,
        // and lock out at SATURATION_THRESHOLD. Neutral (quota/transient)
        // → don't touch the counter (don't punish a file for API limits).
        const growth = classifyGrowth(result.reason);
        const prev = this.saturation.get(relPath) ?? {
          consecutiveNoGrowth: 0,
          lockedOut: false,
          lockedAt: null,
          lastNoGrowthReason: null,
          enhancementsThisPass: 0,
        };
        if (growth === "growth") {
          prev.consecutiveNoGrowth = 0;
          prev.lastNoGrowthReason = null;
          prev.enhancementsThisPass++;
        } else if (growth === "no-growth") {
          prev.consecutiveNoGrowth++;
          prev.lastNoGrowthReason = result.reason;
          // D8: the lockout threshold is meta-tunable — read the live value.
          const threshold = await getSaturationThreshold();
          if (prev.consecutiveNoGrowth >= threshold && !prev.lockedOut) {
            prev.lockedOut = true;
            prev.lockedAt = new Date().toISOString();
            this.log(
              `🔒 ${relPath} LOCKED OUT — ${threshold} consecutive no-growth cycles (last: ${result.reason.slice(0, 80)})`,
              "warn"
            );
            this.log(
              `Pass will skip ${relPath} until you unlock it (UI button) or restart the server for a fresh pass`,
              "info"
            );
          }
        }
        this.saturation.set(relPath, prev);

        // Brief pause between files to avoid hammering the LLM API
        await new Promise((r) => setTimeout(r, 2000));
      }

      // ── Pass-complete detection ─────────────────────────────────────
      // When every eligible file is locked out, the pass is complete —
      // the system is stable. This is the checkpoint the user reviews.
      // The loop doesn't auto-stop (it'll keep cycling, but every file
      // will skip); the UI shows "PASS COMPLETE — review & unlock" so
      // the user knows the system has converged and it's their move.
      const eligibleCount = files.length;
      // Honest counting (fix): locked-among-THIS-scan, not the whole-map
      // count. The saturation map remembers files from earlier passes
      // (older TARGET_FILES allowlists, since-removed display files) —
      // stale entries could fire "PASS COMPLETE" while current files
      // are still eligible (overcount bug).
      const lockedCount = files.filter(
        (f) => this.saturation.get(relative(PROJECT_ROOT, f))?.lockedOut
      ).length;
      if (eligibleCount > 0 && lockedCount >= eligibleCount) {
        this.log(
          `🎯 PASS COMPLETE — all ${eligibleCount} file(s) locked out. Review & unlock in the UI to start a new pass.`,
          "success"
        );
      }

      // Track consecutive cycles that made NO progress (zero enhanced, at
      // least one defer) due to the gate. After 3, log a loud "quota
      // exhausted" message once. With the break-on-escalation behavior, a
      // blocked cycle defers just 1 file (the probe that 429'd) then breaks
      // — so we key on "enhanced===0 && deferredThisCycle>0" rather than
      // "all files deferred" (which never happens now). The loop does NOT
      // auto-stop; the start-of-cycle pause keeps it alive until the gate
      // clears, and the UI shows the live countdown.
      if (files.length > 0 && enhanced === 0 && deferredThisCycle > 0) {
        this.consecutiveCooldownCycles++;
        if (this.consecutiveCooldownCycles >= 3 && !this.quotaExhaustedLogged) {
          this.log("LLM quota exhausted — loop paused until cooldown clears (countdown in UI)", "error");
          this.quotaExhaustedLogged = true;
        } else {
          this.log(`Cycle blocked on LLM gate (${this.consecutiveCooldownCycles} consecutive) — pausing ${Math.round(llmCooldownMs() / 1000)}s`, "warn");
        }
      } else {
        // At least one file enhanced (or no defers) — reset the counter
        // and the "quota exhausted" flag so it can fire again next outage.
        this.consecutiveCooldownCycles = 0;
        this.quotaExhaustedLogged = false;
      }

      this.stats.cyclesCompleted++;
      this.currentFile = null;
      // Same honest counting: locked-among-scanned, not whole-map.
      const lockedNow = files.filter(
        (f) => this.saturation.get(relative(PROJECT_ROOT, f))?.lockedOut
      ).length;
      this.log(
        `Cycle complete: ${enhanced}/${files.length} enhanced${lockedSkipped > 0 ? `, ${lockedSkipped} locked` : ""}${lockedNow >= files.length && files.length > 0 ? " — PASS COMPLETE" : ""}`,
        "success"
      );

      // ── LESSON DISTILLATION (the compounding half) ────────────
      // Every DISTILL_INTERVAL cycles (meta-tunable, D8): one LLM pass
      // over the aggregate failure history extracts general lessons.
      // Fire-and-forget — a distillation failure must never fail the
      // cycle. Skips itself when the LLM gate is closed (mutations own
      // the quota first). D6: each pass also mirrors the lesson table
      // to memory/lessons.md (inside distillLessons).
      const cycleNow = this.stats.cyclesCompleted;
      void maybeDistill(cycleNow)
        .then((added) => {
          if (added > 0) {
            this.log(`🧠 Distilled ${added} new lesson(s) from aggregate history (cycle ${cycleNow})`, "success");
          }
        })
        .catch(() => {
          /* distillation is best-effort */
        });

      // ── D8 META-TUNER (the L4 rung) ──────────────────────────────
      // Judge any in-flight trial (accept / roll back / early-abort)
      // or, on a proposal cycle, start one. Never steals LLM quota (a
      // trial START is deferred when the gate is closed, inside).
      void maybeMetaTune(cycleNow)
        .then((t) => {
          if (t.action === "proposed" || t.action === "accepted" || t.action === "rolled-back" || t.action === "aborted") {
            this.log(t.detail, t.action === "accepted" ? "success" : "info");
          }
        })
        .catch(() => {
          /* tuning is best-effort */
        });

      // ── D5 INTEGRITY CHECKS ──────────────────────────────────────
      // Gate-integrity probes (deterministic, every PROBE_INTERVAL
      // cycles): known-bad and known-good proposals against the REAL
      // gate code. Any failure raises safe-mode — the loop halts until
      // the operator clears it.
      if (cycleNow % PROBE_INTERVAL === 0) {
        try {
          const probes = runGateIntegrityProbes();
          if (probes.halted) {
            this.log(
              `🚨 GATE INTEGRITY FAILURE: ${probes.passed}/${probes.total} probes passed — SAFE-MODE raised, loop halted until the operator clears it`,
              "error"
            );
          } else if (cycleNow % (PROBE_INTERVAL * 10) === 0) {
            this.log(`Gate integrity: ${probes.passed}/${probes.total} probes passed`, "info");
          }
        } catch {
          /* probes are best-effort but loud on failure */
        }
      }
      // Test-attacker round (every ATTACKER_INTERVAL cycles, LLM,
      // gate-checked inside — mutations own the quota first): tries to
      // break the ratchet's own pins. Findings land as CANDIDATE
      // postmortems on the test file (watch list, never injected).
      if (cycleNow % ATTACKER_INTERVAL === 0) {
        void runTestAttacker()
          .then((round) => {
            if (round.findings.length > 0) {
              this.log(
                `🔴 TEST-ATTACKER: ${round.findings.length} weak pin(s) found — ${round.findings.map((f) => `${f.testPath} (${f.kind})`).join("; ")}`,
                "warn"
              );
            } else if (round.ran) {
              this.log(`TEST-ATTACKER: ${round.attacked} pin(s) examined — pins held`, "info");
            }
          })
          .catch(() => {
            /* best-effort */
          });
      }

      // ── D3 DREAMER (idle-time consolidation) ────────────────────
      // One cheap advisory task per idle moment. Self-skips when the
      // gate is closed (mutations own the quota); fires here (end of
      // cycle, before the 5s inter-cycle gap) so an open gate gets used.
      if (llmCooldownMs() === 0) {
        void maybeDream()
          .then((line) => {
            if (line) this.log(line, "info");
          })
          .catch(() => {
            /* dreams are best-effort */
          });
      }

      // Oracle auto-prophecy (fire-and-forget): the cycle is done, the
      // system has a fresh view of its own history — let it predict its
      // next turn. All guards (LLM gate, pending cap) live inside
      // oracle-auto.ts; this call never blocks or throws. Surfaces in
      // the console stream via the oracle event ring.
      autoProphecyAfterCycle();

      return { filesScanned: files.length, filesEnhanced: enhanced, results };
    } finally {
      this.running = false;
    }
  }

  /**
   * Run continuously: cycle after cycle until stopped.
   */
  async runContinuous(onUpdate?: () => void): Promise<void> {
    this.continuous = true;
    // Seed the lesson store once per process — the compounding loop's
    // starting capital, from knowledge the system's own history already
    // proved. Idempotent (skips if a seed row exists); fire-and-forget.
    void seedLessons().catch(() => {
      /* table missing until first restart post-migration — dormant */
    });
    // D8: seed the meta-param table once per process (idempotent). Also
    // reverts any row left in "trial" provenance — a restart orphaned an
    // in-flight A/B trial, and an unfinished trial never survives to be
    // mistaken for an accepted tuning.
    void seedMetaParams().catch(() => {
      /* table missing until first restart post-migration — dormant */
    });
    // Capture this loop's generation (audit 2): runCycle checks its own
    // token, but the OUTER while-loop only checked `this.continuous` — so a
    // stop-then-start during a cycle left TWO loops alive (the old one saw
    // continuous=true again after the new start and kept cycling forever,
    // interleaving with the new loop's cycles). With a token captured here,
    // a stale loop exits for good once its current runCycle returns.
    const myRun = this.runId;
    this.log("Starting continuous self-enhancement loop", "success");
    while (this.continuous && myRun === this.runId) {
      await this.runCycle();
      if (onUpdate) onUpdate();
      if (!(this.continuous && myRun === this.runId)) break;
      // D3: the inter-cycle gap is the other idle moment — one dream
      // task if the gate happens to be open (it self-skips when closed).
      if (llmCooldownMs() === 0) {
        void maybeDream()
          .then((line) => {
            if (line) this.log(line, "info");
          })
          .catch(() => {
            /* dreams are best-effort */
          });
      }
      // Wait between cycles
      this.log("Waiting 5s before next cycle...", "info");
      await new Promise((r) => setTimeout(r, 5000));
    }
    this.log("Continuous self-enhancement loop exited", "info");
  }

  stop() {
    // Bump the run token so any in-flight runCycle / enhanceFile sees a
    // generation change at its next checkpoint and bails. We deliberately
    // do NOT touch `this.running` here — that flag is owned by runCycle's
    // `finally` block and represents "a cycle is currently executing".
    // Setting it false here would (a) not break the for-loop in runCycle
    // (it doesn't check `running`), and (b) defeat the re-entry guard at
    // the top of runCycle, letting a new start spawn a second concurrent
    // cycle sharing currentCycleBranch / currentFile.
    this.continuous = false;
    this.runId++;
    this.log("Self-enhance loop stop requested", "warn");
  }

  isRunning(): boolean {
    return this.running;
  }

  /** True when the continuous loop is active (between cycles OR mid-cycle).
   *  Distinct from isRunning() which is only true mid-cycle. */
  isContinuous(): boolean {
    return this.continuous;
  }

  getStats() {
    return { ...this.stats };
  }

  /** Snapshot of per-file saturation state for the status API + UI.
   *  Returns a plain object (not a Map) so it JSON-serializes cleanly. */
  getSaturation(): SaturationMap {
    const out: SaturationMap = {};
    for (const [path, state] of this.saturation) {
      out[path] = { ...state };
    }
    return out;
  }

  /** Unlock a locked-out file so it's eligible for the next cycle. Called
   *  by the UI when the user clicks "unlock". Resets the no-growth counter
   *  and the enhancements-this-pass counter — a fresh start. The file is
   *  re-evaluated on the next cycle (its content may have changed since
   *  lockout, so the LLM might find new improvements or might re-lock
   *  immediately if nothing's changed in the underlying code). */
  unlockFile(relPath: string): { unlocked: boolean; reason?: string } {
    const state = this.saturation.get(relPath);
    if (!state || !state.lockedOut) {
      return { unlocked: false, reason: "not locked" };
    }
    state.lockedOut = false;
    state.lockedAt = null;
    state.consecutiveNoGrowth = 0;
    state.lastNoGrowthReason = null;
    state.enhancementsThisPass = 0;
    this.log(`🔓 ${relPath} unlocked — eligible for next cycle`, "success");
    return { unlocked: true };
  }

  getLogs() {
    return [...this.logs];
  }

  getCurrentFile() {
    return this.currentFile;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // On-demand task engine (restored from the Original-branch lineage).
  // These run alongside the continuous whole-file loop: the loop refactors
  // module-by-module through the full gate chain, while the task engine
  // lets the USER drive targeted fixes (Direction 1: the user is the
  // feedback signal). Ported from d326ba6.
  // ─────────────────────────────────────────────────────────────────────────

  /** Update a task row; a missing row is non-fatal (it may have been
   *  deleted by the user from the tasks panel). */
  private async updateTask(
    id: string,
    patch: {
      status?: string;
      lastError?: string | null;
      fixSummary?: string;
      commitSha?: string;
      deferred?: number;
    }
  ) {
    await db.selfTask.update({ where: { id }, data: patch }).catch(() => {
      /* task row may be gone — non-fatal */
    });
  }

  /** Manual rescan: regenerate the task queue from code findings. */
  async rescan() {
    const scan = await generateTasks();
    this.stats.tasksGenerated += scan.newTasks;
    this.log(
      `Manual rescan: ${scan.filesAnalyzed} files, ${scan.findings} findings, ${scan.newTasks} new tasks`,
      scan.newTasks > 0 ? "success" : "info"
    );
    return scan;
  }

  /** User veto on system-defined input: skip the next pending task. */
  async skipNext(): Promise<{ skipped: boolean; kind?: string; filePath?: string; line?: number }> {
    const next = await db.selfTask.findFirst({
      where: { status: "pending" },
      orderBy: [{ priority: "asc" }, { deferred: "asc" }, { createdAt: "asc" }],
    });
    if (!next) return { skipped: false };
    await this.updateTask(next.id, { status: "skipped", lastError: "user veto" });
    this.log(`User veto: skipped [${next.kind}] ${next.filePath}:${next.line}`, "warn");
    return { skipped: true, kind: next.kind, filePath: next.filePath, line: next.line };
  }
}

// Singleton
const globalForSelfEnhance = globalThis as unknown as {
  __selfEnhanceLoop?: SelfEnhanceLoop;
};

export const selfEnhanceLoop: SelfEnhanceLoop =
  globalForSelfEnhance.__selfEnhanceLoop ?? new SelfEnhanceLoop();

if (!globalForSelfEnhance.__selfEnhanceLoop) {
  globalForSelfEnhance.__selfEnhanceLoop = selfEnhanceLoop;
}
