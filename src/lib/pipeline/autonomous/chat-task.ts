/**
 * Chat Task — turns the terminal into a chat-driven coding agent.
 *
 * Instead of the autonomous loop running blindly, the user types a goal in
 * plain English. This module:
 *   1. Gathers codebase context (file list, recent git changes)
 *   2. Sends the user's goal + context to the LLM
 *   3. The LLM proposes a plan: which files to change, what to change, why
 *   4. Returns the plan to the user for approval
 *   5. On approval, applies the changes through the verify-typecheck-push pipeline
 *
 * This is Direction 1 from DIRECTIONS.md — the user IS the feedback signal.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { execSync } from "child_process";
import { join, relative } from "path";
import { llmComplete, extractCodeBlock } from "../llm/agent-llm";
import { pushCurrentState } from "./push-target";

const PROJECT_ROOT = "/home/z/my-project";

export interface ChatTaskPlan {
  ok: boolean;
  userGoal: string;
  understanding: string;
  files: Array<{
    path: string;
    action: "modify" | "create";
    reason: string;
  }>;
  summary: string;
  error?: string;
}

export interface ChatTaskApplyResult {
  ok: boolean;
  results: Array<{
    path: string;
    applied: boolean;
    reason: string;
    diffBytes: number;
  }>;
  pushed: boolean;
  commitSha?: string;
  error?: string;
}

/**
 * Gather codebase context for the LLM:
 * - List of source files with sizes
 * - Recent git log (last 5 commits)
 * - Current git status
 */
