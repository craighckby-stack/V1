/**
 * Self-Task Generator — THE INPUT LAYER.
 *
 * Principle: the system defines its own input. No user goals, no prompts.
 * This module statically analyzes the system's OWN source code with the
 * TypeScript compiler API and derives a prioritized task queue from what
 * it finds. The queue IS the input; the loop consumes it.
 *
 * Analysis is 100% deterministic — it works even when the LLM API is
 * rate-limited. Findings are persisted as SelfTask rows (deduped), so the
 * queue survives restarts and every task has an audit trail.
 *
 * Task kinds (priority = importance):
 *   1 todo-comment        LLM  — explicit debt markers (TODO/FIXME/HACK)
 *   2 empty-catch         LLM  — catch blocks that swallow errors silently
 *   3 any-usage           LLM  — `: any` / `as any` type-safety holes
 *   4 missing-return-type DET  — deterministic fix: checker-inferred annotation
 *   4 unused-import       DET  — deterministic fix: remove unused import bindings
 *   5 magic-number        LLM  — unnamed numeric literals in expressions
 *   6 non-null-assertion  LLM  — `!.` unsafe member access
 *
 * Two DETERMINISTIC kinds now exist so the loop has LLM-free work during
 * rate limits. The unused-import detector is a heuristic (name doesn't
 * appear as an identifier elsewhere in the file); the in-memory typecheck
 * gate is the safety net — if removing an import breaks anything, the fix
 * is rejected before it touches disk.
 */

import * as ts from "typescript";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { db } from "@/lib/db";

import { PROJECT_ROOT } from "../core/paths";
import { isProtectedPath } from "./protected-files";
const PIPELINE_SRC_DIR = join(PROJECT_ROOT, "src/lib/pipeline");
// AUDIT 8 (round 2): the task generator previously filtered scan
// candidates against PROTECTED_FILES (the EXACT set) only — but most
// of the control surface is protected by PREFIX (src/app/api/self-
// enhance/**, api/autonomous/**, api/hot-swap/**, ...). Tasks queued
// for prefix-protected routes always failed the execution-time gate
// (verifyRefactor bundles the mutation guard), so this was pure quota
// waste: the LLM generated fixes that could never land. The scan now
// filters with isProtectedPath (exact set + prefixes) — same predicate
// the loop's scanFiles uses. Tasks are never queued for files the
// loop refuses to mutate.
//
// AUDIT 8 (operator-directed, 2026-11-12): the saturation.ts scope
// was rolled back to src/lib/pipeline + src/app (v4). src/components
// is REMOVED from this scan too — the task-executor must not land
// fixes on vendored shadcn primitives. DISPLAY_SRC_DIR is likewise
// gone: src/app covers src/app/display (scanning both double-counted
// every display file toward the per-kind caps).
const APP_SRC_DIR = join(PROJECT_ROOT, "src/app");

/**
 * Files the system must NOT modify (would break its own loop).
 * Tasks are never generated for these — the system doesn't queue work
 * it refuses to do. Filtered via isProtectedPath (the shared exact set
 * + prefix predicate, audit 8 round 2 — the old PROTECTED_FILES-only
 * filter missed every prefix-protected route).
 */

export const TASK_KINDS = {
  "todo-comment": { priority: 1, method: "llm" as const },
  "empty-catch": { priority: 2, method: "llm" as const },
  "any-usage": { priority: 3, method: "llm" as const },
  "missing-return-type": { priority: 4, method: "deterministic" as const },
  "unused-import": { priority: 4, method: "deterministic" as const },
  "magic-number": { priority: 5, method: "llm" as const },
  "non-null-assertion": { priority: 6, method: "llm" as const },
  // Oracle-failed-prophecy (audit 8 — the closure for the oracle's
  // heartbreak channel). Added here rather than in oracle-task-feed.ts
  // so the task-executor's getTaskMethod() and the queue-stats UI
  // recognize it without a special-case lookup. Priority 7 (lowest):
  // a failed prophecy is a soft signal — the file wasn't enhanced, the
  // self-model was wrong — and the loop should work on real findings
  // (TODOs, empty catches) before investigating prediction failures.
  "oracle-failed-prophecy": { priority: 7, method: "llm" as const },
};

