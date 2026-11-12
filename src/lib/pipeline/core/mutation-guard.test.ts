import { describe, test, expect } from "bun:test";
import {
  detectConvergentMove,
  finalAuthority,
  gateMutation,
} from "./mutation-guard";

/**
 * Characterization tests for the convergent-move detector.
 *
 * The detector identifies the loop's most common self-justifying no-op:
 * a small, predominantly-additive diff, dominated by defensive-guard
 * lexicon, with no behavioral signal. Each test below pins one branch
 * of the four-condition heuristic + a regression suite of REAL diffs
 * sampled from the loop's own commit history (the exact patterns the
 * guard was written to catch).
 *
 * This file lives in src/lib/pipeline/core/ — a PROTECTED_PREFIX — so the
 * loop can never weaken its own characterization tests. The TEST-ATTACKER
 * will run against this file; any mutation of the guard that would let a
 * convergent move through should break at least one test below.
 */
describe("detectConvergentMove", () => {
  // ── Condition 0: no diff ──────────────────────────────────────────

  test("returns not-convergent when there is no diff", () => {
    const code = "function f(x: number) { return x + 1; }";
    const r = detectConvergentMove(code, code);
    expect(r.convergent).toBe(false);
    expect(r.reason).toMatch(/no diff/);
  });

  // ── Condition 1: diff size cap ────────────────────────────────────

  test("returns not-convergent when total churn exceeds 30 lines", () => {
    // 35 added guard lines — exceeds the cap.
    const original = "function f() { return 1; }\n";
    const lines: string[] = ["function f() { return 1; }"];
    for (let i = 0; i < 35; i++) {
      lines.push(`if (x${i} === null) return;`);
    }
    const evolved = lines.join("\n");
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(false);
    expect(r.reason).toMatch(/diff too large/);
  });

  // ── Condition 2: predominantly additive ──────────────────────────

  test("returns not-convergent when added < 3 (too few additions)", () => {
    const original = "function f() { return 1; }";
    const evolved = "function f() { return 1; }\nif (!x) return;";
    // 1 added guard line, 0 removed
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(false);
    expect(r.reason).toMatch(/too few additions/);
  });

  test("returns not-convergent when removed > 2 (real refactor)", () => {
    const original = [
      "function f() { return 1; }",
      "function g() { return 2; }",
      "function h() { return 3; }",
      "function i() { return 4; }",
    ].join("\n");
    const evolved = [
      "function f() { return 1; }",
      "if (!x) return;",
      "if (!y) return;",
      "if (!z) return;",
    ].join("\n");
    // 3 added guards, 3 removed functions → real refactor
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(false);
    expect(r.reason).toMatch(/has removals/);
  });

  // ── Condition 3: guard lexicon density ────────────────────────────

  test("returns not-convergent when additions are not guard-dominated", () => {
    // 3 added lines of real logic, 1 guard → 25% density < 50%.
    const original = "function f() { return 1; }";
    const evolved = [
      "function f() { return 1; }",
      "const result = computeThing();",
      "const cached = cache.get(key);",
      "const transformed = transform(result, cached);",
      "if (!x) return;", // 1 guard line
    ].join("\n");
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(false);
    expect(r.reason).toMatch(/not guard-dominated/);
  });
  // ── Condition 4: behavioral signal escape hatch ──────────────────

  test("returns not-convergent when additions include a new export", () => {
    const original = "function f() { return 1; }";
    const evolved = [
      "function f() { return 1; }",
      "export function g() { return 2; }",
      "if (!x) return;",
      "if (!y) return;",
      "if (!z) return;",
    ].join("\n");
    // 4 added lines: 1 export (behavioral signal) + 3 guards.
    // Even though guard density is 75%, the export breaks condition 4.
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(false);
    expect(r.reason).toMatch(/behavioral signal/);
  });

  test("returns not-convergent when additions include a new function", () => {
    const original = "function f() { return 1; }";
    const evolved = [
      "function f() { return 1; }",
      "function g() { return 2; }",
      "if (!x) return;",
      "if (!y) return;",
      "if (!z) return;",
    ].join("\n");
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(false);
    expect(r.reason).toMatch(/behavioral signal/);
  });

  test("returns not-convergent when additions include a new class", () => {
    const original = "function f() { return 1; }";
    const evolved = [
      "function f() { return 1; }",
      "class Widget { constructor() {} }",
      "if (!x) return;",
      "if (!y) return;",
    ].join("\n");
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(false);
    expect(r.reason).toMatch(/behavioral signal/);
  });

  test("returns not-convergent when additions include a constructed throw", () => {
    const original = "function f() { return 1; }";
    const evolved = [
      "function f() { return 1; }",
      "throw new Error('bad input');",
      "if (!x) return;",
      "if (!y) return;",
    ].join("\n");
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(false);
    expect(r.reason).toMatch(/behavioral signal/);
  });

  // ── Positive cases: real convergent moves from the loop's history ─

  test("flags the loop's `let parsed;` → `let parsed: any;` pattern (commit 0f3a034 class)", () => {
    // The actual loop commit changed ONE line: `let parsed;` to
    // `let parsed: any;` but claimed 4 improvements in the message.
    // The guard must catch this kind of convergent type-annotation move
    // when the LLM bundles multiple guard additions together.
    const original = [
      "function f() {",
      "  let parsed;",
      "  try { parsed = JSON.parse(raw); } catch { return null; }",
      "  return parsed;",
      "}",
    ].join("\n");
    const evolved = [
      "function f() {",
      "  let parsed: any;",
      "  try { parsed = JSON.parse(raw); } catch { return null; }",
      "  if (parsed === null) return null;",
      "  if (parsed === undefined) return null;",
      "  return parsed;",
      "}",
    ].join("\n");
    // Added: `let parsed: any;` (matches `: any` lexicon), 2 null checks.
    // Removed: `let parsed;`. 3 added, 1 removed → predominantly additive.
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(true);
  });

  test("flags the loop's `{entry.trust}` → `{entry.trust ?? \"unknown\"}` pattern (commit f0ec6f5 class)", () => {
    const original = [
      "function Render({ entry }) {",
      "  return <Badge>{entry.trust}</Badge>;",
      "}",
    ].join("\n");
    const evolved = [
      "function Render({ entry }) {",
      "  if (entry.trust === null) return <Badge>{'unknown'}</Badge>;",
      "  if (entry.trust === undefined) return <Badge>{'unknown'}</Badge>;",
      "  return <Badge>{entry.trust ?? 'unknown'}</Badge>;",
      "}",
    ].join("\n");
    // 3 added guard lines, 1 removed (the original return).
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(true);
  });

  test("flags a bundle of typeof + Array.isArray + instanceof Error guards (the canonical convergent shape)", () => {
    const original = [
      "function process(input) {",
      "  return input.map((x) => x.value);",
      "}",
    ].join("\n");
    const evolved = [
      "function process(input) {",
      "  if (typeof input !== 'object') return [];",
      "  if (!Array.isArray(input)) return [];",
      "  if (input === null) return [];",
      "  return input.map((x) => x.value);",
      "}",
    ].join("\n");
    // 4 added guards, 0 removed. All 4 match the lexicon.
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(true);
  });

  test("flags a try-catch wrap around existing code (the 'improved error handling' pattern)", () => {
    const original = [
      "function readThing() {",
      "  return JSON.parse(readFileSync(path, 'utf8'));",
      "}",
    ].join("\n");
    const evolved = [
      "function readThing() {",
      "  try {",
      "    return JSON.parse(readFileSync(path, 'utf8'));",
      "  } catch (err) {",
      "    if (err instanceof Error) console.error(err.message);",
      "    return null;",
      "  }",
      "}",
    ].join("\n");
    // Added: try {, instanceof Error, return null; (2 lines). Removed: nothing.
    // The `try {` and `instanceof Error` match the lexicon.
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(true);
  });

  // ── finalAuthority integration ───────────────────────────────────

  test("finalAuthority rejects a convergent move on a non-test file", () => {
    const original = [
      "function process(input) {",
      "  return input.map((x) => x.value);",
      "}",
    ].join("\n");
    const evolved = [
      "function process(input) {",
      "  if (typeof input !== 'object') return [];",
      "  if (!Array.isArray(input)) return [];",
      "  if (input === null) return [];",
      "  return input.map((x) => x.value);",
      "}",
    ].join("\n");
    const r = finalAuthority({
      filePath: "src/components/widget.tsx",
      originalCode: original,
      evolvedCode: evolved,
    });
    expect(r.allowed).toBe(false);
    expect(r.reasons.some((x) => x.includes("convergent-move"))).toBe(true);
  });

  test("finalAuthority EXEMPTS test files — tests legitimately add defensive guards as pins", () => {
    // Same convergent-looking diff, but on a .test.ts file in a NON-
    // protected path → must pass. (A .test.ts file under core/ would
    // still be rejected by the protected-path check, which runs first.)
    const original = [
      "function process(input) {",
      "  return input.map((x) => x.value);",
      "}",
    ].join("\n");
    const evolved = [
      "function process(input) {",
      "  if (typeof input !== 'object') return [];",
      "  if (!Array.isArray(input)) return [];",
      "  if (input === null) return [];",
      "  return input.map((x) => x.value);",
      "}",
    ].join("\n");
    const r = finalAuthority({
      filePath: "src/lib/pipeline/autonomous/widget.test.ts",
      originalCode: original,
      evolvedCode: evolved,
    });
    expect(r.allowed).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  test("finalAuthority allows a real refactor that happens to add a guard (behavioral signal present)", () => {
    const original = [
      "function process(input) {",
      "  return input.map((x) => x.value);",
      "}",
    ].join("\n");
    const evolved = [
      "function process(input) {",
      "  if (!Array.isArray(input)) return [];",
      "  return input.map((x) => x.value);",
      "}",
      "export function safeProcess(input) {",
      "  return process(input ?? []);",
      "}",
    ].join("\n");
    // Adds a guard BUT also adds a new export → behavioral signal → allowed.
    const r = finalAuthority({
      filePath: "src/lib/pipeline/autonomous/widget.ts",
      originalCode: original,
      evolvedCode: evolved,
    });
    expect(r.allowed).toBe(true);
  });

  // ── gateMutation integration ─────────────────────────────────────

  test("gateMutation reports rejectedBy='finalAuthority' for a convergent move", () => {
    const original = [
      "function process(input) {",
      "  return input.map((x) => x.value);",
      "}",
    ].join("\n");
    const evolved = [
      "function process(input) {",
      "  if (typeof input !== 'object') return [];",
      "  if (!Array.isArray(input)) return [];",
      "  if (input === null) return [];",
      "  return input.map((x) => x.value);",
      "}",
    ].join("\n");
    const r = gateMutation({
      filePath: "src/components/widget.tsx",
      originalCode: original,
      evolvedCode: evolved,
    });
    expect(r.allowed).toBe(false);
    expect(r.rejectedBy).toBe("finalAuthority");
    expect(r.reasons.some((x) => x.includes("convergent-move"))).toBe(true);
  });
});