function gatherContext(): string {
  const lines: string[] = [];

  // 1. Source files
  const srcDir = join(PROJECT_ROOT, "src");
  const files: string[] = [];
  const scan = (dir: string, depth = 0) => {
    if (depth > 3) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full, depth + 1);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const rel = relative(PROJECT_ROOT, full);
          try {
            const size = statSync(full).size;
            files.push(`${rel} (${size}b)`);
          } catch {
            files.push(rel);
          }
        }
      }
    } catch (err) {
      // ignore permission errors but log for debugging
      console.error(`Error scanning directory ${dir}:`, (err as Error).message);
    }
  };
  scan(srcDir);
  lines.push("SOURCE FILES:");
  lines.push(files.slice(0, 50).join("\n"));

  // 2. Recent commits
  try {
    const log = execSync("git log --oneline -5", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    lines.push("\nRECENT COMMITS:");
    lines.push(log);
  } catch (err) {
    // ignore but log for debugging
    console.error("Error getting git log:", (err as Error).message);
  }

  // 3. Git status
  try {
    const status = execSync("git status --porcelain", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    lines.push("\nGIT STATUS:");
    lines.push(status || "(clean)");
  } catch (err) {
    // ignore but log for debugging
    console.error("Error getting git status:", (err as Error).message);
  }

  return lines.join("\n");
}

/**
 * Step 1: Propose a plan for the user's goal.
 * The LLM analyzes the codebase context + the goal and returns which files
 * to change and why. Does NOT modify anything — just plans.
 */
export async function proposeTaskPlan(userGoal: string): Promise<ChatTaskPlan> {
  if (!userGoal || userGoal.trim().length === 0) {
    return {
      ok: false,
      userGoal,
      understanding: "",
      files: [],
      summary: "",
      error: "User goal cannot be empty",
    };
  }

  const context = gatherContext();

  const systemPrompt = `You are a senior coding agent working inside a Next.js project. The user will describe a goal. Your job is to propose a plan to achieve it.

You have access to the project's file list, recent commits, and git status. You do NOT see file contents yet — you're proposing which files to touch and why.

Output format (mandatory):
First, write your understanding of the goal (1-2 sentences).
Then, list the files to modify or create, with a reason for each.
Then, provide a short summary.

Use this exact format:

UNDERSTANDING: <your understanding of what the user wants>

FILES:
- <path> — <modify|create> — <why>
- <path> — <modify|create> — <why>

SUMMARY: <one sentence summary of the plan>

Rules:
- Only propose changes to files in the src/ directory
- Be conservative — propose the minimum changes needed
- If the goal is unclear, say so in UNDERSTANDING and propose what you think they meant
- Max 5 files per plan
- Paths must be relative to the project root (e.g. src/lib/foo.ts)`;

  const userPrompt = `CODEBASE CONTEXT:
${context}

USER GOAL:
${userGoal}

Propose a plan to achieve this goal.`;

  const result = await llmComplete({
    systemPrompt,
    userPrompt,
    temperature: 0.3,
  });

  if (!result.ok) {
    return {
      ok: false,
      userGoal,
      understanding: "",
      files: [],
      summary: "",
      error: result.error ?? "LLM unavailable",
    };
  }

  return parsePlan(result.content, userGoal);
}

/**
 * Parse the LLM's plan response into structured data.
 */
function parsePlan(raw: string, userGoal: string): ChatTaskPlan {
  const plan: ChatTaskPlan = {
    ok: true,
    userGoal,
    understanding: "",
    files: [],
    summary: "",
  };

  const understandingMatch = raw.match(/UNDERSTANDING:\s*(.+)/i);
  if (understandingMatch) plan.understanding = understandingMatch[1].trim();

  const summaryMatch = raw.match(/SUMMARY:\s*(.+)/i);
  if (summaryMatch) plan.summary = summaryMatch[1].trim();

  // Parse files: lines starting with "- path — action — reason" or "- path - action - reason"
  const filesSection = raw.match(/FILES:\s*\n([\s\S]*?)(?:\n\n|\nSUMMARY:|$)/i);
  if (filesSection) {
    const fileLines = filesSection[1].split("\n").filter((l) => l.trim().startsWith("-"));
    for (const line of fileLines) {
      // Match: - path — modify — reason  (em dash)
      // or:    - path - modify - reason  (hyphen)
      const match = line.match(/^-\s*(\S+)\s*[—-]\s*(modify|create)\s*[—-]\s*(.+)/i);
      if (match) {
        plan.files.push({
          path: match[1].trim(),
          action: match[2].toLowerCase() as "modify" | "create",
          reason: match[3].trim(),
        });
      }
    }
  }

  if (!plan.understanding && plan.files.length === 0) {
    plan.ok = false;
    plan.error = "Could not parse LLM plan";
  }

  return plan;
}

/**
 * Step 2: Apply a plan — for each file, ask the LLM to generate the new content,
 * verify via in-memory typecheck, write to disk, and push.
 */
export async function applyTaskPlan(plan: ChatTaskPlan): Promise<ChatTaskApplyResult> {
  if (!plan.files || plan.files.length === 0) {
    return {
      ok: false,
      results: [],
      pushed: false,
      error: "No files to apply in the plan",
    };
  }

  const results: ChatTaskApplyResult["results"] = [];

  for (const file of plan.files) {
    if (!file.path || file.path.trim().length === 0) {
      results.push({
        path: file.path || "",
        applied: false,
        reason: "Invalid file path",
        diffBytes: 0,
      });
      continue;
    }

    const fullPath = join(PROJECT_ROOT, file.path);
    let originalCode = "";
    try {
      if (file.action === "modify") {
        originalCode = readFileSync(fullPath, "utf-8");
      }
    } catch (err) {
      results.push({
        path: file.path,
        applied: false,
        reason: `Failed to read file: ${(err as Error).message}`,
        diffBytes: 0,
      });
      continue;
    }

    // Ask the LLM to generate the new file content
    const systemPrompt = `You are a coding agent applying a specific change to a TypeScript file. The user approved a plan. Your job is to output the COMPLETE new file content that achieves the goal.

Rules:
- Preserve every existing export (function, class, interface, type, const) — do not rename or remove
- Only make the changes needed for the task
- Output ONLY the complete file content in a single fenced \`\`\`typescript code block
- Do NOT add header comments, banners, or branding
- If modifying, keep all existing code that isn't part of the change`;

    const userPrompt = `GOAL: ${plan.userGoal}

FILE: ${file.path}
ACTION: ${file.action}
REASON: ${file.reason}

${file.action === "modify" ? `CURRENT CONTENT:\n\`\`\`typescript\n${originalCode}\n\`\`\`` : "(new file)"}

Output the COMPLETE new content for this file that achieves the goal.`;

    const llmResult = await llmComplete({
      systemPrompt,
      userPrompt,
      temperature: 0.2,
    });

    if (!llmResult.ok) {
      results.push({
        path: file.path,
        applied: false,
        reason: `LLM failed for ${file.path}: ${llmResult.error}`,
        diffBytes: 0,
      });
      continue;
    }

    const newCode = extractCodeBlock(llmResult.content);
    if (!newCode || newCode.trim().length === 0) {
      results.push({
        path: file.path,
        applied: false,
        reason: `LLM returned no code for ${file.path}`,
        diffBytes: 0,
      });
      continue;
    }

    // Basic truncation check
    const opens = (newCode.match(/{/g) || []).length;
    const closes = (newCode.match(/}/g) || []).length;
    if (opens !== closes) {
      results.push({
        path: file.path,
        applied: false,
        reason: `Rejected (unbalanced braces: ${opens} { vs ${closes} })`,
        diffBytes: 0,
      });
      continue;
    }

    // Write the file
    try {
      writeFileSync(fullPath, newCode, "utf-8");
      const diffBytes = Math.abs(newCode.length - originalCode.length);
      results.push({
        path: file.path,
        applied: true,
        reason: `Applied (${diffBytes}b diff)`,
        diffBytes,
      });
    } catch (err) {
      results.push({
        path: file.path,
        applied: false,
        reason: `Write failed for ${file.path}: ${(err as Error).message}`,
        diffBytes: 0,
      });
    }
  }

  // Verify the project still compiles
  let compiled = false;
  try {
    execSync("npx tsc --noEmit 2>&1", {
      cwd: PROJECT_ROOT,
      timeout: 30000,
      stdio: "pipe",
    });
    compiled = true;
  } catch {
    compiled = false;
  }

  if (!compiled) {
    // Revert all changes
    try {
      execSync("git checkout -- .", { cwd: PROJECT_ROOT, timeout: 5000, stdio: "pipe" });
    } catch {
      // ignore
    }
    return {
      ok: false,
      results: results.map((r) => ({ ...r, applied: false, reason: `Reverted (tsc failed): ${r.reason}` })),
      pushed: false,
      error: "Project failed to compile after changes — all changes reverted",
    };
  }

  // Commit and push through the SAME authenticated path the loop uses
  // (push-target.ts): remote self-heal, token injected via GIT_CONFIG_* env
  // (never on the command line or in the remote URL), divergence auto-heal,
  // honest errors. The old raw `git push origin main` had no credentials and
  // would fail on any auth-required remote; the old shell-string commit let
  // LLM-generated text reach a shell — both gone.
  const outcome = await pushCurrentState({
    message: `Chat task: ${plan.userGoal.slice(0, 60)}\n\n${plan.summary}`,
  });

  if (!outcome.pushed) {
    return {
      ok: true,
      results,
      pushed: false,
      commitSha: outcome.commitSha,
      error: outcome.error
        ? `Changes applied but push failed: ${outcome.error}`
        : undefined,
    };
  }

  return {
    ok: true,
    results,
    pushed: true,
    commitSha: outcome.commitSha,
  };
}