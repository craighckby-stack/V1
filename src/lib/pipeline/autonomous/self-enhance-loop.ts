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
import { llmComplete, extractSummaryAndCode } from "../llm/agent-llm";
import { conductLlmDebate } from "../llm/debate-llm";
import { postmortemStore } from "../postmortem/postmortem-store";
import { pushCurrentState, getLastBranchNumber, setLastBranchNumber, formatLoopBranch } from "./push-target";
import { db } from "@/lib/db";
import { generateTasks } from "./self-task-generator";

const PIPELINE_SRC_DIR = "/home/z/my-project/src/lib/pipeline";
const DISPLAY_SRC_DIR = "/home/z/my-project/src/app/display";
const PROJECT_ROOT = "/home/z/my-project";

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
  const base = basename(sourceFilePath, ".ts");
  const testFiles: string[] = [];

  // 1. Co-located test file: foo.ts -> foo.test.ts
  const coLocated = join(dir, `${base}.test.ts`);
  if (existsSync(coLocated)) testFiles.push(coLocated);

  // 2. Scan the directory for .test.ts files that import the source file
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
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
const TEST_WRITER_SYSTEM = `You are a test engineer writing characterization tests for a TypeScript module inside an autonomous self-improvement pipeline. The tests you write become a PERMANENT behavioral contract: future refactors of this module will be REJECTED if they break your tests.

Your job: write bun:test tests that PIN the module's CURRENT observable behavior.

Rules:
- Import { describe, test, expect } from "bun:test"
- Import the module under test using a relative path (e.g. from "./moduleName")
- Test the EXPORTED functions/classes with realistic inputs, including edge cases (empty strings, boundary numbers, null/undefined only where the signature allows them)
- Assert CONCRETE expected values derived from reading the implementation — compute the expected output yourself from the logic, do not call the function to obtain it
- NO tautological tests: never expect(f(x)).toBe(f(x)), never expect(x).toBe(x), never assertions that always pass
- Do NOT re-implement the module's logic inside the test to compute the expected value
- If an export's behavior depends on external state (DB, network, filesystem, env), test only the pure logic; skip integration-heavy paths
- Write 3-8 focused tests inside one describe block
- Do not test implementation details that refactoring may legitimately change; test observable outputs

OUTPUT FORMAT (mandatory):
- First, a SHORT summary starting with "## Changes" listing which behaviors you pinned.
- Then the complete test file in a single fenced \`\`\`typescript block.`;