export type TaskKind = keyof typeof TASK_KINDS;

export interface Finding {
  kind: TaskKind;
  filePath: string; // relative
  line: number; // 1-based
  evidence: string; // trimmed source line
}

const MAX_TASKS_PER_KIND_PER_FILE = 5;
const MAX_PENDING_TOTAL = 200;

/** Recursively list source files in the pipeline dir (.ts) AND the display
 *  dir (.tsx). Excludes protected files and test files. */
function listOwnSourceFiles(): string[] {
  const files: string[] = [];
  const scan = (dir: string, wantTsx: boolean) => {
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // dir may not exist yet
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full, wantTsx);
      } else if (
        (entry.name.endsWith(".ts") || (wantTsx && entry.name.endsWith(".tsx"))) &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".test.tsx") &&
        !entry.name.endsWith(".bak") &&
        !entry.name.endsWith(".tmp")
      ) {
        const rel = relative(PROJECT_ROOT, full);
        if (!isProtectedPath(rel)) files.push(full);
      }
    }
  };
  scan(PIPELINE_SRC_DIR, false); // .ts only
  // AUDIT 8 (round 2): src/app covers display + api + page surface in
  // one scan (saturation.ts v4 parity); src/components is excluded —
  // vendored shadcn primitives are out of the loop's reach by operator
  // directive. Prefix-protected subtrees under src/app/api/ are filtered
  // by isProtectedPath inside scan().
  scan(APP_SRC_DIR, true); // .ts + .tsx
  return files;
}

/** Is this numeric literal "magic"? (excluding 0/1/2/-1, enum members, and declaration initializers — those already have names) */
function isMagicNumber(node: ts.NumericLiteral): boolean {
  const value = Number(node.text);
  if ([0, 1, 2, -1].includes(value)) return false;

  const parent = node.parent;
  if (!parent) return false;

  // Skip enum members (named by definition)
  if (ts.isEnumMember(parent)) return false;

  // Skip declaration initializers — `const X = 5000` binds the value to a name
  if (
    (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) &&
    parent.initializer === node
  ) {
    return false;
  }

  return true; // inline literal in an expression — the classic magic number
}

