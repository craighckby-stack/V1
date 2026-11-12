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

import { readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join, relative } from "path";
import { llmComplete, extractCodeBlock } from "../llm/agent-llm";
import { pushCurrentState } from "./push-target";
import { detectTruncation } from "./code-analysis";
import { typecheckRefactor } from "./in-memory-typecheck";
import { isProtectedPath } from "./protected-files";
import { gateMutation } from "../core/mutation-guard";
import { evaluateAstDiff } from "../core/ast-diff-gate";
import { withTreeLock } from "../core/tree-lock";

import { PROJECT_ROOT } from "../core/paths";

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
- NEVER propose changes to src/app/page.tsx, src/app/layout.tsx, src/lib/db.ts, anything under src/app/api/self-enhance/, src/app/api/autonomous/, src/app/api/hot-swap/, src/app/api/duress/, src/lib/pipeline/ (the engine room), or prisma/schema.prisma — those are the system's own control surface and gates; they are permanently off-limits
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

  const plan = parsePlan(result.content, userGoal);

  // AUDIT 3 (B2, propose side): filter protected paths out of the plan
  // BEFORE the operator ever sees it. The apply path re-checks (defense
  // in depth), but an operator should never be asked to approve a
  // mutation of the control surface in the first place — the plan is the
  // LLM's proposal, and the proposal itself must respect the hard floor.
  const allowedFiles = plan.files.filter((f) => !isProtectedPath(f.path));
  const droppedCount = plan.files.length - allowedFiles.length;
  if (droppedCount > 0) {
    plan.files = allowedFiles;
    plan.summary = `${plan.summary} (${droppedCount} protected file(s) removed from the plan — the system's gates and control surface are off-limits)`;
    if (allowedFiles.length === 0) {
      plan.ok = false;
      plan.error =
        "The proposed plan only touched protected files (the system's gates, control surface, or integrity chain). Nothing to apply — describe a goal that targets the mutable codebase instead.";
    }
  }

  return plan;
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
 * Normalize a plan file path for the src/-only scope check (audit 3 F11):
 * backslashes → forward slashes, collapse duplicate separators, strip
 * leading "./" segments, and resolve ".." lexically — so
 * "src/../memory/lessons.md" normalizes to "memory/lessons.md" and fails
 * the src/ prefix check. (The per-file checks inside applyTaskPlan
 * additionally reject any path containing ".." outright.)
 */
