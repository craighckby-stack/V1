/**
 * Task Executor — runs a single self-defined task against the live source.
 *
 * Two execution paths:
 *
 *   DETERMINISTIC (no LLM): `missing-return-type` is fixed by asking the
 *   TypeScript checker itself what the inferred return type is, then
 *   inserting that annotation textually. The compiler's own knowledge,
 *   made explicit. Works during 429 rate limits.
 *
 *   LLM: a FOCUSED prompt — one file, one issue, one instruction. Much
 *   smaller blast radius than the old whole-file blind refactor. If the
 *   LLM is unavailable (429), the task is DEFERRED (returned to the queue)
 *   and the loop moves on — it never burns a cycle waiting.
 *
 * Every produced change is verified IN MEMORY (typecheckRefactor) before
 * the caller writes anything to disk. Broken code never touches the
 * filesystem.
 */

import * as ts from "typescript";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { typecheckRefactor, syntaxCheck } from "./in-memory-typecheck";
import { llmComplete, extractCodeBlock } from "../llm/agent-llm";
import { postmortemStore } from "../postmortem/postmortem-store";
import { getTaskMethod } from "./self-task-generator";

const PROJECT_ROOT = "/home/z/my-project";

export interface TaskExecutionResult {
  status: "applied" | "deferred" | "failed" | "no-op";
  method: "deterministic" | "llm";
  newCode?: string; // verified replacement (caller writes it)
  summary: string;
  error?: string;
}

interface TaskRow {
  id: string;
  kind: string;
  filePath: string;
  line: number;
  evidence: string;
  attempts: number;
}

/** Build a checker over the CURRENT project state (disk).
 * Scoped to project code (src/) — reference folders (examples/, skills/)
 * carry pre-existing errors that would poison inference and verification. */
function buildProgram(): ts.Program {
  const configPath = resolve(PROJECT_ROOT, "tsconfig.json");
  const configText = readFileSync(configPath, "utf-8");
  const parsed = ts.parseConfigFileTextToJson(configPath, configText);
  const config = ts.parseJsonConfigFileContent(parsed.config, ts.sys, PROJECT_ROOT, { noEmit: true }, configPath);
  const fileNames = config.fileNames.filter(
    (f) => !f.includes("/examples/") && !f.includes("/skills/")
  );
  return ts.createProgram(fileNames, { ...config.options, noEmit: true });
}

/**
 * DETERMINISTIC: add an explicit return type annotation to the function
 * at the task's line, using the checker's own inference.
 */
function executeMissingReturnType(task: TaskRow, code: string): TaskExecutionResult {
  const absPath = join(PROJECT_ROOT, task.filePath);
  const sf = ts.createSourceFile(absPath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // Find the function/method declaration whose name sits on the task's line
  let target: ts.FunctionDeclaration | ts.MethodDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.body &&
      !node.type &&
      node.name
    ) {
      const nameLine = sf.getLineAndCharacterOfPosition(node.name.getStart()).line + 1;
      if (nameLine === task.line) target = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!target) {
    return { status: "no-op", method: "deterministic", summary: "function not found at line (already annotated or moved)" };
  }

  const fn = target as ts.FunctionDeclaration | ts.MethodDeclaration;
  if (!fn.body) {
    return { status: "no-op", method: "deterministic", summary: "function has no body (overload?)" };
  }

  // Ask the checker what the return type IS
  const program = buildProgram();
  const checker = program.getTypeChecker();
  const diskSf = program.getSourceFile(absPath);
  if (!diskSf) {
    return { status: "failed", method: "deterministic", summary: "file not in program", error: "source file missing from tsconfig program" };
  }

  // Locate the same node in the disk program (positions match if file unchanged)
  let diskFn: ts.FunctionDeclaration | ts.MethodDeclaration | null = null;
  const visitDisk = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.body &&
      !node.type &&
      node.name
    ) {
      const nameLine = diskSf.getLineAndCharacterOfPosition(node.name.getStart()).line + 1;
      if (nameLine === task.line) diskFn = node;
    }
    ts.forEachChild(node, visitDisk);
  };
  visitDisk(diskSf);

  if (!diskFn) {
    return { status: "no-op", method: "deterministic", summary: "checker view differs from source — skipping" };
  }

  const signature = checker.getSignatureFromDeclaration(diskFn as ts.FunctionDeclaration | ts.MethodDeclaration);
  if (!signature) {
    return { status: "failed", method: "deterministic", summary: "no signature", error: "checker could not resolve signature" };
  }

  const returnType = checker.getReturnTypeOfSignature(signature);
  const typeText = checker.typeToString(returnType, undefined, ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);

  // Guard: don't annotate garbage
  if (!typeText || typeText === "any" || typeText.length > 90 || typeText.includes("error")) {
    return { status: "no-op", method: "deterministic", summary: `inferred type not annotatable: "${typeText.slice(0, 40)}"` };
  }

  // Insert `: T ` immediately before the body's opening brace
  const insertPos = fn.body.getStart(sf);
  const newCode = code.slice(0, insertPos) + `: ${typeText} ` + code.slice(insertPos);

  const syntax = syntaxCheck(newCode);
  if (!syntax.ok) {
    return { status: "failed", method: "deterministic", summary: "syntax check failed after insertion", error: syntax.error };
  }

  return {
    status: "applied",
    method: "deterministic",
    newCode,
    summary: `added explicit return type \`: ${typeText}\` (checker-inferred)`,
  };
}

