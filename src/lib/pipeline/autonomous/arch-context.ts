/**
 * Architecture context builder — gives the refactor LLM a "neighborhood
 * map" of the file it's mutating, so it can see the surrounding
 * architecture (its imports' exports + 2-hop neighbors) instead of
 * refactoring a single file in isolation.
 *
 * Why this exists (D1): `enhanceFile` used to hand the LLM ONE file with
 * no awareness of the modules it depends on. A "reasonable cleanup"
 * could rename a helper that 5 other files import — the rename passes
 * the export-preservation gate on THIS file (the local export is
 * preserved) but breaks every consumer. With the neighborhood map in
 * the prompt, the LLM sees "this file's `getMetaInt` is imported by
 * `./meta-tuner`, `./saturation`, `./meta-params`" and can avoid
 * breaking changes (or at least propose them deliberately).
 *
 * Scope is bounded to keep it cheap:
 *   - Parse the TARGET file (always).
 *   - Parse its 1-hop imports (≤ MAX_PARSED_FILES - 1 = 19 files).
 *   - 2-hop is FREE: just read import statements from already-parsed
 *     1-hop files. No new file reads.
 *   - Files larger than LARGE_FILE_BYTES (8000) contribute their
 *     EXPORTS only — their imports are skipped (no 2-hop contribution
 *     from large neighbors). Keeps the parse + read budget predictable.
 *   - Only relative (`./`, `../`) and `@/`-alias imports are followed.
 *     Bare specifiers (`react`, `bun:test`, `@prisma/client`) are
 *     node_modules — skipped. For the 2-hop display, a 1-hop file whose
 *     imports are ALL external is shown as `(external, skipped)` so the
 *     LLM knows it's a leaf in the project graph.
 *
 * Fail-soft contract: any parse / resolution / read error is caught;
 * `buildArchContext` returns an empty summary rather than throwing.
 * The enhanceFile prompt proceeds without architecture context —
 * losing vision is better than losing the whole enhancement cycle.
 *
 * PROTECTED: see protected-files.ts. The loop depends on this module
 * to construct its own prompts — a corrupted version could blind the
 * loop or, worse, inject misleading architecture hints that steer the
 * LLM toward breaking changes (e.g., dropping a "(self)" annotation
 * could hide a circular dependency the LLM would otherwise avoid). The
 * loop itself can never rewrite this.
 *
 * Reuses the existing TS-compiler-API patterns from code-analysis.ts
 * (scriptKindForPath), in-memory-typecheck.ts (ts.createSourceFile),
 * and ast-diff-gate.ts (ts.canHaveModifiers / ts.getModifiers for the
 * modern export-modifier check).
 */

import * as ts from "typescript";
import { readFileSync, existsSync, statSync } from "fs";
import { resolve, join, dirname, relative } from "path";
import { scriptKindForPath } from "./code-analysis";
import { PROJECT_ROOT } from "../core/paths";

/** Total files we'll parse: target + 1-hop. 2-hop is free (no new reads).
 *  20 is the budget named in the design — comfortably under the ratchet's
 *  own ~15s per-file cost, and big enough for any non-barrel module. */
const MAX_PARSED_FILES = 20;
/** Files larger than this contribute EXPORTS only (their imports are
 *  not parsed for the 2-hop list). 8000 bytes ≈ a 200-line file; past
 *  that, parsing imports doubles the work for a file whose job is
 *  probably already obvious from its exports. */
const LARGE_FILE_BYTES = 8000;
/** Hard cap on the summary text — keeps the prompt injection bounded
 *  even for files with 30+ exports or 20+ imports. The enhanceFile
 *  prompt already carries the code block, postmortem constraints,
 *  lessons, etc.; the arch context is a HINT, not a dump. */
const MAX_SUMMARY_CHARS = 1500;
/** Truncation marker for the purpose-guess line (one-line JSDoc / first
 *  comment line). 80 chars ≈ a meaningful one-liner, no longer. */
