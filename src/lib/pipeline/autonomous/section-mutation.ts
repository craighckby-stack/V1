/**
 * Section-scoped mutation — the large-file leg of the self-enhance loop.
 *
 * WHY THIS MODULE EXISTS
 * enhanceFile's whole-file mutation asks the LLM to RE-EMIT the entire file.
 * Output-token physics (not input context) is the binding constraint: a
 * 12KB file is ~3k output tokens, which reliably fits the provider's
 * output envelope. A 100KB file is ~25k output tokens — it truncates
 * mid-declaration, which is EXACTLY the failure the 12000-byte cap was
 * installed to prevent. Raising the cap naively would just convert
 * "skipped (too large)" into "Rejected (LLM output truncated)" at a much
 * higher LLM-burn rate.
 *
 * The fix is to stop re-emitting the file: for large files the LLM now
 * rewrites ONE AST-extracted SECTION (a top-level statement, or one member
 * of a large class), and the replacement is spliced back into the original
 * by byte offset. Properties of this construction:
 *
 *   - The LLM's output stays inside the proven ≤~12KB envelope (sections
 *     are capped at SECTION_MAX_BYTES; replacements at 1.5x that).
 *   - 95%+ of the assembled file is byte-identical to the original BY
 *     CONSTRUCTION — every export, import and untouched section survives
 *     mechanically, not by LLM discipline. The structural/AST-diff gates
 *     still run on the assembled file and verify it.
 *   - The input side (imports list + file outline + section text) is a
 *     few KB — the LLM sees the file's true shape without its full bulk.
 *
 * REACH: 155 pipeline/mini-service files sat over the old 12KB ceiling,
 * including loop-runtime.ts (103KB) and self-enhance-loop.ts (230KB) —
 * the loop's own core was permanently outside its own mutation surface.
 * With section mode the ceiling is 256KB (the largest file in the repo is
 * 230KB), a 21x reach expansion, with the SAME gate chain running on the
 * assembled result: mutation-guard → structural → ast-diff → syntax →
 * lint → typecheck, then debate + sandbox test gate in the caller.
 *
 * Splice boundaries use [node.getStart(), node.end) — the node's own text
 * span. Leading comments/whitespace BEFORE the node are outside the span
 * and survive byte-identically; trailing trivia belongs to the next node's
 * span. The replacement arrives at the section's own indentation because
 * the prompt shows the section exactly as it appears in the file.
 */

import * as ts from "typescript";
import { scriptKindForPath } from "./code-analysis";

// ── Ceilings (shared contract with self-enhance-loop.ts) ─────────────
/** Files at or under this size use the whole-file path (unchanged). */
export const WHOLE_FILE_MAX_BYTES = 12_000;
/** Files at or under this size are eligible for section-scoped mutation.
 * The largest file in the repo (self-enhance-loop.ts) is ~230KB; this
 * leaves headroom while bounding AST/typecheck cost per candidate. */
export const SECTION_MUTATION_MAX_FILE_BYTES = 256_000;
/** Sections smaller than this are not worth an LLM call (quota guard —
 * mirrors the 80-byte whole-file floor's rationale at section scale). */
export const SECTION_MIN_BYTES = 300;
/** Sections larger than this exceed the proven LLM output envelope. */
export const SECTION_MAX_BYTES = 10_000;
/** The replacement may grow beyond the original section (fixes often add
 * guards), but not without bound — a 1.5x budget keeps the output inside
 * the proven ~12KB whole-file envelope from either direction. */
export const SECTION_BUDGET_MULTIPLIER = 1.5;

/** Outline lines are one per symbol; beyond this the outline is capped
 * with an honest "(+N more)" marker (the TARGET section is always
 * force-included even past the cap). */
const MAX_OUTLINE_ENTRIES = 120;
/** The imports block is embedded verbatim in the prompt; capped so a file
 * with dozens of imports can't eat the context budget. */
const MAX_IMPORT_BLOCK_BYTES = 3_000;

