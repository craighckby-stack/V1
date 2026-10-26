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

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { join, relative } from "path";
import { llmComplete, extractSummaryAndCode } from "../llm/agent-llm";
import { postmortemStore } from "../postmortem/postmortem-store";
import { pushCurrentState } from "./push-target";

const PIPELINE_SRC_DIR = "/home/z/my-project/src/lib/pipeline";
const PROJECT_ROOT = "/home/z/my-project";

// Files the system should NOT modify (would break the loop itself)
const PROTECTED_FILES = new Set([
  "src/lib/pipeline/autonomous/loop-runtime.ts",
  "src/lib/pipeline/autonomous/self-enhance-loop.ts",
  "src/lib/pipeline/autonomous/loop-event-bus.ts",
  "src/lib/pipeline/autonomous/push-target.ts", // protect the push auth path
  "src/lib/pipeline/autonomous/in-memory-typecheck.ts", // protect the typecheck
  "src/lib/pipeline/autonomous/verify-refactor.ts", // protect the verifier
  "src/lib/pipeline/llm/agent-llm.ts", // protect the LLM wrapper
  "src/lib/pipeline/llm/debate-llm.ts",
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
  // Circuit breaker: track consecutive 429s to back off the whole cycle
  private consecutiveRateLimits = 0;
  private stats = {
    totalScanned: 0,
    totalEnhanced: 0,
    totalReverted: 0,
    totalPushed: 0,
    cyclesCompleted: 0,
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
   * Scan the pipeline source directory for .ts files to enhance.
   */
  private scanFiles(): string[] {
    const files: string[] = [];
    const scan = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const relPath = relative(PROJECT_ROOT, fullPath);
          if (!PROTECTED_FILES.has(relPath)) {
            files.push(fullPath);
          }
        }
      }
    };
    scan(PIPELINE_SRC_DIR);
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
      const outcome = await pushCurrentState({ message });
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
   * Enhance a single file: LLM refactor → verify tsc → write live → git push.
   */
  async enhanceFile(filePath: string): Promise<SelfEnhanceResult> {
    const relPath = relative(PROJECT_ROOT, filePath);
    this.currentFile = relPath;
    const startTime = Date.now();

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

      // 6. Typecheck passed — NOW it's safe to write the improved code to the live file.
      // Turbopack will hot-reload it and see only valid code.
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
      }

      // 11. Resolve any postmortem for this file
      await postmortemStore.markResolved("self", "main", relPath);

      return result;
    } catch (err) {
      result.reason = `Error: ${(err as Error).message}`;
      this.log(`Error enhancing ${relPath}: ${(err as Error).message}`, "error");
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

    try {
      const files = this.scanFiles();
      // Report unique files seen, not a cumulative count per cycle
      this.stats.totalScanned = files.length;
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

  getStats() {
    return { ...this.stats };
  }

  getLogs() {
    return [...this.logs];
  }

  getCurrentFile() {
    return this.currentFile;
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