const MAX_PURPOSE_CHARS = 80;
/** Cap on the number of export names listed inline on the EXPORTS line.
 *  Past this, the rest are summarized as `... (+N more)` so the line
 *  doesn't blow the budget on barrel files. */
const MAX_EXPORTS_INLINE = 30;

export interface ArchContext {
  /** Compact text block for injection into the enhanceFile prompt.
   *  Empty string = build failed or no usable data; caller should
   *  skip injection (fail-soft). */
  summary: string;
  /** How deep the map actually goes: 0 = nothing parsed, 1 = target
   *  only (no resolvable 1-hop), 2 = target + at least one 1-hop file
   *  (2-hop is implicit because 2-hop is just reading imports from
   *  already-parsed 1-hop files). */
  hopCount: number;
  /** Total files parsed (target + 1-hop). Bounded by MAX_PARSED_FILES. */
  fileCount: number;
}

// ─────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────

/** Build the architecture context for a file. Wraps the inner builder
 *  in a try/catch so a parser / resolver / read error never escapes —
 *  the enhanceFile prompt must be able to proceed without arch
 *  context (fail-soft). Returns an empty summary on any failure. */
export function buildArchContext(filePath: string): ArchContext {
  try {
    return buildArchContextInner(filePath);
  } catch {
    // Fail-soft: any unexpected error → empty summary. The caller
    // checks `summary.length > 0` before injecting.
    return { summary: "", hopCount: 0, fileCount: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Inner builder (may throw; the public wrapper catches)
// ─────────────────────────────────────────────────────────────────────

interface OneHop {
  /** The import specifier AS WRITTEN in the target file (e.g.
   *  `./protected-files`, `@/lib/db`). The LLM sees the same string
   *  it would type, not a resolved path. */
  spec: string;
  /** Absolute path on disk (used for dedup + rel-path display). */
  resolvedAbs: string;
  /** Names imported from this module (default + named + namespace). */
  names: string[];
  /** This module's top-level exports (for the LLM to know what's
   *  available to use / what would break if renamed). */
  exports: string[];
  /** One-line purpose guess from the module's leading JSDoc/comment,
   *  or "" if none found. */
  purpose: string;
  /** This module's PROJECT imports (relative / @/) for the 2-hop
   *  display. `null` = skipped (large file OR parse failed mid-way). */
  twoHopSpecs: string[] | null;
  /** True if this 1-hop file had ANY external (non-project) imports.
   *  Used to distinguish `(external, skipped)` from `(none)` in the
   *  2-hop display. */
  hadExternalImports: boolean;
}

function buildArchContextInner(filePath: string): ArchContext {
  // Resolve to absolute; bail if missing or not a file.
  const absTarget = resolve(filePath);
  if (!existsSync(absTarget) || !statSync(absTarget).isFile()) {
    return { summary: "", hopCount: 0, fileCount: 0 };
  }

  // Parse the target.
  const targetContent = readFileSync(absTarget, "utf-8");
  const targetSf = parseSafe(targetContent, absTarget);
  if (!targetSf) {
    return { summary: "", hopCount: 0, fileCount: 0 };
  }

  const targetRel = relPathForDisplay(absTarget);
  const targetExports = extractExportsFromAST(targetSf);
  const targetImports = extractImportsFromAST(targetSf);

  // Parse 1-hop files (resolvable project imports only). The budget
  // leaves room for the target (already parsed).
  const oneHopBudget = MAX_PARSED_FILES - 1;
  const oneHops: OneHop[] = [];
  const seen1Hop = new Set<string>();

  for (const imp of targetImports) {
    if (oneHops.length >= oneHopBudget) break;
    if (!isProjectImport(imp.module)) continue;
    const resolved = resolveModule(imp.module, absTarget);
    if (!resolved) continue;
    // Dedup by resolved absolute path (the same module can be imported
    // twice with different specifiers — e.g. `./foo` and `@/lib/foo`).
    if (seen1Hop.has(resolved)) continue;
    seen1Hop.add(resolved);

    let content: string;
    try {
      content = readFileSync(resolved, "utf-8");
    } catch {
      // Unreadable file — skip silently (fail-soft).
      continue;
    }
    const sf = parseSafe(content, resolved);
    if (!sf) continue;

    const exports = extractExportsFromAST(sf);
    const purpose = extractPurposeGuess(content, sf);

    // Skip 2-hop parsing for large files (budget guard).
    let twoHopSpecs: string[] | null;
    let hadExternalImports = false;
    if (content.length > LARGE_FILE_BYTES) {
      twoHopSpecs = null;
    } else {
      const allImports = extractImportsFromAST(sf);
      hadExternalImports = allImports.some((i) => !isProjectImport(i.module));
      const projectSpecs = allImports
        .map((i) => i.module)
        .filter(isProjectImport);
      twoHopSpecs = [...new Set(projectSpecs)];
    }

    oneHops.push({
      spec: imp.module,
      resolvedAbs: resolved,
      names: imp.names,
      exports,
      purpose,
      twoHopSpecs,
      hadExternalImports,
    });
  }

  const fileCount = 1 + oneHops.length;
  const hopCount = oneHops.length > 0 ? 2 : targetImports.length > 0 || targetExports.length > 0 ? 1 : 0;
  const summary = buildSummary(targetRel, targetExports, oneHops);

  return { summary, hopCount, fileCount };
}

// ─────────────────────────────────────────────────────────────────────
// Parsing + AST extraction helpers
// ─────────────────────────────────────────────────────────────────────

/** Parse a source file with the TS compiler API. Returns null on a
 *  parse exception (fail-soft). ScriptKind follows the file extension
 *  (TS / TSX / JS / JSX) — same pattern as in-memory-typecheck.ts. */
function parseSafe(content: string, absPath: string): ts.SourceFile | null {
  try {
    return ts.createSourceFile(
      absPath,
      content,
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
      scriptKindForPath(absPath)
    );
  } catch {
    return null;
  }
}

/** Project-relative POSIX path for display (matches the format used
 *  throughout the loop — e.g. `src/lib/pipeline/autonomous/saturation.ts`). */
function relPathForDisplay(absPath: string): string {
  const rel = relative(PROJECT_ROOT, absPath);
  return rel.replace(/\\/g, "/");
}

/** Is this import specifier a project import (relative or @/ alias)?
 *  Bare specifiers (`react`, `bun:test`, `@prisma/client`) are
 *  node_modules and are skipped — they have no useful project-level
 *  architecture hint. */
function isProjectImport(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("@/");
}

/** Resolve a relative or @/-alias import specifier to an absolute file
 *  path. Tries the literal path, then with TS/JS extensions, then as a
 *  directory with an index file (mirrors `moduleResolution: bundler`).
 *  Returns null if unresolvable (caller skips silently). */
function resolveModule(spec: string, fromFile: string): string | null {
  let basePath: string;
  if (spec.startsWith("@/")) {
    // tsconfig paths: "@/*" → "./src/*"
    basePath = join(PROJECT_ROOT, "src", spec.slice(2));
  } else {
    basePath = resolve(dirname(fromFile), spec);
  }

  // Direct file (spec may already have an extension, or be exact).
  if (isFile(basePath)) return basePath;
  // With common TS/JS extensions.
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
    const p = basePath + ext;
    if (isFile(p)) return p;
  }
  // As a directory with an index file (bundler resolution).
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const p = join(basePath, `index${ext}`);
    if (isFile(p)) return p;
  }
  return null;
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Walk the AST and collect top-level export names: functions, classes,
 *  interfaces, type aliases, enums, variable statements, re-exports
 *  (`export { foo, bar as baz }`), and `export default`. Uses the
 *  modern `ts.canHaveModifiers` / `ts.getModifiers` pattern (matches
 *  ast-diff-gate.ts) so the check is forward-compatible with future
 *  TS versions where `node.modifiers` may be removed. */
function extractExportsFromAST(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (n: string) => {
    if (n && !seen.has(n)) {
      seen.add(n);
      names.push(n);
    }
  };

  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      // `export { foo, bar as baz } [from '...']`
      // Use the EXPORTED (aliased) name — that's what consumers import.
      // (`export { bar as baz }` → consumers `import { baz }`, not `bar`.)
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          add(el.name.text);
        }
      }
      // `export * from '...'` — no named symbol to add (wildcard).
    } else if (ts.isExportAssignment(stmt)) {
      // `export default X` — note as "default" so the LLM knows there
      // is a default export (consumers `import X from "..."`).
      add("default");
    } else {
      // Any statement with an `export` modifier: function / class /
      // interface / type / enum / variable.
      if (hasExportModifier(stmt)) {
        if (ts.isVariableStatement(stmt)) {
          for (const d of stmt.declarationList.declarations) {
            if (ts.isIdentifier(d.name)) add(d.name.text);
            // Destructuring exports (`export const { a, b } = obj`) are
            // rare in this codebase — skipped. The regex-based
            // extractExports in self-enhance-loop.ts misses them too;
            // staying consistent avoids surprising the LLM with
            // different export lists from the two paths.
          }
        } else if (
          ts.isFunctionDeclaration(stmt) ||
          ts.isClassDeclaration(stmt) ||
          ts.isInterfaceDeclaration(stmt) ||
          ts.isTypeAliasDeclaration(stmt) ||
          ts.isEnumDeclaration(stmt)
        ) {
          if (stmt.name) add(stmt.name.text);
        }
      }
    }
  }
  return names;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

