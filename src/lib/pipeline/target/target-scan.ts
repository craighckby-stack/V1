/**
 * Target Scanner — static analysis for EXTERNAL target repositories.
 *
 * This is the target-mode sibling of autonomous/self-task-generator.ts:
 * where the self-loop scans ITS OWN source from disk, target mode scans a
 * file fetched from a foreign GitHub repo (via the GitHub Contents API).
 * The detectors are deliberately the SAME issue classes (todo-comment,
 * empty-catch, any-usage, missing-return-type, unused-import, magic-number,
 * non-null-assertion) so a target mutation goes through the exact gate
 * chain the self-mutation path uses — no weaker treatment for foreign code.
 *
 * This module is PURE: no fs, no db, no network. It takes (path, text)
 * and returns findings. The runner (target-runner.ts) owns fetching.
 *
 * Scope guard: isMutableTargetPath() filters what may even be PROPOSED.
 * It reuses isProtectedPath — the loop's own control-surface path names
 * are off-limits even in a foreign repo's namespace. This is defense in
 * depth: the mutation guard would reject those paths anyway at gate time
 * (same predicate), so skipping them at scan time just saves LLM quota
 * and keeps the "never queues work it refuses to do" invariant.
 *
 * Test files (*.test.*, *.spec.*, __tests__) are excluded: without the
 * target's dependency tree we cannot run its tests, and the structural
 * gate exists partly to stop test deletion — silently rewriting foreign
 * tests we cannot execute is exactly the "garbage commit" failure mode
 * that killed the original external-repo pipeline (DIRECTIONS.md
 * Direction 3's warning). Excluded, not gated.
 */

import * as ts from "typescript";
import { isProtectedPath } from "../autonomous/protected-files";

export type TargetTaskKind =
  | "todo-comment"
  | "empty-catch"
  | "any-usage"
  | "missing-return-type"
  | "unused-import"
  | "magic-number"
  | "non-null-assertion";

/** Same priorities as self-task-generator's TASK_KINDS (1 = most urgent). */
export const TARGET_KIND_PRIORITY: Record<TargetTaskKind, number> = {
  "todo-comment": 1,
  "empty-catch": 2,
  "any-usage": 3,
  "missing-return-type": 4,
  "unused-import": 4,
  "magic-number": 5,
  "non-null-assertion": 6,
};

export interface TargetFinding {
  kind: TargetTaskKind;
  /** 1-based line number. */
  line: number;
  /** Trimmed source line (evidence), capped at 160 chars. */
  evidence: string;
}

/** Only extensions the TS compiler API can analyze (the AST gates are
 *  TypeScript-parser-based; analyzing a Python file with them is
 *  meaningless). JSON/MD/PY/GO etc. are out of scope for target mode. */
const CODE_EXT_REGEX = /\.(ts|tsx|js|jsx)$/i;

/** Directories never worth probing in a foreign repo. */
const IGNORED_DIR_SEGMENT_REGEX =
  /^(node_modules|\.git|\.next|dist|build|coverage|vendor|__tests__|__mocks__|\.loop-sandbox)$/i;

/** Max findings per kind per file — same balancing cap as the self scan. */
const MAX_FINDINGS_PER_KIND = 5;

/** Cap on a single file we will propose (bytes). The Contents API and
 *  the LLM context window both degrade past this; the self-loop has an
 *  equivalent deterministic skip. */
export const MAX_TARGET_FILE_BYTES = 100_000;

/** Is this numeric literal "magic"? (Ported from self-task-generator:
 *  excludes 0/1/2/-1, enum members, and declaration initializers — those
 *  already have names.) */
function isMagicNumber(node: ts.NumericLiteral): boolean {
  const value = Number(node.text);
  if ([0, 1, 2, -1].includes(value)) return false;

  const parent = node.parent;
  if (!parent) return false;
  if (ts.isEnumMember(parent)) return false;
  if (
    (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) &&
    parent.initializer === node
  ) {
    return false;
  }
  return true;
}

/** Line number (1-based) for a position in a parsed source file. */
function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Right ScriptKind per extension — .tsx needs TSX or the parser fails
 *  on JSX syntax (same handling as the self scanner). */
