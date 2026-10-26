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

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, relative } from "path";
import { llmComplete, extractCodeBlock } from "../llm/agent-llm";
import { postmortemStore } from "../postmortem/postmortem-store";

const PIPELINE_SRC_DIR = "/home/z/my-project/src/lib/pipeline";
const PROJECT_ROOT = "/home/z/my-project";

// Files the system should NOT modify (would break the loop itself)
const PROTECTED_FILES = new Set([
  "src/lib/pipeline/autonomous/loop-runtime.ts",
  "src/lib/pipeline/autonomous/self-enhance-loop.ts",
  "src/lib/pipeline/autonomous/loop-event-bus.ts",
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
   * Verify the project compiles with tsc --noEmit.
   * Returns true if compilation succeeds, false otherwise.
   */
  private verifyCompiles(): boolean {
    try {
      execSync("npx tsc --noEmit 2>&1", {
        cwd: PROJECT_ROOT,
        timeout: 30000,
        stdio: "pipe",
      });
      return true;
    } catch (err) {
      const output = (err as any).stdout || (err as any).stderr || "";
      this.log(`tsc --noEmit failed: ${output.slice(0, 200)}`, "error");
      return false;
    }
  }

  /**
   * Git commit and push the current live state.
   */
  private gitPush(message: string): { pushed: boolean; commitSha?: string } {
    try {
      // Check if there are changes to commit
      const status = execSync("git status --porcelain", {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 5000,
      });
      if (!status.trim()) {
        return { pushed: false };
      }

      // Stage all changes
      execSync("git add -A", { cwd: PROJECT_ROOT, timeout: 5000 });

      // Commit
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd: PROJECT_ROOT,
        timeout: 5000,
      });

      // Get the commit SHA
      const sha = execSync("git rev-parse HEAD", {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      // Push (may fail if no remote configured — that's OK)
      try {
        execSync("git push 2>&1", { cwd: PROJECT_ROOT, timeout: 15000 });
        this.log(`Pushed to GitHub: ${sha.slice(0, 7)}`, "success");
        return { pushed: true, commitSha: sha.slice(0, 7) };
      } catch (err) {
        this.log(`Git commit succeeded but push failed: ${(err as Error).message}`, "warn");
        return { pushed: false, commitSha: sha.slice(0, 7) };
      }
    } catch (err) {
      this.log(`Git operation failed: ${(err as Error).message}`, "error");
      return { pushed: false };
    }
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

      // 2. Check for postmortem constraints
      const postmortem = await postmortemStore.getConstraintsForFile(
        "self",
        "main",
        relPath
      );

      // 3. LLM refactor
      this.log(`Refactoring ${relPath}...`, "info");
      const refactorSystem = `You are a code refactorer. Refactor the following TypeScript file. Rules:
- Preserve EVERY export (function, class, interface, type, const). Do not rename or remove them.
- Add explicit type annotations where they're missing.
- Extract magic numbers into named constants.
- Use modern TypeScript features where appropriate.
- Do NOT add any header comments or branding.
- Do NOT add unused interfaces or types.
- Output ONLY the refactored code in a single fenced code block.
${postmortem.hasActivePostmortem ? `\n${postmortem.promptBlock}\n` : ""}`;

      const refactorUser = `File: ${relPath}\n\n\`\`\`typescript\n${originalCode}\n\`\`\`\n\nRefactor this file. Output ONLY the refactored code.`;

      const llmResult = await llmComplete({
        systemPrompt: refactorSystem,
        userPrompt: refactorUser,
        temperature: 0.2,
      });

      result.llmLatencyMs = llmResult.latencyMs;

      if (!llmResult.ok) {
        result.reason = `LLM unavailable: ${llmResult.error}`;
        this.log(`LLM unavailable for ${relPath}: ${llmResult.error}`, "warn");
        return result;
      }

      const refactoredCode = extractCodeBlock(llmResult.content);
      if (!refactoredCode || refactoredCode.trim().length === 0) {
        result.reason = "LLM returned no code";
        this.log(`LLM returned no code for ${relPath}`, "warn");
        return result;
      }

      result.llmUsed = true;
      result.newBytes = refactoredCode.length;
      result.diffBytes = Math.abs(refactoredCode.length - originalCode.length);

      // 4. Check if anything actually changed
      if (refactoredCode.trim() === originalCode.trim()) {
        result.reason = "No semantic change";
        this.log(`No change for ${relPath} (LLM returned same code)`, "info");
        return result;
      }

      // 5. Write to temp file first, verify tsc, then apply
      const tempFile = filePath + ".tmp";
      writeFileSync(tempFile, refactoredCode, "utf-8");

      // 6. Swap: move temp to real (atomic-ish)
      const backupFile = filePath + ".bak";
      writeFileSync(backupFile, originalCode, "utf-8");
      writeFileSync(filePath, refactoredCode, "utf-8");

      // 7. Verify the project still compiles
      const compiled = this.verifyCompiles();
      result.compiled = compiled;

      if (!compiled) {
        // Revert!
        writeFileSync(filePath, originalCode, "utf-8");
        this.log(`Reverted ${relPath} (tsc --noEmit failed after refactor)`, "error");

        // Record postmortem
        await postmortemStore.recordFailure({
          repo: "self",
          branch: "main",
          filePath: relPath,
          failureType: "COMPILE_ERROR",
          symptom: "Refactored code failed tsc --noEmit",
          evidence: `Original: ${originalCode.length} bytes, Refactored: ${refactoredCode.length} bytes. tsc --noEmit rejected the change.`,
          constraints: `The previous refactor of ${relPath} did not compile. Make smaller, safer changes. Preserve all type signatures exactly.`,
        });

        result.reason = "Reverted (tsc failed)";
        return result;
      }

      // 8. Clean up temp/backup
      try {
        unlinkSync(tempFile);
        unlinkSync(backupFile);
      } catch {
        /* ignore */
      }

      // 9. Enhancement succeeded — the file is now LIVE (hot-reload will pick it up)
      result.enhanced = true;
      result.reason = "Enhanced and live";
      this.stats.totalEnhanced++;
      this.stats.lastEnhancementAt = new Date().toISOString();
      this.log(`Enhanced ${relPath} (+${result.diffBytes} bytes, compiled ✓, live)`, "success");

      // 10. Git commit + push (the proof)
      const pushResult = this.gitPush(
        `Self-enhancement: ${relPath} (LLM refactor, tsc verified, ${result.diffBytes}b diff)`
      );
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
      this.log("Cycle already running, skipping", "warn");
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
        if (!result.enhanced && result.compiled === false) this.stats.totalReverted++;

        // Brief pause between files to let hot-reload settle
        await new Promise((r) => setTimeout(r, 500));
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