interface ImportInfo {
  /** The module specifier as written (e.g. `./foo`, `@/lib/db`, `react`). */
  module: string;
  /** Names imported: default import's local name, named imports' local
   *  names, or `* as N` for namespace imports. For dynamic imports, the
   *  destructured names (if detected) — empty if not. */
  names: string[];
}

/** Walk the AST and collect both STATIC and DYNAMIC import declarations.
 *  Static: `import X from "..."`, `import { a, b as c } from "..."`,
 *  `import * as N from "..."`, `import "..."` (side-effect).
 *  Dynamic: `await import("...")` — names extracted from a destructuring
 *  pattern in the enclosing `const { a, b } = await import("...")` if
 *  present, otherwise empty (the LLM still sees the module path).
 *  Dedup by module specifier (keeping the first occurrence's names —
 *  the typical case is one import per module; a second import is
 *  usually a type-only re-import and the names already cover it). */
function extractImportsFromAST(sf: ts.SourceFile): ImportInfo[] {
  const out: ImportInfo[] = [];
  const seen = new Set<string>();

  const push = (mod: string, names: string[]) => {
    if (seen.has(mod)) return;
    seen.add(mod);
    out.push({ module: mod, names });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      push(node.moduleSpecifier.text, extractStaticImportNames(node));
      return; // don't descend — the import clause is already captured
    }
    if (isDynamicImportCall(node)) {
      const mod = (node.arguments[0] as ts.StringLiteral).text;
      push(mod, findDynamicImportNames(node));
      // Still descend: a dynamic import inside an ExpressionStatement
      // has no children we care about, but be safe.
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return out;
}

function extractStaticImportNames(decl: ts.ImportDeclaration): string[] {
  const names: string[] = [];
  const clause = decl.importClause;
  if (!clause) return names; // side-effect import: `import "mod";`
  // Default: `import X from "mod"`
  if (clause.name) names.push(clause.name.text);
  // Named / namespace
  const nb = clause.namedBindings;
  if (nb) {
    if (ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        // Local name (el.name) — that's what the importing file
        // references. `import { bar as baz }` → push `baz`.
        names.push(el.name.text);
      }
    } else if (ts.isNamespaceImport(nb)) {
      names.push(`* as ${nb.name.text}`);
    }
  }
  return names;
}

function isDynamicImportCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length >= 1 &&
    ts.isStringLiteral(node.arguments[0])
  );
}

/** Try to recover the destructured names from a dynamic import's
 *  enclosing `const { a, b } = await import("...")` pattern, or the
 *  accessed name from `(await import("...")).foo`. Returns [] if the
 *  pattern can't be statically detected. Parent pointers are set
 *  because parseSafe uses `setParentNodes: true`. */
function findDynamicImportNames(call: ts.CallExpression): string[] {
  let n: ts.Node | undefined = call.parent;
  // Unwrap `await import(...)` → walk up through AwaitExpression.
  if (n && ts.isAwaitExpression(n)) n = n.parent;
  if (!n) return [];
  // `const { a, b } = await import("...")` — names from binding pattern.
  if (ts.isVariableDeclaration(n)) {
    return extractBindingNames(n.name);
  }
  // `(await import("...")).foo` — single accessed name.
  if (ts.isPropertyAccessExpression(n)) {
    return [n.name.text];
  }
  return [];
}

function extractBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isObjectBindingPattern(name)) {
    const out: string[] = [];
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) out.push(...extractBindingNames(el.name));
    }
    return out;
  }
  if (ts.isArrayBindingPattern(name)) {
    const out: string[] = [];
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) out.push(...extractBindingNames(el.name));
    }
    return out;
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────
// Purpose-guess extraction (one-line module description from leading
// comment / JSDoc)
// ─────────────────────────────────────────────────────────────────────