/** Line number (1-based) for a position in a source file. */
function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Analyze one source file → findings. Pure static analysis, no LLM. */
function analyzeFile(absPath: string): Finding[] {
  const relPath = relative(PROJECT_ROOT, absPath);
  const text = readFileSync(absPath, "utf-8");
  // Use the right script kind for .tsx (JSX) vs .ts — the parser needs
  // ScriptKind.TSX for .tsx files or it will fail on JSX syntax.
  const scriptKind = absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const findings: Finding[] = [];

  const seen = new Set<string>(); // kind:line dedup within file
  const push = (kind: TaskKind, pos: number) => {
    const line = lineOf(sf, pos);
    const key = `${kind}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    const evidence = (text.split("\n")[line - 1] ?? "").trim().slice(0, 160);
    findings.push({ kind, filePath: relPath, line, evidence });
  };

  // 1) TODO/FIXME/HACK comments — require a comment marker so string
  // literals that merely mention the words are not flagged
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/(\/\/|\/\*|\*).*\b(TODO|FIXME|HACK)\b/.test(lines[i])) {
      const key = `todo-comment:${i + 1}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({
          kind: "todo-comment",
          filePath: relPath,
          line: i + 1,
          evidence: lines[i].trim().slice(0, 160),
        });
      }
    }
  }

  // AST-based kinds
  const visit = (node: ts.Node): void => {
    // 2) empty catch blocks
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      push("empty-catch", node.block.getStart());
    }

    // 3) `any` usage
    if (node.kind === ts.SyntaxKind.AnyKeyword && node.parent) {
      // Only flag in type positions (annotation, as-expression, type args)
      const p = node.parent;
      const inTypePosition =
        (p as { type?: ts.Node }).type === node || // x: any / (p: any) => — annotation is parent's .type
        ts.isAsExpression(p) || // as any
        ts.isTypeReferenceNode(p) || // Array<any>
        ts.isArrayTypeNode(p);
      if (inTypePosition) push("any-usage", node.getStart());
    }

    // 4a) missing return type on function/method declarations
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.body &&
      !node.type &&
      node.name
    ) {
      push("missing-return-type", node.name.getStart());
    }

    // 4b) unused imports — heuristic: an imported binding name that doesn't
    // appear as an identifier elsewhere in the file (outside the import line).
    // The in-memory typecheck gate is the safety net: if removing the import
    // breaks anything, the fix is rejected before touching disk.
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      const importLineNo = lineOf(sf, node.getStart());
      const bindings: { name: string; localName: string }[] = [];
      // default import: `import X from "mod"`
      if (clause.name) {
        bindings.push({ name: clause.name.text, localName: clause.name.text });
      }
      // named imports: `import { A, B as C } from "mod"`
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          bindings.push({
            name: (el.propertyName ?? el.name).text,
            localName: el.name.text, // the local binding is what we check
          });
        }
      }
      // namespace import: `import * as N from "mod"`
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        bindings.push({ name: clause.namedBindings.name.text, localName: clause.namedBindings.name.text });
      }
      // Compute the "rest of file" ONCE per import declaration — the old
      // loop re-split the entire file text for every binding (O(bindings ×
      // file length) per import, quadratic on import-heavy modules).
      const fileLines = text.split("\n");
      const restOfFile = fileLines.filter((_, i) => i !== importLineNo - 1).join("\n");
      for (const b of bindings) {
        // Check if localName appears as an identifier outside this import line
        const re = new RegExp(`\\b${b.localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
        if ((restOfFile.match(re) ?? []).length === 0) {
          push("unused-import", node.getStart());
          break; // one finding per import declaration (fixer removes the whole line)
        }
      }
    }

    // 5) magic numbers
    if (ts.isNumericLiteral(node) && isMagicNumber(node)) {
      push("magic-number", node.getStart());
    }

    // 6) non-null assertions
    if (ts.isNonNullExpression(node)) {
      push("non-null-assertion", node.getStart());
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  return findings;
}

/** Cap findings per kind per file to keep the queue balanced. */
function capPerKind(findings: Finding[]): Finding[] {
  const counts = new Map<string, number>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.kind}:${f.filePath}`;
    const n = counts.get(key) ?? 0;
    if (n >= MAX_TASKS_PER_KIND_PER_FILE) continue;
    counts.set(key, n + 1);
    out.push(f);
  }
  return out;
}

export interface ScanResult {
  filesAnalyzed: number;
  findings: number;
  newTasks: number;
  alreadyQueued: number;
  skippedProtected: number;
}

let lastScanAt: Date | null = null;

/**
 * Scan the system's own source and persist new tasks.
 * This is the system DEFINING ITS INPUT — the core act.
 */
export async function generateTasks(): Promise<ScanResult> {
  const files = listOwnSourceFiles();
  const allFindings: Finding[] = [];

  // Count protected files for transparency
  let protectedCount = 0;
  const scanAll = (dir: string, wantTsx: boolean) => {
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) scanAll(full, wantTsx);
      else if (
        (entry.name.endsWith(".ts") || (wantTsx && entry.name.endsWith(".tsx"))) &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".test.tsx")
      ) {
        if (isProtectedPath(relative(PROJECT_ROOT, full))) protectedCount++;
      }
    }
  };
  scanAll(PIPELINE_SRC_DIR, false);
  // AUDIT 8 (round 2): one src/app scan covers display + api + page
  // surface; src/components excluded (operator directive).
  scanAll(APP_SRC_DIR, true);

  for (const file of files) {
    try {
      allFindings.push(...analyzeFile(file));
    } catch {
      /* unreadable file — skip */
    }
  }

  const capped = capPerKind(allFindings);
  let newTasks = 0;
  let alreadyQueued = 0;

  // Don't flood: check current pending count
  const pendingCount = await db.selfTask.count({ where: { status: { in: ["pending", "in_progress"] } } });
  let budget = Math.max(0, MAX_PENDING_TOTAL - pendingCount);

  for (const f of capped) {
    if (budget <= 0) break;
    const existing = await db.selfTask.findUnique({
      where: { kind_filePath_line: { kind: f.kind, filePath: f.filePath, line: f.line } },
    });
    if (existing && ["pending", "in_progress", "done", "skipped"].includes(existing.status)) {
      alreadyQueued++;
      continue;
    }
    if (existing && existing.status === "failed" && existing.attempts >= 3) {
      alreadyQueued++; // give up permanently on this one
      continue;
    }
    await db.selfTask.upsert({
      where: { kind_filePath_line: { kind: f.kind, filePath: f.filePath, line: f.line } },
      update: { status: "pending", evidence: f.evidence }, // retry failed
      create: {
        kind: f.kind,
        filePath: f.filePath,
        line: f.line,
        evidence: f.evidence,
        priority: TASK_KINDS[f.kind].priority,
      },
    });
    newTasks++;
    budget--;
  }

  lastScanAt = new Date();
  return {
    filesAnalyzed: files.length,
    findings: capped.length,
    newTasks,
    alreadyQueued,
    skippedProtected: protectedCount,
  };
}

