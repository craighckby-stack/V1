/**
 * Auto Picker tests — pure contract checks (no fs, no db, no network).
 * Bun test: bun test src/lib/pipeline/core/auto-picker.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  rankCandidateFiles,
  scoreFindings,
  summarizeFindings,
  pickBestFileToRefactor,
  findingWeight,
  MIN_PICK_FILE_BYTES,
  MAX_PICK_FILE_BYTES,
} from "./auto-picker";
import type { TargetTreeFile } from "../target/target-github";
import type { TargetFinding } from "../target/target-scan";

function treeFile(path: string, size = 8_000): TargetTreeFile {
  return { path, size, sha: "abc" };
}

function finding(kind: TargetFinding["kind"], line = 1): TargetFinding {
  return { kind, line, evidence: "x" };
}

describe("rankCandidateFiles", () => {
  test("filters non-mutable paths; docs/ is deprioritized, not excluded", () => {
    const ranked = rankCandidateFiles([
      treeFile("src/a.test.ts"),
      treeFile("src/b.d.ts"),
      treeFile("src/c.min.js"),
      treeFile("node_modules/pkg/x.ts"),
      treeFile("dist/x.ts"),
      treeFile("docs/guide.ts"),
      treeFile("src/real.ts"),
    ]);
    // Hard-excluded: test/d.ts/min.js/node_modules/dist. docs/ is a
    // -2 scaffolding penalty in rankCandidateFiles, not an exclusion —
    // target-scan's isMutableTargetPath allows it.
    expect(ranked.map((r) => r.path)).toEqual(["src/real.ts", "docs/guide.ts"]);
  });

  test("filters the size window both ways", () => {
    const ranked = rankCandidateFiles([
      treeFile("src/tiny.ts", MIN_PICK_FILE_BYTES - 1),
      treeFile("src/huge.ts", MAX_PICK_FILE_BYTES + 1),
      treeFile("src/ok.ts", MIN_PICK_FILE_BYTES),
    ]);
    expect(ranked.map((r) => r.path)).toEqual(["src/ok.ts"]);
  });

  test("src/ beats a sibling lib-nested file with equal shape", () => {
    const ranked = rankCandidateFiles([
      treeFile("packages/foo/src/thing.ts"),
      treeFile("src/thing.ts"),
    ]);
    expect(ranked[0].path).toBe("src/thing.ts");
  });

  test("barrels and config files sink; determinism on ties", () => {
    const ranked = rankCandidateFiles([
      treeFile("src/index.ts"),
      treeFile("src/deep/a/b/c/d/e/f.ts"),
      treeFile("src/alpha.ts"),
      treeFile("src/beta.ts"),
    ]);
    // alpha/beta tie (same dir, same size) → lexicographic.
    expect(ranked[0].path).toBe("src/alpha.ts");
    expect(ranked[1].path).toBe("src/beta.ts");
    // deep nesting and barrel both penalized.
    const paths = ranked.map((r) => r.path);
    expect(paths.indexOf("src/index.ts")).toBeGreaterThan(paths.indexOf("src/beta.ts"));
    expect(paths.indexOf("src/deep/a/b/c/d/e/f.ts")).toBeGreaterThan(paths.indexOf("src/beta.ts"));
  });

  test("returns empty for an empty/immutable tree", () => {
    expect(rankCandidateFiles([])).toEqual([]);
    expect(rankCandidateFiles([treeFile("README.md")])).toEqual([]);
  });
});

describe("scoreFindings / findingWeight", () => {
  test("weights follow the target-scan priority table inverted", () => {
    expect(findingWeight("todo-comment")).toBe(7); // priority 1
    expect(findingWeight("empty-catch")).toBe(6);
    expect(findingWeight("non-null-assertion")).toBe(2); // priority 6
  });

  test("score is the sum of weights; empty = 0", () => {
    expect(scoreFindings([])).toBe(0);
    expect(
      scoreFindings([finding("todo-comment"), finding("todo-comment"), finding("any-usage")])
    ).toBe(7 + 7 + 5);
  });
});

describe("summarizeFindings", () => {
  test("collapses to per-kind counts sorted most-urgent first", () => {
    const summary = summarizeFindings([
      finding("magic-number", 3),
      finding("todo-comment", 1),
      finding("todo-comment", 2),
      finding("empty-catch", 4),
    ]);
    expect(summary).toEqual([
      { kind: "todo-comment", count: 2 },
      { kind: "empty-catch", count: 1 },
      { kind: "magic-number", count: 1 },
    ]);
  });
});

describe("pickBestFileToRefactor", () => {
  test("null on empty shortlist", () => {
    expect(pickBestFileToRefactor([])).toBeNull();
  });

  test("highest finding score wins regardless of input order", () => {
    const scans = [
      { path: "src/a.ts", findings: [finding("magic-number")] }, // 2
      { path: "src/b.ts", findings: [finding("todo-comment")] }, // 7
      { path: "src/c.ts", findings: [finding("non-null-assertion")] }, // 2
    ];
    const pick = pickBestFileToRefactor(scans)!;
    expect(pick.path).toBe("src/b.ts");
    expect(pick.score).toBe(7);
    expect(pick.fallback).toBe(false);
    expect(pick.reason).toContain("7");
  });

  test("exact score tie → first scanned (top tree rank) wins", () => {
    const tie = [
      { path: "src/first.ts", findings: [finding("todo-comment")] }, // 7
      { path: "src/second.ts", findings: [finding("any-usage"), finding("non-null-assertion")] }, // 5+2=7
    ];
    const pick = pickBestFileToRefactor(tie)!;
    expect(pick.path).toBe("src/first.ts");
  });

  test("all-zero findings → fallback to top-ranked candidate with an honest reason", () => {
    const scans = [
      { path: "src/clean-top.ts", findings: [] },
      { path: "src/clean-other.ts", findings: [] },
    ];
    const pick = pickBestFileToRefactor(scans)!;
    expect(pick.path).toBe("src/clean-top.ts");
    expect(pick.score).toBe(0);
    expect(pick.fallback).toBe(true);
    expect(pick.reason).toContain("no static findings");
  });

  test("fallback only when NO file has findings — one finding beats clean top-rank", () => {
    const scans = [
      { path: "src/clean-top.ts", findings: [] },
      { path: "src/dirty.ts", findings: [finding("empty-catch")] },
    ];
    const pick = pickBestFileToRefactor(scans)!;
    expect(pick.path).toBe("src/dirty.ts");
    expect(pick.fallback).toBe(false);
  });
});
