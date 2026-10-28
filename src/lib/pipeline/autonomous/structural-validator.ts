/**
 * Structural validator — the REAL signal beyond typecheck.
 *
 * Typecheck proves the refactored code compiles. It does NOT prove the
 * refactor was safe. An LLM can produce code that compiles but:
 *   - Dropped half the file (truncation)
 *   - Stripped all imports (the file is now dead)
 *   - Removed a top-level export (the public API broke)
 *   - Deleted test cases (the test suite is now weaker)
 *   - Stripped the license header (legal problem)
 *
 * These are the failure modes EMG caught with its validator.ts. This
 * module ports those checks. Each is a structural comparison between
 * the ORIGINAL and the REFACTORED code — no typecheck needed (that's
 * the other gate). Run BEFORE typecheck because it's cheap.
 *
 * Used by verify-refactor.ts as the first gate: if structure is broken,
 * reject without spending 10s on a full tsc run.
 */

export interface StructureIssue {
  code: string;
  message: string;
}

export interface StructureResult {
  ok: boolean;
  issues: StructureIssue[];
}

/**
 * Compare original vs refactored code structurally.
 * Returns ok:false with issues if the refactor is destructive.
 */
export function validateStructure(
  filePath: string,
  originalCode: string,
  refactoredCode: string
): StructureResult {
  const issues: StructureIssue[] = [];

  // Input validation
  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
    return {
      ok: false,
      issues: [{ code: "INVALID_INPUT", message: "filePath must be a non-empty string." }],
    };
  }

  if (!originalCode || typeof originalCode !== 'string') {
    return {
      ok: false,
      issues: [{ code: "INVALID_INPUT", message: "originalCode must be a non-empty string." }],
    };
  }

  if (!refactoredCode || typeof refactoredCode !== 'string') {
    return {
      ok: false,
      issues: [{ code: "INVALID_INPUT", message: "refactoredCode must be a non-empty string." }],
    };
  }

  if (!refactoredCode || !refactoredCode.trim()) {
    return {
      ok: false,
      issues: [{ code: "EMPTY_FILE", message: "Refactored code is empty." }],
    };
  }

  // 1. DESTRUCTIVE TRUNCATION — >30% line drop on files >= 15 lines.
  // Catches LLM output-token-limit truncation.
  const origLines = originalCode.trim().split("\n").length;
  const candLines = refactoredCode.trim().split("\n").length;
  if (origLines >= 15 && candLines < Math.floor(origLines * 0.7)) {
    issues.push({
      code: "DESTRUCTIVE_TRUNCATION",
      message: `Candidate dropped from ${origLines} to ${candLines} lines (${Math.round((1 - candLines / origLines) * 100)}% deletion). Refactoring must preserve the full file.`,
    });
  }

  // 2. IMPORT STRIPPING — imports went from N>=2 to 0.
  // Catches the LLM removing the entire import block.
  const importRe = /^(?:import\s+|from\s+|using\s+[A-Z])/gm;
  const origImports = (originalCode.match(importRe) ?? []).length;
  const candImports = (refactoredCode.match(importRe) ?? []).length;
  if (origImports >= 2 && candImports === 0) {
    issues.push({
      code: "HEADER_STRIPPED",
      message: `Original had ${origImports} imports, candidate has 0. Module imports were wiped out.`,
    });
  }

  // 3. TOP-LEVEL EXPORT PRESERVATION — the real "public API didn't break" signal.
  // Extract the set of top-level exported names from both, compare.
  // An export present in the original but absent in the candidate = broke the API.
  const origExports = extractTopLevelExports(originalCode);
  const candExports = extractTopLevelExports(refactoredCode);
  // Set has no .filter — spread to array first
  const dropped = [...origExports].filter((e) => !candExports.has(e));
  if (dropped.length > 0) {
    issues.push({
      code: "SYMBOL_DROPPED",
      message: `Top-level export(s) dropped: ${dropped.join(", ")}. Public API must be preserved.`,
    });
  }

  // 4. TEST DELETION — in test files, count of test cases must not drop.
  const isTest = /test|spec/i.test(filePath);
  if (isTest) {
    const testRe = /(?:test\s*\(|it\s*\(|describe\s*\(|@pytest\.mark|def\s+test_|func\s+Test[A-Z]|\[Fact\]|\[Test\]|\[Theory\])/g;
    const origTests = (originalCode.match(testRe) ?? []).length;
    const candTests = (refactoredCode.match(testRe) ?? []).length;
    if (origTests >= 1 && candTests < origTests) {
      issues.push({
        code: "TEST_DELETION",
        message: `Original test file had ${origTests} tests, candidate has ${candTests}. Refactoring must never delete test cases.`,
      });
    }
  }

  // 5. LICENSE HEADER STRIPPING — copyright/SPDX in the first 2000 chars of
  // original but missing in candidate.
  const licenseRe = /(?:SPDX-License-Identifier:|Copyright\s+(?:\([cC]\)|©)|Licensed\s+under\s+the|Permission\s+is\s+hereby\s+granted)/i;
  if (licenseRe.test(originalCode.slice(0, 2000)) && !licenseRe.test(refactoredCode.slice(0, 2000))) {
    issues.push({
      code: "LICENSE_STRIPPED",
      message: "Original file contained a license/copyright header; candidate removed it. License headers must be preserved.",
    });
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Extract the set of top-level exported names from a TS/JS source file.
 * Catches `export function X`, `export class X`, `export const X`,
 * `export interface X`, `export type X`, `export { X, Y }`, `export default`.
 * "export default" is included as the literal string "default".
 */
function extractTopLevelExports(code: string): Set<string> {
  const exports = new Set<string>();
  const lines = code.split("\n");
  
  // Cache regex patterns to avoid recompilation
  const exportRe = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
  const exportDefaultRe = /^export\s+default\b/;
  const exportBraceRe = /^export\s*\{([^}]+)\}/;

  for (const line of lines) {
    const trimmed = line.trim();
    
    try {
      const m = trimmed.match(exportRe);
      if (m && m[1]) {
        exports.add(m[1]);
        continue;
      }
      if (exportDefaultRe.test(trimmed)) {
        exports.add("default");
        continue;
      }
      const braceMatch = trimmed.match(exportBraceRe);
      if (braceMatch && braceMatch[1]) {
        for (const name of braceMatch[1].split(",")) {
          const trimmedName = name.trim().split(/\s+as\s+/)[0];
          if (trimmedName) exports.add(trimmedName);
        }
      }
    } catch (error) {
      // Continue processing other lines if one fails
      continue;
    }
  }
  return exports;
}