function scriptKindFor(relPath: string): ts.ScriptKind {
  if (relPath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (relPath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

/**
 * Analyze one fetched file's content → findings. Pure static analysis,
 * no LLM, no I/O. `relPath` is the target-repo-relative path (used only
 * for script-kind detection and evidence lines).
 */
export function scanTargetContent(relPath: string, text: string): TargetFinding[] {
  const lines = text.split("\n");
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, scriptKindFor(relPath));
  const findings: TargetFinding[] = [];
  const seen = new Set<string>();

  const push = (kind: TargetTaskKind, pos: number) => {
    const line = lineOf(sf, pos);
    const key = `${kind}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    // Safe access using pre-split lines array, ensuring line is valid (>= 1)
    const evidence = (line > 0 && line <= lines.length) ? lines[line - 1].trim().slice(0, 160) : "";
    findings.push({ kind, line, evidence });
  };

  // --- AST Traversal for structured findings ---
  const visit = (node: ts.Node): void => {
    // 2) empty catch blocks
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      push("empty-catch", node.block.getStart());
    }

    // 3) `any` in type positions (annotation, as-expression, type args)
    if (node.kind === ts.SyntaxKind.AnyKeyword && node.parent) {
      const p = node.parent;
      const inTypePosition =
        (p as { type?: ts.Node }).type === node ||
        ts.isAsExpression(p) ||
        ts.isTypeReferenceNode(p) ||
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

    // 4b) unused imports — heuristic: an imported binding name that does
    //     not appear as an identifier elsewhere in the file.
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      const importLineNo = lineOf(sf, node.getStart());
      const bindings: string[] = [];
      if (clause.name) bindings.push(clause.name.text);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          bindings.push(el.name.text);
        }
      }
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        bindings.push(clause.namedBindings.name.text);
      }
      // Optimization: only filter lines *after* the import line.
      const restOfFileLines = lines.slice(importLineNo);
      const restOfFile = restOfFileLines.join("\n");

      for (const b of bindings) {
        // Ensure proper regex escaping for binding names
        const re = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
        if ((restOfFile.match(re) ?? []).length === 0) {
          push("unused-import", node.getStart());
          break;
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

  // --- Line Scan for Comments (Heuristic) ---
  for (let i = 0; i < lines.length; i++) {
    if (/(\/\/|\/\*|\*).*\b(TODO|FIXME|HACK)\b/.test(lines[i])) {
      const lineNum = i + 1;
      const key = `todo-comment:${lineNum}`;
      if (!seen.has(key)) {
        seen.add(key);
        // Safe access guaranteed by loop bounds
        findings.push({
          kind: "todo-comment",
          line: lineNum,
          evidence: lines[i].trim().slice(0, 160),
        });
      }
    }
  }

  return findings;
}

/**
 * May target mode even PROPOSE changes to this path?
 * - Only TS-analyzable source extensions.
 * - Not a test/spec/type-declaration/vendor file.
 * - Not a path that collides with OUR protected control surface
 *   (defense in depth — the mutation guard enforces the same predicate).
 */
export function isMutableTargetPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/").trim();
  if (!p || p.includes("..") || p.startsWith("/")) return false;
  if (!CODE_EXT_REGEX.test(p)) return false;
  const base = p.split("/").pop() ?? "";
  if (base.startsWith(".")) return false;
  if (/\.(test|spec)\.[jt]sx?$/i.test(base)) return false;
  if (/\.d\.ts$/i.test(base)) return false;
  if (/\.(bak|tmp)\./i.test(base) || base.endsWith(".min.js")) return false;
  const segments = p.split("/");
  for (const seg of segments.slice(0, -1)) {
    if (IGNORED_DIR_SEGMENT_REGEX.test(seg)) return false;
  }
  // Shared control-surface collision guard: if this same path in OUR
  // repo is protected (page.tsx, db.ts, pipeline/core/**, api routes…),
  // target mode refuses it too. Cheap, conservative, and it means the
  // mutation guard can never be the first place a proposal dies.
  if (isProtectedPath(p)) return false;
  return true;
}

/**
 * Pick the file+finding to attempt next, deterministically: lowest
 * priority number first, then lowest line. Input is the probe results
 * in tree order (each entry = one fetched file's findings).
 */
export function pickTargetFinding(
  findingsByFile: Array<{ file: string; findings: TargetFinding[] }>
): { file: string; finding: TargetFinding } | null {
  let best: { file: string; finding: TargetFinding } | null = null;
  for (const entry of findingsByFile) {
    // Balance per kind within the file, same cap philosophy as the self scan.
    const counts = new Map<string, number>();
    const capped = entry.findings.filter((f) => {
      const n = counts.get(f.kind) ?? 0;
      if (n >= MAX_FINDINGS_PER_KIND) return false;
      counts.set(f.kind, n + 1);
      return true;
    });
    for (const f of capped) {
      const fPriority = TARGET_KIND_PRIORITY[f.kind];
      const bestPriority = best?.finding.kind ? TARGET_KIND_PRIORITY[best.finding.kind] : Infinity;

      if (
        !best ||
        fPriority < bestPriority ||
        (fPriority === bestPriority && f.line < best.finding.line)
      ) {
        best = { file: entry.file, finding: f };
      }
    }
  }
  return best;
}