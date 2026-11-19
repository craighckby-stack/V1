/**
 * Target Scanner tests — pure static analysis, no network, no DB.
 * Mirrors the detector set of the self-task-generator: the SAME issue
 * classes must be found in foreign code as in our own.
 */

import { describe, test, expect } from "bun:test";
import {
  scanTargetContent,
  isMutableTargetPath,
  pickTargetFinding,
  TARGET_KIND_PRIORITY,
} from "./target-scan";

describe("scanTargetContent", () => {
  test("detects all seven issue kinds in one file", () => {
    const code = [
      'import { omega } from "./omega";', // never referenced → unused-import
      "// TODO: fix this shortcut",
      "let thing: string | null = null;",
      "export function handler(e: any): void {",
      "  try {",
      "    doWork(thing!);",
      "  } catch {",
      "  }",
      "  return;",
      "}",
      "function helper(n: number) {",
      "  if (n > 3600) return n;",
      "  return n + 1;",
      "}",
    ].join("\n");

    const findings = scanTargetContent("src/thing.ts", code);
    const kinds = new Set(findings.map((f) => f.kind));

    expect(kinds.has("todo-comment")).toBe(true);
    expect(kinds.has("any-usage")).toBe(true);
    expect(kinds.has("empty-catch")).toBe(true);
    expect(kinds.has("missing-return-type")).toBe(true);
    expect(kinds.has("magic-number")).toBe(true);
    expect(kinds.has("non-null-assertion")).toBe(true);
    expect(kinds.has("unused-import")).toBe(true);
    // every finding carries a 1-based line + evidence
    for (const f of findings) {
      expect(f.line).toBeGreaterThanOrEqual(1);
      expect(typeof f.evidence).toBe("string");
    }
  });

  test("clean typed file produces zero findings", () => {
    const code = [
      'import { alpha } from "./alpha";',
      "export function beta(n: number): number {",
      "  const limit = 100;",
      "  if (n > limit) return alpha(n);",
      "  return n;",
      "}",
    ].join("\n");
    expect(scanTargetContent("src/clean.ts", code)).toEqual([]);
  });

  test("declaration initializers are NOT magic numbers", () => {
    const code = "export function f(): number {\n  const timeout = 86400;\n  return timeout;\n}";
    const kinds = scanTargetContent("src/t.ts", code).map((f) => f.kind);
    expect(kinds).not.toContain("magic-number");
  });

  test("TODO inside a string literal is not flagged (comment marker required)", () => {
    const code = 'export const msg: string = "please TODO this";';
    const kinds = scanTargetContent("src/t.ts", code).map((f) => f.kind);
    expect(kinds).not.toContain("todo-comment");
  });

  test("JSX parses (ScriptKind.TSX) — function with JSX body is found", () => {
    const code = "const el = <div className=\"x\">hi</div>;\nexport function Widget(n: number) {\n  return el;\n}";
    const kinds = scanTargetContent("src/widget.tsx", code).map((f) => f.kind);
    expect(kinds).toContain("missing-return-type");
  });
});

describe("isMutableTargetPath", () => {
  const mutable = ["src/lib/utils.ts", "src/app/display/widget.tsx", "lib/index.js", "src/a/b.ts"];
  const immutable = [
    "src/app/page.tsx", // exact protected file
    "src/app/layout.tsx", // exact protected file
    "src/lib/db.ts", // exact protected file
    "src/lib/pipeline/core/paths.ts", // prefix-protected (our gates)
    "src/app/api/self-enhance/status/route.ts", // prefix-protected
    "src/utils.test.ts", // test file
    "src/utils.spec.tsx", // spec file
    "src/types/x.d.ts", // ambient declarations
    "node_modules/a/index.ts", // vendored
    "dist/bundle.js", // build output
    "__tests__/x.ts", // test dir
    ".hidden.ts", // dotfile
    "a/../b.ts", // traversal
    "/abs/path.ts", // absolute
    "vendor/lib.js", // vendored
    "README.md", // not TS-analyzable
    "image.png", // not code
    "bundle.min.js", // minified
    "", // empty
  ];

  test("accepts ordinary source paths", () => {
    for (const p of mutable) expect(isMutableTargetPath(p)).toBe(true);
  });

  test("rejects protected, generated, and non-source paths", () => {
    for (const p of immutable) expect(isMutableTargetPath(p)).toBe(false);
  });

  test("never proposes changes to OUR gate modules even at colliding paths", () => {
    // pipeline/** is not prefix-protected, but core/** is — assert the
    // exact protection boundary instead of guessing:
    expect(isMutableTargetPath("src/lib/pipeline/core/gate-runner.ts")).toBe(false);
    expect(isMutableTargetPath("src/lib/pipeline/target/target-scan.ts")).toBe(true);
  });
});

describe("pickTargetFinding", () => {
  test("prioritizes todo-comment over any-usage, ties break by line", () => {
    const pick = pickTargetFinding([
      { file: "b.ts", findings: [{ kind: "any-usage", line: 10, evidence: "x" }] },
      { file: "a.ts", findings: [{ kind: "todo-comment", line: 40, evidence: "y" }] },
    ]);
    expect(pick?.file).toBe("a.ts");
    expect(pick?.finding.kind).toBe("todo-comment");
  });

  test("same priority → lowest line wins", () => {
    const pick = pickTargetFinding([
      { file: "b.ts", findings: [{ kind: "any-usage", line: 30, evidence: "x" }] },
      { file: "a.ts", findings: [{ kind: "any-usage", line: 7, evidence: "y" }] },
    ]);
    expect(pick?.file).toBe("a.ts");
    expect(pick?.finding.line).toBe(7);
  });

  test("empty input → null", () => {
    expect(pickTargetFinding([])).toBeNull();
    expect(pickTargetFinding([{ file: "a.ts", findings: [] }])).toBeNull();
  });

  test("priority table matches the self-generator contract (1..6)", () => {
    expect(TARGET_KIND_PRIORITY["todo-comment"]).toBe(1);
    expect(TARGET_KIND_PRIORITY["non-null-assertion"]).toBe(6);
  });
});