// ── Types ──────────────────────────────────────────────────────────────

export interface CodeSection {
  /** Dotted name: "parseFoo", "SelfEnhanceLoop.enhanceFile", or
   * "DefensePanel.useEffect@L120" for statements inside an oversized
   * function body. */
  name: string;
  /** "function" | "method" | "constructor" | "property" | "getter" |
   * "setter" | "class" | "const" | "interface" | "type" | "enum" |
   * "namespace" | "statement" | "arrow-fn" | "call" | "if" | "return" |
   * "loop" | "try" | "switch" | "block". */
  kind: string;
  /** Owning class or function for nested sections (class members and
   * oversized-function body statements); null for top-level sections. */
  parentClass: string | null;
  /** Byte offset of the node's first token (getStart — excludes leading
   * comments/whitespace, which survive the splice byte-identically). */
  start: number;
  /** Byte offset one past the node's last token (node.end). */
  end: number;
  bytes: number;
  /** The node's own text [start, end) — what the LLM is shown. */
  text: string;
  /** Top-level: has an `export` modifier. Nested: the owner (class or
   * function) is exported — pinning flows through the module exports. */
  exported: boolean;
}

export interface SectionMutationPlan {
  section: CodeSection;
  /** The file's import statements, joined (capped). */
  imports: string;
  /** One-line-per-symbol map of the file (capped, target always shown). */
  outline: string;
}

interface OutlineEntry {
  line: number;
  text: string;
  /** Matches the picked section (by name+kind) — force-included + marked. */
  target: boolean;
}

// ── Extraction ─────────────────────────────────────────────────────────

/** Parse the file and enumerate mutation targets + prompt context.
 *
 * Sections are: every top-level statement except imports (when within
 * [SECTION_MIN_BYTES, SECTION_MAX_BYTES]), plus — for a class or function
 * too big to be a section itself — each of its members/body-statements
 * within the same budget. A small class or function is ONE section; a
 * large one's members are independent sections, and an oversized MEMBER
 * (e.g. a 30KB runCycle method) decomposes one level further into its
 * body statements. This is what makes React components (one 15-20KB
 * function) and god-methods reachable: their useEffect blocks, handlers,
 * loops and return-JSX are individually bounded sections.
 *
 * The outline covers ALL top-level symbols (budget-eligible or not) so
 * the LLM knows what else exists — it may call in-scope symbols, but the
 * prompt forbids redefining them. Body-statement outline entries are
 * only added for chunky statements (≥300b) to keep the outline compact. */