/** Extract a one-line purpose guess from the file's leading comment
 *  block (top-of-file JSDoc `/** ... *\/` or line/block comment).
 *  Returns "" if no comment is found.
 *
 *  Heuristic: the FIRST block comment immediately preceding the first
 *  statement of the file is almost always the module's purpose
 *  description. We take the first non-trivial line (skip `@param` /
 *  `@returns` tags, `audit-N` markers, empty JSDoc continuation lines).
 *  If only line comments (`//`) lead, take the first one. */
function extractPurposeGuess(source: string, sf: ts.SourceFile): string {
  if (sf.statements.length === 0) return "";
  const first = sf.statements[0];
  const ranges = ts.getLeadingCommentRanges(source, first.getFullStart());
  if (!ranges || ranges.length === 0) return "";

  // Prefer a block comment (`/**` or `/*`); fall back to the first
  // line comment (`//`) if no block comment leads.
  let blockRange: ts.CommentRange | null = null;
  let lineRange: ts.CommentRange | null = null;
  for (const r of ranges) {
    const text = source.slice(r.pos, r.end);
    if (text.startsWith("/**") || text.startsWith("/*")) {
      blockRange = r;
      break;
    }
    if (text.startsWith("//") && !lineRange) lineRange = r;
  }
  const range = blockRange ?? lineRange;
  if (!range) return "";

  const text = source.slice(range.pos, range.end);
  const lines = parseCommentLines(text);
  if (lines.length === 0) return "";
  return lines[0].slice(0, MAX_PURPOSE_CHARS);
}

function parseCommentLines(text: string): string[] {
  let body: string;
  if (text.startsWith("/**")) {
    body = text.replace(/^\/\*\*/, "").replace(/\*\/\s*$/, "");
  } else if (text.startsWith("/*")) {
    body = text.replace(/^\/\*/, "").replace(/\*\/\s*$/, "");
  } else {
    // Line comment(s): `// foo\n// bar` — strip leading `//` per line.
    return text
      .split("\n")
      .map((l) => l.replace(/^\s*\/\//, "").trim())
      .filter(Boolean);
  }

  return body
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, "").trim())
    .filter((l) => {
      if (l.length === 0) return false;
      // Skip JSDoc tags (`@param`, `@returns`, etc.) — they're metadata,
      // not the one-line purpose.
      if (l.startsWith("@")) return false;
      // Skip audit markers (audit-2, audit 3) — they're provenance notes,
      // not purpose. The first CONTENT line is what we want.
      if (/^audit[- ]/i.test(l)) return false;
      return true;
    });
}