function normalizePlanPath(p: string): string {
  let s = p.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  const parts = s.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
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

  // AUDIT 3 F11 — src/-only scope. An LLM plan (operator-approved) could
  // previously write ANY non-protected repo path: postmortems/ (forge
  // scar memory), memory/lessons.md, or rewrite a *.test.ts
  // characterization pin, weakening future autonomous-mutation gates.
  // Operator auth (API key) + src/-only scope now bound the blast radius.
  // One out-of-scope path rejects the WHOLE plan — a plan that tries to
  // smuggle a write outside the mutable source tree is never applied,
  // not even partially.
  const outOfScope = plan.files
    .map((f) => f.path)
    .filter((p) => !normalizePlanPath(p).startsWith("src/"));
  if (outOfScope.length > 0) {
    return {
      ok: false,
      results: [],
      pushed: false,
      error: `Plan rejected: every file must live inside src/ — out-of-scope path(s): ${outOfScope.join(", ")}`,
    };
  }

  // AUDIT 3 F10 — tree lock. chat-task and the self-enhance loop used to
  // race on the live tree: this function's rollback could silently revert
  // a gated, already-pushed enhancement, and the loop's `git add -A`
  // could sweep a half-applied plan into an unrelated commit. The whole
  // write → verify (final tsc) → rollback/commit+push span now holds the
  // tree lock so the two live-tree writers serialize (FIFO) instead of
  // interleaving. (LLM generation for later files also runs under the
  // lock — the per-file in-memory typecheck substitutes against the
  // on-disk state of already-written files, so generation and writes of
  // one plan must not interleave either.)
  return withTreeLock(async () => {
    const results: ChatTaskApplyResult["results"] = [];
    // Per-file rollback journal: what this task wrote, and how to undo it.
    // The old failure path ran `git checkout -- .` — a blunt instrument that
    // reverted EVERYTHING dirty in the worktree, including changes made by
    // other processes (a concurrent enhancement cycle, operator edits, an
    // in-flight ratchet pin). Rollback is now scoped to exactly the files this
    // task touched, and only those.
    const rollback: Array<{ fullPath: string; original: string | null }> = [];

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

      // Validate file path to prevent directory traversal
      if (file.path.includes("..") || file.path.startsWith("/") || file.path.includes("//")) {
        results.push({
          path: file.path,
          applied: false,
          reason: "Invalid file path: directory traversal not allowed",
          diffBytes: 0,
        });
        continue;
      }

      // AUDIT 3 (B2): the protected-files hard floor. The old path only
      // blocked directory traversal — an approved plan could write to ANY
      // src/ file, including page.tsx (the control surface), protected-
      // files.ts (the protection list itself), or the gate modules. The
      // protected-files invariant is "the loop can never violate it"; the
      // chat-task path is operator-driven, but the invariant still applies
      // — an LLM-proposed "refactor the control surface" plan must die
      // here, not at the operator's judgment.
      if (isProtectedPath(file.path)) {
        results.push({
          path: file.path,
          applied: false,
          reason: "Rejected (protected path — this file is part of the system's gates, control surface, or integrity chain and can never be mutated by an LLM-generated plan)",
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
- Output ONLY the complete file content in a single fenced \`typescript\` code block
- Do NOT add header comments, banners, or branding
- If modifying, keep all existing code that isn't part of the change`;

      const userPrompt = `GOAL: ${plan.userGoal}

FILE: ${file.path}
ACTION: ${file.action}
REASON: ${file.reason}

${file.action === "modify" ? `CURRENT CONTENT:
\`\`\`typescript
${originalCode}
\`\`\`` : "(new file)"}

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

      // Truncation check — parser-based (code-analysis.ts); the old raw brace
      // count rejected valid files whose braces balanced only when counting
      // inside strings/regexes.
      const truncation = detectTruncation(newCode, originalCode, file.path);
      if (truncation.truncated) {
        results.push({
          path: file.path,
          applied: false,
          reason: `Rejected (LLM output truncated: ${truncation.reason ?? "unknown"})`,
          diffBytes: 0,
        });
        continue;
      }

      // AUDIT 3 (B4): the chat-task path ran NONE of the semantic gates the
      // rest of the system runs — no evil-token check, no symbol-retention
      // check. A plan whose generated code introduced eval( or dropped
      // exported symbols would typecheck fine and land on disk. Both gates
      // now run here, same contract as verify-refactor.ts.
      const mutation = gateMutation({
        filePath: file.path,
        originalCode,
        evolvedCode: newCode,
        // AUDIT 8 (round 2): the operator approved this plan — the
        // convergent-move heuristic (an autonomous-loop quality guard
        // against LLM convergence on defensive no-ops) does not apply.
        // A legitimate operator goal can be exactly that pattern ("fix
        // the null handling in X because the upstream contract changed").
        // Every security check still runs: evil tokens (triage),
        // protected paths, empty content, symbol retention (AST).
        operatorApproved: true,
      });
      if (!mutation.allowed) {
        results.push({
          path: file.path,
          applied: false,
          reason: `Rejected by mutation guard (${mutation.rejectedBy}): ${mutation.reasons.slice(0, 2).join(" | ").slice(0, 180)}`,
          diffBytes: 0,
        });
        continue;
      }

      // Symbol retention — the TS-parser gate (stronger than the regex
      // validator: catches dropped class methods and export-alias renames).
      // HARD-FAIL on any symbol-drop/branding violation (the score-based
      // `passed` tolerates single drops — right for the remote path, wrong
      // for this one; see verify-refactor.ts Gate 1b for the same contract).
      // Only for modify (a create has no symbols to retain).
      if (file.action === "modify") {
        const ast = evaluateAstDiff(originalCode, newCode, file.path);
        const hardFail = ast.violations.filter(
          (v) => v.code === "AST_SYMBOL_DROPPED" || v.code === "BRANDING_INJECTION"
        );
        if (hardFail.length > 0 || !ast.passed) {
          results.push({
            path: file.path,
            applied: false,
            reason: `Rejected by AST diff: ${(hardFail.length > 0 ? hardFail : ast.violations).slice(0, 2).map((v) => v.message).join(" | ").slice(0, 180)}`,
            diffBytes: 0,
          });
          continue;
        }
      }

      // Write the file — but ONLY after the in-memory typecheck passes.
      // This is the same "broken code never touches disk" contract the rest
      // of the system enforces (verify-refactor.ts): the
      // old flow wrote the LLM output to the LIVE file first and typechecked
      // the whole project afterwards, so Turbopack's watcher saw broken code
      // during the ~30s window and a final tsc failure nuked unrelated dirty
      // state with `git checkout -- .`.
      const check = typecheckRefactor(fullPath, newCode);
      if (!check.ok) {
        results.push({
          path: file.path,
          applied: false,
          reason: `Rejected (in-memory typecheck failed: ${check.errors.slice(0, 2).join(" | ").slice(0, 180)})`,
          diffBytes: 0,
        });
        continue;
      }

      try {
        writeFileSync(fullPath, newCode, "utf-8");
        rollback.push({
          fullPath,
          // null = the file did not exist before this task (created) —
          // rollback for it is deletion, not content restore.
          original: file.action === "modify" ? originalCode : null,
        });
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

    // Belt-and-braces final compile. With the per-file in-memory gate above this
    // should never fail, but if it does, the rollback is SCOPED: only the files
    // this task wrote are restored (content for modified files, deletion for
    // created files). Never `git checkout -- .` — that reverts unrelated dirty
    // state in the worktree.
    let compiled = false;
    try {
      execSync("bunx tsc --noEmit 2>&1", {
        cwd: PROJECT_ROOT,
        timeout: 120000,
        stdio: "pipe",
      });
      compiled = true;
    } catch {
      compiled = false;
    }

    if (!compiled) {
      for (const entry of rollback) {
        try {
          if (entry.original === null) {
            rmSync(entry.fullPath, { force: true });
          } else {
            writeFileSync(entry.fullPath, entry.original, "utf-8");
          }
        } catch (err) {
          // Log, don't throw: we must still report the failure honestly,
          // and a partial rollback is better than aborting mid-rollback.
          console.error("Error rolling back", entry.fullPath, (err as Error).message);
        }
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
  });
}