export function extractSections(
  code: string,
  filePath: string
): { sections: CodeSection[]; importTexts: string[]; outlineEntries: OutlineEntry[] } {
  const kind = scriptKindForPath(filePath);
  const fileName = filePath.endsWith(".tsx") ? "probe.tsx" : "probe.ts";
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, false, kind);

  const sections: CodeSection[] = [];
  const importTexts: string[] = [];
  const outlineEntries: OutlineEntry[] = [];
  const lineOf = (offset: number): number => sf.getLineAndCharacterOfPosition(offset).line + 1;

  const hasExport = (node: ts.Node): boolean => {
    // `modifiers` exists on the declaration node types, not the base
    // Node — a structural cast keeps this working across TS versions
    // (only the kind is read).
    const mods = (node as { modifiers?: readonly { kind: ts.SyntaxKind }[] }).modifiers;
    return (mods ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  };

  const pushOutline = (line: number, text: string): void => {
    outlineEntries.push({ line, text, target: false });
  };

  const statementName = (stmt: ts.Statement): string | null => {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) return stmt.name.text;
    if (ts.isClassDeclaration(stmt) && stmt.name) return stmt.name.text;
    if (ts.isInterfaceDeclaration(stmt) && stmt.name) return stmt.name.text;
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name) return stmt.name.text;
    if (ts.isEnumDeclaration(stmt) && stmt.name) return stmt.name.text;
    if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) return stmt.name.text;
    if (ts.isVariableStatement(stmt)) {
      if (stmt.declarationList.declarations.length > 0) {
        const first = stmt.declarationList.declarations[0];
        if (first && ts.isIdentifier(first.name)) return first.name.text;
        if (first) return `var@L${first.getStart(sf)}`; // Assuming sf is available in scope for position retrieval
      }
    }
    return null;
  };

  const statementKind = (stmt: ts.Statement): string => {
    if (ts.isFunctionDeclaration(stmt)) return "function";
    if (ts.isClassDeclaration(stmt)) return "class";
    if (ts.isInterfaceDeclaration(stmt)) return "interface";
    if (ts.isTypeAliasDeclaration(stmt)) return "type";
    if (ts.isEnumDeclaration(stmt)) return "enum";
    if (ts.isModuleDeclaration(stmt)) return "namespace";
    if (ts.isVariableStatement(stmt)) return "const";
    return "statement";
  };

  const memberName = (member: ts.ClassElement): string | null => {
    if (ts.isConstructorDeclaration(member)) return "constructor";
    if (
      (ts.isMethodDeclaration(member) ||
        ts.isPropertyDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)) &&
      member.name
    ) {
      return ts.isIdentifier(member.name)
        ? member.name.text
        : member.name.getText(sf);
    }
    return null;
  };

  const memberKind = (member: ts.ClassElement): string => {
    if (ts.isConstructorDeclaration(member)) return "constructor";
    if (ts.isMethodDeclaration(member)) return "method";
    if (ts.isPropertyDeclaration(member)) return "property";
    if (ts.isGetAccessorDeclaration(member)) return "getter";
    if (ts.isSetAccessorDeclaration(member)) return "setter";
    return "member";
  };

  const eligible = (bytes: number): boolean =>
    bytes >= SECTION_MIN_BYTES && bytes <= SECTION_MAX_BYTES;

  /** Label a statement inside a function body (the depth-2 section
   * namespace: hooks, handlers, control flow, return-JSX). Line numbers
   * keep repeated labels (two useEffect blocks) collision-free. */
  const bodyStatementLabel = (
    stmt: ts.Statement
  ): { name: string; kind: string } | null => {
    const at = lineOf(stmt.getStart(sf));
    if (ts.isVariableStatement(stmt)) {
      const declarations = stmt.declarationList.declarations;
      if (declarations.length > 0) {
        const d = declarations[0];
        if (d && ts.isIdentifier(d.name)) {
          return {
            name: d.name.text,
            kind: d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
              ? "arrow-fn"
              : "const",
          };
        }
      }
      return { name: `var@L${at}`, kind: "const" };
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      return { name: stmt.name.text, kind: "function" };
    }
    if (ts.isExpressionStatement(stmt)) {
      const expr = stmt.expression;
      let callee = "";
      if (ts.isCallExpression(expr)) {
        if (ts.isIdentifier(expr.expression)) callee = expr.expression.text;
        else if (
          ts.isPropertyAccessExpression(expr.expression) &&
          ts.isIdentifier(expr.expression.name)
        )
          callee = expr.expression.name.text;
      }
      return { name: callee ? `${callee}@L${at}` : `call@L${at}`, kind: "call" };
    }
    if (ts.isIfStatement(stmt)) return { name: `if@L${at}`, kind: "if" };
    if (ts.isReturnStatement(stmt)) return { name: `return@L${at}`, kind: "return" };
    if (
      ts.isForStatement(stmt) || ts.isForOfStatement(stmt) ||
      ts.isForInStatement(stmt) || ts.isWhileStatement(stmt) ||
      ts.isDoStatement(stmt)
    )
      return { name: `loop@L${at}`, kind: "loop" };
    if (ts.isTryStatement(stmt)) return { name: `try@L${at}`, kind: "try" };
    if (ts.isSwitchStatement(stmt)) return { name: `switch@L${at}`, kind: "switch" };
    if (ts.isBlock(stmt)) return { name: `block@L${at}`, kind: "block" };
    if (ts.isClassDeclaration(stmt) && stmt.name) return { name: stmt.name.text, kind: "class" };
    return null; // labeled/with/ambient — not worth a section
  };

  const pushSection = (
    node: ts.Node,
    name: string,
    kindLabel: string,
    parentClass: string | null,
    exported: boolean
  ): void => {
    const start = node.getStart(sf);
    const end = node.end;
    const bytes = end - start;
    if (!eligible(bytes)) return;
    sections.push({
      name,
      kind: kindLabel,
      parentClass,
      start,
      end,
      bytes,
      text: code.slice(start, end),
      exported,
    });
  };

  /** Add a function-like node as a section — or, when it is too big, add
   * its BODY statements as sections instead (one level deep). Covers
   * oversized functions (React components), oversized methods (god
   * methods like runCycle) and oversized arrow-function consts. */
  const addFunctionLike = (
    node: ts.Node,
    name: string,
    kindLabel: string,
    exported: boolean,
    owner: string | null
  ): void => {
    const start = node.getStart(sf);
    const bytes = node.end - start;
    if (eligible(bytes)) {
      pushSection(node, name, kindLabel, owner, exported);
      return;
    }
    const body =
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) || ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node))
        ? node.body
        : undefined;
    if (!body || !ts.isBlock(body)) return;
    const dottedOwner = owner ? `${owner}.${name}` : name;
    for (const inner of body.statements) {
      const label = bodyStatementLabel(inner);
      if (!label) continue;
      const innerStart = inner.getStart(sf);
      const innerBytes = inner.end - innerStart;
      const innerName = `${dottedOwner}.${label.name}`;
      if (innerBytes >= SECTION_MIN_BYTES) {
        pushOutline(
          lineOf(innerStart),
          `    ${label.kind} ${innerName} (${innerBytes}b)`
        );
      }
      pushSection(inner, innerName, label.kind, dottedOwner, exported);
    }
  };

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      importTexts.push(stmt.getText(sf));
      const spec =
        ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : "";
      pushOutline(lineOf(stmt.getStart(sf)), `import ${spec}`);
      continue;
    }

    if (ts.isClassDeclaration(stmt) && stmt.name) {
      const className = stmt.name.text;
      const exported = hasExport(stmt);
      const start = stmt.getStart(sf);
      const classBytes = stmt.end - start;
      pushOutline(
        lineOf(start),
        `${exported ? "export " : ""}class ${className} (${classBytes}b)`
      );
      if (eligible(classBytes)) {
        // Small class: the whole class is one section.
        pushSection(stmt, className, "class", null, exported);
      } else {
        // Large class: each member is an independent section — and an
        // oversized MEMBER decomposes into its body statements.
        for (const member of stmt.members) {
          const mName = memberName(member);
          if (!mName) continue;
          const mStart = member.getStart(sf);
          const mBytes = member.end - mStart;
          const dotted = `${className}.${mName}`;
          if (mBytes >= SECTION_MIN_BYTES) {
            pushOutline(
              lineOf(mStart),
              `  ${memberKind(member)} ${dotted} (${mBytes}b)`
            );
          }
          addFunctionLike(member, dotted, memberKind(member), exported, className);
        }
      }
      continue;
    }

    const name = statementName(stmt) ?? `statement@L${lineOf(stmt.getStart(sf))}`;
    const kindLabel = statementKind(stmt);
    const exported = hasExport(stmt);
    const start = stmt.getStart(sf);
    const bytes = stmt.end - start;
    pushOutline(
      lineOf(start),
      `${exported ? "export " : ""}${kindLabel} ${name} (${bytes}b)`
    );
    if (
      ts.isFunctionDeclaration(stmt) ||
      (ts.isVariableStatement(stmt) &&
        stmt.declarationList.declarations[0]?.initializer &&
        (ts.isArrowFunction(
          (stmt.declarationList.declarations[0] as ts.VariableDeclaration).initializer as ts.Expression
        ) ||
          ts.isFunctionExpression(
            (stmt.declarationList.declarations[0] as ts.VariableDeclaration).initializer as ts.Expression
          )))
    ) {
      // Function-like top-level: whole section, or body decomposition.
      addFunctionLike(stmt, name, kindLabel, exported, null);
    } else {
      pushSection(stmt, name, kindLabel, null, exported);
    }
  }

  return { sections, importTexts, outlineEntries };
}