/** Per-kind instruction for the LLM executor. */
function kindInstruction(kind: string, evidence: string): string {
  switch (kind) {
    case "todo-comment":
      return `Resolve the TODO/FIXME/HACK at the evidence line. Either implement the missing behavior (if the comment describes something concrete and small) or remove the comment if it is obsolete. Do not leave the marker in place unless implementing it would be unsafe — in that case return the file unchanged (output the original code exactly).`;
    case "empty-catch":
      return `The evidence line is inside a catch block with an empty body. If the error is intentionally ignored, add a brief explanatory comment inside the block. If it should be handled, add minimal, safe handling (log or rethrow). Keep changes minimal.`;
    case "any-usage":
      return `Replace the \`any\` usage at the evidence line with the most precise type you can infer from context. If a precise type is impossible, use \`unknown\` with a narrowing check. Do not change behavior.`;
    case "magic-number":
      return `Extract the magic number at the evidence line into a named constant declared near its use (function scope is fine). Pick a descriptive name. Do not change behavior or the value.`;
    case "non-null-assertion":
      return `Replace the non-null assertion (\`!\`) at the evidence line with a safe alternative: optional chaining, a guard, or a narrowed check — whichever fits the surrounding code. Do not change observable behavior.`;
    default:
      return `Improve the code at the evidence line: "${evidence}". Keep the change minimal and behavior-preserving.`;
  }
}

/**
 * LLM: focused single-task fix. Output must be the COMPLETE updated file.
 */
async function executeViaLlm(task: TaskRow, code: string): Promise<TaskExecutionResult> {
  const absPath = join(PROJECT_ROOT, task.filePath);
  const postmortem = await postmortemStore.getConstraintsForFile("self", "main", task.filePath);

  const system = `You are a precise code-repair agent. You fix exactly ONE issue in a TypeScript file.
Rules:
- Preserve every export, symbol, and behavior. Minimal diff.
- Output ONLY the complete updated file in a single fenced typescript code block.
- If the fix cannot be made safely, output the original file unchanged.
- No header comments, no branding, no explanation outside the code block.
${postmortem.hasActivePostmortem ? `\n${postmortem.promptBlock}\n` : ""}`;

  const user = `File: ${task.filePath}
Issue kind: ${task.kind}
Evidence line ${task.line}: ${task.evidence}

Instruction: ${kindInstruction(task.kind, task.evidence)}

\`\`\`typescript
${code}
\`\`\``;

  const result = await llmComplete({ systemPrompt: system, userPrompt: user, temperature: 0.1 });
  if (!result.ok) {
    // 429 / unavailable → defer, don't fail
    return {
      status: "deferred",
      method: "llm",
      summary: "LLM unavailable",
      error: result.error,
    };
  }

  const newCode = extractCodeBlock(result.content);
  if (!newCode || newCode.trim().length === 0) {
    return { status: "failed", method: "llm", summary: "LLM returned no code", error: "empty response" };
  }

  // Truncation guard: unbalanced braces mean the file was cut off
  const braces = (s: string) => (s.match(/\{/g) ?? []).length - (s.match(/\}/g) ?? []).length;
  if (braces(newCode) !== 0) {
    return { status: "failed", method: "llm", summary: "LLM output truncated (unbalanced braces)", error: "truncation" };
  }

  if (newCode.trim() === code.trim()) {
    return { status: "no-op", method: "llm", summary: "LLM returned the file unchanged (fix unsafe or unnecessary)" };
  }

  const syntax = syntaxCheck(newCode);
  if (!syntax.ok) {
    return { status: "failed", method: "llm", summary: "syntax error in LLM output", error: syntax.error };
  }

  return { status: "applied", method: "llm", newCode, summary: `LLM fix applied for ${task.kind}` };
}

/**
 * Execute a task. Reads the file, runs the appropriate executor,
 * verifies the result IN MEMORY. Returns verified newCode (not written).
 */
export async function executeTask(task: TaskRow): Promise<TaskExecutionResult> {
  const absPath = join(PROJECT_ROOT, task.filePath);

  let code: string;
  try {
    code = readFileSync(absPath, "utf-8");
  } catch {
    return { status: "failed", method: "deterministic", summary: "file missing", error: `cannot read ${task.filePath}` };
  }

  // Line still matches the evidence? (file may have shifted)
  const currentLine = code.split("\n")[task.line - 1] ?? "";
  const lineDrifted =
    task.kind !== "missing-return-type" &&
    !currentLine.includes(task.evidence.slice(0, 30).replace(/^[/*\s]+/, "").slice(0, 20));

  const method = getTaskMethod(task.kind);
  let result: TaskExecutionResult;

  if (method === "deterministic") {
    result = executeMissingReturnType(task, code);
  } else {
    result = await executeViaLlm(task, code);
    // If the file drifted, the evidence line may have moved — still let the
    // LLM try; its instruction includes the original evidence for context.
    if (result.status === "no-op" && lineDrifted) {
      result = { ...result, summary: `${result.summary} (evidence line drifted — task may be stale)` };
    }
  }

  // Verify in memory before handing back
  if (result.status === "applied" && result.newCode) {
    const check = typecheckRefactor(absPath, result.newCode);
    if (!check.ok) {
      return {
        status: "failed",
        method: result.method,
        summary: `in-memory typecheck rejected the fix (${check.errors.length} errors)`,
        error: check.errors.slice(0, 3).join(" | ").slice(0, 300),
      };
    }
  }

  return result;
}
