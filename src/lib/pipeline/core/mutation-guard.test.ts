import { describe, test, expect } from "bun:test";
import {
  detectConvergentMove,
  finalAuthority,
  gateMutation,
  triageProposal,
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

  // ── CLIENT-COMPONENT FETCH EXEMPTION (audit 8) ────────────────────

  test("triage EXEMPTS fetch( for client components (use client directive present)", () => {
    // A new client panel that calls fetch("/api/...") — the standard
    // React pattern for calling app routes. The guard must NOT flag
    // the new fetch( as a dangerous token when "use client" is present.
    const original = `"use client";\nimport { useState } from "react";\nexport function Panel() { return <div>empty</div>; }\n`;
    const evolved = `"use client";\nimport { useState, useEffect } from "react";\nexport function Panel() {\n  const [data, setData] = useState(null);\n  useEffect(() => {\n    fetch("/api/self-enhance/tasks").then(r => r.json()).then(setData);\n  }, []);\n  return <div>{JSON.stringify(data)}</div>;\n}\n`;
    const r = triageProposal({
      filePath: "src/components/pipeline/oracle-task-feed-panel.tsx",
      originalCode: original,
      evolvedCode: evolved,
    });
    // fetch is exempted for client components — the verdict must not
    // be "evil" on the fetch token. (It may be "good" or "unsure" on
    // other grounds, but NOT evil-with-fetch-reason.)
    expect(r.verdict).not.toBe("evil");
    expect(r.reasons.some((x) => x.includes("fetch("))).toBe(false);
  });

  test("triage STILL BLOCKS fetch( for server modules (no use client directive)", () => {
    // Same fetch addition, but no "use client" — this is a server
    // module acquiring a new fetch(, which is the escape pattern the
    // guard was written to catch. Must still be flagged evil.
    const original = `import { db } from "@/lib/db";\nexport function getStatus() { return { ok: true }; }\n`;
    const evolved = `import { db } from "@/lib/db";\nexport function getStatus() {\n  const r = await fetch(process.env.UPSTREAM_URL + "/health");\n  return r.ok;\n}\n`;
    const r = triageProposal({
      filePath: "src/lib/pipeline/autonomous/widget.ts",
      originalCode: original,
      evolvedCode: evolved,
    });
    expect(r.verdict).toBe("evil");
    expect(r.reasons.some((x) => x.includes("fetch("))).toBe(true);
  });

  test("triage STILL BLOCKS eval( even in client components (exemption is fetch-only)", () => {
    // A client component that adds eval( — the exemption is narrow:
    // only fetch( is exempted for client components. eval, dynamic
    // import, child_process, etc. are still evil in client code.
    const original = `"use client";\nexport function Panel() { return <div />; }\n`;
    const evolved = `"use client";\nexport function Panel({ code }: { code: string }) {\n  return <div>{eval(code)}</div>;\n}\n`;
    const r = triageProposal({
      filePath: "src/components/pipeline/evil-panel.tsx",
      originalCode: original,
      evolvedCode: evolved,
    });
    expect(r.verdict).toBe("evil");
    expect(r.reasons.some((x) => x.includes("eval("))).toBe(true);
  });

  test("gateMutation ALLOWS a new client component that uses fetch(", () => {
    // The end-to-end path: a brand-new client panel (created action,
    // original is empty) that uses fetch. gateMutation should allow
    // it through to the debate tribunal / typecheck gate.
    const evolved = `"use client";\nimport { useState, useEffect } from "react";\nimport { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";\n\nexport function OracleTaskFeedPanel() {\n  const [tasks, setTasks] = useState<any[]>([]);\n  useEffect(() => {\n    fetch("/api/self-enhance/tasks?limit=50").then(r => r.json()).then(d => setTasks(d.tasks ?? []));\n  }, []);\n  const failed = tasks.filter((t: any) => t.kind === "oracle-failed-prophecy");\n  return (\n    <Card>\n      <CardHeader><CardTitle>Oracle → Task Feed</CardTitle></CardHeader>\n      <CardContent>{failed.length} failed prophecies feeding tasks</CardContent>\n    </Card>\n  );\n}\n`;
    const r = gateMutation({
      filePath: "src/components/pipeline/oracle-task-feed-panel.tsx",
      originalCode: "",
      evolvedCode: evolved,
    });
    // triage passes (fetch exempted for client component). finalAuthority
    // passes (not a protected path, not empty, NOT a convergent move —
    // the diff adds a new export, which is a behavioral signal).
    expect(r.allowed).toBe(true);
  });
});