export interface QueueCounts {
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
  skipped: number;
  lastScanAt: string | null;
  [key: string]: number | string | null;
}

/** Queue counts by status. */
export async function getQueueStats(): Promise<QueueCounts> {
  const grouped = await db.selfTask.groupBy({ by: ["status"], _count: true });
  const stats: QueueCounts = {
    pending: 0,
    in_progress: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    lastScanAt: lastScanAt?.toISOString() ?? null,
  };
  for (const g of grouped) {
    stats[g.status] = typeof g._count === "number" ? g._count : 0;
  }
  return stats;
}

/** List tasks (most recent first within status). */
export async function listTasks(status?: string, limit = 30) {
  return db.selfTask.findMany({
    where: status ? { status } : undefined,
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: Math.min(limit, 100),
  });
}

/** The claim ordering/filter, in ONE place (cripple-check F18: the
 *  scripts/test-claim.ts debug tool used to hand-duplicate this query —
 *  if the ordering or filters changed, the script drifted silently and
 *  misled whoever was debugging). Both claimNextTask and peekNextTask
 *  derive from this, so they can never disagree. */
function taskClaimQuery(onlyDeterministic: boolean) {
  return {
    where: onlyDeterministic
      ? { status: "pending" as const, kind: { in: ["missing-return-type", "unused-import"] } }
      : { status: "pending" as const },
    orderBy: [
      { priority: "asc" as const },
      { deferred: "asc" as const },
      { createdAt: "asc" as const },
    ],
  };
}

/** Pull the next pending task. Ordering: priority asc, then `deferred` asc,
 * then createdAt asc. The `deferred` ordering is the DEFER-ROTATION fix:
 * when a task is deferred (LLM 429), its `deferred` counter increments and
 * it sinks to the BACK of its priority bucket. Next cycle, a fresh task
 * with `deferred: 0` wins instead — the loop rotates through the queue
 * rather than hammering the same task against the same 429 every cycle.
 * `onlyDeterministic` restricts claiming to checker-inferred fix kinds — used
 * when the LLM is rate-limited so the loop still has executable work. */
export async function claimNextTask(onlyDeterministic = false) {
  const next = await db.selfTask.findFirst(taskClaimQuery(onlyDeterministic));
  if (!next) return null;
  return db.selfTask.update({
    where: { id: next.id },
    data: { status: "in_progress", attempts: { increment: 1 } },
  });
}

/** Side-effect-free PEEK at the same winner claimNextTask would pick —
 *  same query object (taskClaimQuery), no status mutation. Used by the
 *  scripts/test-claim.ts debug tool. */
export async function peekNextTask(onlyDeterministic = false) {
  return db.selfTask.findFirst(taskClaimQuery(onlyDeterministic));
}

export function getTaskMethod(kind: string): "deterministic" | "llm" {
  return (TASK_KINDS[kind as TaskKind] ?? TASK_KINDS["magic-number"]).method;
}

export function getLastScanAt(): Date | null {
  return lastScanAt;
}