// Files the system should NOT modify (would break the loop itself).
// Exported so the /api/self-enhance/files route can report the REAL
// protected set (single source of truth — no duplicated lists to drift).
export const PROTECTED_FILES = new Set([
  "src/lib/pipeline/autonomous/loop-runtime.ts",
  "src/lib/pipeline/autonomous/self-enhance-loop.ts",
  "src/lib/pipeline/autonomous/loop-event-bus.ts",
  "src/lib/pipeline/autonomous/push-target.ts", // protect the push auth path
  "src/lib/pipeline/autonomous/in-memory-typecheck.ts", // protect the typecheck
  "src/lib/pipeline/autonomous/verify-refactor.ts", // protect the verifier
  "src/lib/pipeline/llm/agent-llm.ts", // protect the LLM wrapper
  "src/lib/pipeline/llm/debate-llm.ts",
  // UI control surface — the loop can change HOW things look (the mutable
  // display layer in src/app/display/) but can NEVER touch the control
  // surface: the buttons, the command input, the command parser, the state
  // management, the polling. If the system could rewrite its own control
  // surface, it could remove the STOP button and escape user oversight.
  "src/app/page.tsx", // the control surface itself
  "src/app/layout.tsx", // page metadata / shell
]);

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
  // Circuit breaker: track consecutive 429s to back off the whole cycle
  private consecutiveRateLimits = 0;
  // Ratchet: per-file test-writing attempt tracking. After 2 failed attempts
  // (bad tests, untestable module, LLM trouble), stop retrying — but forget
  // failures older than 30 minutes, so an intermittent 429 window doesn't
  // permanently skip a module for the rest of the server's life.
  private testWriteAttempts = new Map<string, { attempts: number; at: number }>();
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
   * Scan for files to enhance. Two scopes:
   *   1. src/lib/pipeline/ — the system's own logic (.ts only)
   *   2. src/app/display/ — the mutable UI display layer (.tsx — colors,
   *      layout, formatting, visualizations). The control surface
   *      (page.tsx, layout.tsx) is PROTECTED and never scanned.
   */
  private scanFiles(): string[] {
    const files: string[] = [];
    const scan = (dir: string, extensions: string[]) => {
      let entries: import("fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // directory doesn't exist yet (e.g. display/ on first boot)
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
            if (!PROTECTED_FILES.has(relPath)) {
              files.push(fullPath);
            }
          }
        }
      }
    };
    scan(PIPELINE_SRC_DIR, [".ts"]);
    scan(DISPLAY_SRC_DIR, [".tsx"]);
    return files;
  }

  /**
   * Detect truncated LLM output. The LLM often hits its output token limit
   * mid-comment on larger files, producing code with:
   *   - Unbalanced braces (more opens than closes)
   *   - Unterminated block comments (odd count of block-comment delimiters)
   *   - Missing closing code fence at the end
   * Catching this early avoids a ~10s wasted typecheck cycle.
   */
  private detectTruncation(code: string, original: string): { truncated: boolean; reason?: string } {
    // 1. Unbalanced braces — count { and } (ignoring strings/comments is hard;
    //    a rough count is enough to catch truncation since the original was balanced)
    let opens = 0, closes = 0;
    for (let i = 0; i < code.length; i++) {
      if (code[i] === "{") opens++;
      else if (code[i] === "}") closes++;
    }
    if (opens !== closes) {
      return {
        truncated: true,
        reason: `unbalanced braces (${opens} { vs ${closes} })`,
      };
    }

    // 2. Unterminated block comment — odd number of /* */ pairs
    const blockCommentOpens = (code.match(/\/\*/g) || []).length;
    const blockCommentCloses = (code.match(/\*\//g) || []).length;
    if (blockCommentOpens !== blockCommentCloses) {
      return {
        truncated: true,
        reason: `unterminated block comment (${blockCommentOpens} /* vs ${blockCommentCloses} */)`,
      };
    }

    // 3. Refactored code is significantly shorter than original + missing closing
    //    characters — likely cut off mid-generation
    if (code.length < original.length * 0.5 && !code.endsWith("}") && !code.endsWith(";")) {
      return {
        truncated: true,
        reason: `output too short (${code.length}b vs ${original.length}b original) and not properly terminated`,
      };
    }

    return { truncated: false };
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
  ): Promise<{ approved: boolean; reason: string; verdict?: string }> {
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
      // Debate unavailable — don't block the loop, the first gate passed
      return { approved: true, reason: `Debate unavailable (skipped): ${(err as Error).message.slice(0, 100)}` };
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
    // Strip // comments, /* */ comments, and all whitespace, then compare
    const strip = (s: string) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
        .replace(/\/\/[^\n]*/g, "") // line comments
        .replace(/\s+/g, ""); // all whitespace
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
    const base = basename(filePath, ".ts");
    const testPath = join(dirname(filePath), `${base}.test.ts`);

    if (existsSync(testPath)) return false; // already pinned
    const now = Date.now();
    const rec = this.testWriteAttempts.get(relPath);
    // Decay: forget failures older than 30 minutes — intermittent 429 windows
    // shouldn't permanently skip a module
    if (rec && now - rec.at > 30 * 60 * 1000) {
      this.testWriteAttempts.delete(relPath);
    } else if (rec && rec.attempts >= 2) {
      return false; // known-failed recently — don't burn LLM budget retrying
    }
    this.testWriteAttempts.set(relPath, { attempts: (rec?.attempts ?? 0) + 1, at: now });

    try {
      const source = readFileSync(filePath, "utf-8");
      if (source.length > 12000) return false; // too large for the LLM prompt

      this.log(`Ratchet: writing characterization tests for ${relPath} (attempt ${(rec?.attempts ?? 0) + 1})...`, "info");

      const userPrompt = `Module to pin: ${relPath}\n\n\`\`\`typescript\n${source}\n\`\`\`\n\nWrite ${base}.test.ts — a bun:test characterization suite pinning this module's current observable behavior. Import the module from "./${base}". Compute expected values yourself from the implementation. Output the summary first, then the test file.`;

      const llmResult = await llmComplete({
        systemPrompt: TEST_WRITER_SYSTEM,
        userPrompt,
        temperature: 0.2,
        onRetry: (info) => {
          const backoff = info.isRateLimit ? `${Math.round(info.delayMs / 1000)}s` : `${info.delayMs}ms`;
          this.log(`LLM retry attempt ${info.attempt}/${info.maxAttempts} (429 — backing off ${backoff}) for ratchet/${relPath}`, "info");
        },
      });
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
      const truncation = this.detectTruncation(code, "");
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
        this.log(`Ratchet: rejected test for ${relPath} by debate: ${debate.reason.slice(0, 150)}`, "warn");
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

      // 2. Check for postmortem constraints
      const postmortem = await postmortemStore.getConstraintsForFile(
        "self",
        "main",
        relPath
      );

      // 3. LLM improvement — ask for REAL improvements, not cosmetic refactoring
      this.log(`Improving ${relPath}...`, "info");
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
${postmortem.hasActivePostmortem ? `\n${postmortem.promptBlock}\n` : ""}`;

      const refactorUser = `File: ${relPath}\n\n\`\`\`typescript\n${originalCode}\n\`\`\`\n\nFind real bugs, error handling gaps, input validation issues, performance problems, security risks, or dead code in this file. Fix them. If nothing needs fixing, return the file unchanged. Output the summary first, then the code.`;

      const llmResult = await llmComplete({
        systemPrompt: refactorSystem,
        userPrompt: refactorUser,
        temperature: 0.2,
        onRetry: (info) => {
          const backoff = info.isRateLimit ? `${Math.round(info.delayMs / 1000)}s` : `${info.delayMs}ms`;
          this.log(`LLM retry attempt ${info.attempt}/${info.maxAttempts} (429 — backing off ${backoff}) for enhance/${relPath}`, "info");
        },
      });

      result.llmLatencyMs = llmResult.latencyMs;

      if (!llmResult.ok) {
        const isRateLimit = /429|Too many requests|rate limit/i.test(llmResult.error ?? "");
        if (isRateLimit) {
          // Circuit breaker: track consecutive 429s and back off the whole cycle
          this.consecutiveRateLimits++;
          const backoffMs = Math.min(60000, 15000 * this.consecutiveRateLimits);
          result.reason = `LLM rate-limited (429) — pausing ${backoffMs / 1000}s`;
          this.log(
            `LLM rate-limited (429) for ${relPath} — pausing ${backoffMs / 1000}s (consecutive #${this.consecutiveRateLimits})`,
            "warn"
          );
          // Pause before returning so the next file doesn't immediately hit the API
          await new Promise((r) => setTimeout(r, backoffMs));
        } else {
          this.consecutiveRateLimits = 0;
          result.reason = `LLM unavailable: ${llmResult.error}`;
          this.log(`LLM unavailable for ${relPath}: ${llmResult.error}`, "warn");
        }
        return result;
      }

      // LLM succeeded — reset the circuit breaker
      this.consecutiveRateLimits = 0;

      // Extract the summary (what changed + why) AND the code from the response
      const { summary: changeSummary, code: refactoredCode } = extractSummaryAndCode(llmResult.content);
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
      const truncation = this.detectTruncation(cleanCode, originalCode);
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
        this.stats.totalReverted++;
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
        this.stats.totalReverted++;
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
        this.stats.totalReverted++;
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
   * Run one cycle: scan files, enhance each one sequentially.
   */
  async runCycle(): Promise<{ filesScanned: number; filesEnhanced: number; results: SelfEnhanceResult[] }> {
    if (this.running) {
      // Don't log — the continuous runner polls runCycle and this is normal
      return { filesScanned: 0, filesEnhanced: 0, results: [] };
    }
    this.running = true;
    this.currentFile = null;

    try {
      const files = this.scanFiles();
      // Cumulative scan count — increments every cycle so the counter visibly
      // moves (was `= files.length`, frozen at 16 forever, looked broken).
      this.stats.totalScanned += files.length;
      this.log(`Scanned ${files.length} files in src/lib/pipeline/`, "info");

      const results: SelfEnhanceResult[] = [];
      let enhanced = 0;

      for (const file of files) {
        const result = await this.enhanceFile(file);
        results.push(result);
        if (result.enhanced) enhanced++;
        if (result.reason.startsWith("Rejected")) this.stats.totalReverted++;

        // Brief pause between files to avoid hammering the LLM API
        await new Promise((r) => setTimeout(r, 2000));
      }

      this.stats.cyclesCompleted++;
      this.currentFile = null;
      this.log(`Cycle complete: ${enhanced}/${files.length} files enhanced`, "success");
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
    this.log("Starting continuous self-enhancement loop", "success");
    while (this.continuous) {
      await this.runCycle();
      if (onUpdate) onUpdate();
      if (!this.continuous) break;
      // Wait between cycles
      this.log("Waiting 5s before next cycle...", "info");
      await new Promise((r) => setTimeout(r, 5000));
    }
    this.log("Continuous self-enhancement loop exited", "info");
  }

  stop() {
    this.running = false;
    this.continuous = false;
    this.log("Self-enhance loop stopped", "warn");
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