// ─────────────────────────────────────────────────────────────────────
// Summary text builder
// ─────────────────────────────────────────────────────────────────────

function buildSummary(
  targetRel: string,
  targetExports: string[],
  oneHops: OneHop[]
): string {
  const lines: string[] = [];
  lines.push("=== ARCHITECTURE CONTEXT (2-hop neighborhood) ===");
  lines.push(`TARGET: ${targetRel}`);

  // EXPORTS line: comma-separated, capped at MAX_EXPORTS_INLINE.
  if (targetExports.length === 0) {
    lines.push("EXPORTS: (none)");
  } else if (targetExports.length <= MAX_EXPORTS_INLINE) {
    lines.push(`EXPORTS: ${targetExports.join(", ")}`);
  } else {
    const shown = targetExports.slice(0, MAX_EXPORTS_INLINE).join(", ");
    lines.push(`EXPORTS: ${shown}, ... (+${targetExports.length - MAX_EXPORTS_INLINE} more)`);
  }
  lines.push("");

  // 1-HOP IMPORTS — names + purpose guess.
  lines.push("1-HOP IMPORTS:");
  if (oneHops.length === 0) {
    lines.push("  (no resolvable project imports)");
  } else {
    for (const h of oneHops) {
      const names = h.names.length > 0 ? h.names.join(", ") : "(no named imports)";
      const purpose = h.purpose ? `: ${h.purpose}` : "";
      lines.push(`  ← ${h.spec} (${names})${purpose}`);
    }
  }
  lines.push("");

  // 2-HOP IMPORTS (compact) — just module paths + imported names.
  lines.push("2-HOP IMPORTS (compact):");
  let anyTwoHop = false;
  for (const h of oneHops) {
    if (h.twoHopSpecs === null) {
      // Large file — we skipped parsing its imports. Note it so the
      // LLM understands why no 2-hop data is shown for this neighbor.
      lines.push(`  ${h.spec} → (large file, imports skipped)`);
      anyTwoHop = true;
      continue;
    }
    if (h.twoHopSpecs.length === 0) {
      // No project imports — distinguish "leaf with external deps"
      // from "leaf with no deps".
      if (h.hadExternalImports) {
        lines.push(`  ${h.spec} → (external, skipped)`);
      } else {
        lines.push(`  ${h.spec} → (none)`);
      }
      anyTwoHop = true;
      continue;
    }
    const annotated = h.twoHopSpecs.map((s) => annotateSelfRef(s, h.resolvedAbs, targetRel));
    lines.push(`  ${h.spec} → ${annotated.join(", ")}`);
    anyTwoHop = true;
  }
  if (!anyTwoHop) {
    lines.push("  (no 2-hop data — 1-hop files have no project imports or were skipped)");
  }

  let summary = lines.join("\n");
  // Hard cap — truncate with a marker rather than letting the block
  // blow the prompt budget on barrel files or modules with 50+ exports.
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = summary.slice(0, MAX_SUMMARY_CHARS - 30) + "\n... (truncated)";
  }
  return summary;
}

/** Mark a 2-hop specifier that resolves BACK to the TARGET file (a
 *  circular-ish dependency: target → 1-hop → target). This is rare but
 *  architecturally significant — the LLM should know the target is
 *  reachable from its own neighbor. */
function annotateSelfRef(spec: string, fromAbs: string, targetRel: string): string {
  const resolved = resolveModule(spec, fromAbs);
  if (!resolved) return spec;
  const rel = relPathForDisplay(resolved);
  return rel === targetRel ? `${spec} (self)` : spec;
}