// ── Selection ──────────────────────────────────────────────────────────

/** FNV-1a — deterministic seed hash (no DB, no state; the caller varies
 * the seed across cycles via the branch slot + source sha). */
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic uniform pick. Uniform (not size-weighted): every eligible
 * section gets equal rotation — big sections already carry more risk per
 * mutation, and coverage across the file matters more than per-cycle
 * bytes touched. */
export function pickSection(sections: CodeSection[], seed: string): CodeSection | null {
  if (sections.length === 0) return null;
  const idx = hashString(seed) % sections.length;
  return sections[idx] ?? null;
}

// ── Plan assembly ──────────────────────────────────────────────────────

const fmtBytes = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}b`);

/** Build the full section-mutation plan for a file. Returns null when no
 * eligible section exists (caller records an honest skip reason). */
export function planSectionMutation(
  code: string,
  filePath: string,
  seed: string
): SectionMutationPlan | null {
  const { sections, importTexts, outlineEntries } = extractSections(code, filePath);
  const section = pickSection(sections, seed);
  if (!section) return null;

  // Outline: cap the entries, but ALWAYS include the target (marked) —
  // even when the cap would cut it — so the LLM sees where its section
  // lives relative to the file's other symbols.
  const shown: string[] = [];
  let shownCount = 0;
  for (const entry of outlineEntries) {
    const isTarget =
      entry.text.includes(`${section.name} (`) ||
      (section.kind === "class" && entry.text.endsWith(`${section.name} (${section.bytes}b)`));
    if (isTarget) {
      shown.push(`L${entry.line} ${entry.text}  ← TARGET (mutate ONLY this)`);
      continue;
    }
    if (shownCount >= MAX_OUTLINE_ENTRIES) continue;
    shown.push(`L${entry.line} ${entry.text}`);
    shownCount++;
  }
  const omitted = outlineEntries.length - shown.length;
  if (omitted > 0) shown.push(`(+${omitted} more outline entries omitted — file is large)`);
  const outline = shown.join("\n");

  // Imports: verbatim join, capped with an honest marker.
  const joined = importTexts.join("\n");
  const imports =
    joined.length > MAX_IMPORT_BLOCK_BYTES
      ? joined.slice(0, MAX_IMPORT_BLOCK_BYTES) +
        `\n// (+${fmtBytes(joined.length - MAX_IMPORT_BLOCK_BYTES)} of imports truncated)`
      : joined;

  return { section, imports, outline };
}

// ── Splice + replacement guards ────────────────────────────────────────

/** Replace [section.start, section.end) with the LLM's replacement.
 * Everything before/after the span is byte-identical to the original —
 * the splice itself is the mechanical "preserve the other 95%" gate. */
export function spliceSection(original: string, section: CodeSection, replacement: string): string {
  return original.slice(0, section.start) + replacement + original.slice(section.end);
}

/** Replacement budget: keeps the LLM's output inside the proven envelope
 * even when the fix grows the section. */
export function sectionReplacementWithinBudget(replacement: string): boolean {
  return replacement.length <= Math.floor(SECTION_MAX_BYTES * SECTION_BUDGET_MULTIPLIER);
}

/** Cheap whole-file-echo detector: the #1 failure mode of a section prompt
 * is the model ignoring the scope instruction and re-emitting the whole
 * file (or prepending imports). A top-level `import` statement in a
 * section replacement can only be that — imports live OUTSIDE every
 * section span. Catching it here saves the full typecheck cycle. */
export function replacementLooksLikeWholeFile(replacement: string): boolean {
  return /^\s*import[\s{"'/*]/m.test(replacement);
}
