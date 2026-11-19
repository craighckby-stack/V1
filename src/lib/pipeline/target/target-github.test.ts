/**
 * Target GitHub helper tests — the PURE parts only (diff builder, branch
 * numbering). Network paths are exercised by the live smoke test, not by
 * unit tests.
 */

import { describe, test, expect } from "bun:test";
import { unifiedDiff, nextTargetBranchNumber } from "./target-github";

/** Apply a single-hunk unified diff to the original — validates BOTH the
 *  content ops AND the hunk line numbers in one shot. */
function applySingleHunkDiff(diff: string, original: string): string {
  const lines = diff.split("\n");
  expect(lines[0]).toBe("--- a/file.ts");
  expect(lines[1]).toBe("+++ b/file.ts");
  const hunkIdx = lines.findIndex((l) => l.startsWith("@@"));
  expect(hunkIdx).toBe(2);
  const m = lines[hunkIdx].match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/);
  expect(m).not.toBeNull();
  const aFrom = Number(m![1]);
  const aCount = Number(m![2]);
  const body = lines.slice(hunkIdx + 1).filter((l) => l !== "");
  const aLines = original.split("\n");
  const prefix = aLines.slice(0, aFrom - 1);
  const suffix = aLines.slice(aFrom - 1 + aCount);
  const mid: string[] = [];
  for (const l of body) {
    const op = l[0];
    const text = l.slice(1);
    if (op === " " || op === "+") mid.push(text);
    // "-" contributes nothing — the line is deleted.
  }
  return [...prefix, ...mid, ...suffix].join("\n");
}

/** Full multi-hunk patch applier — the gold-standard validation: parses
 *  every hunk header, consumes exactly aCount original lines per hunk,
 *  and proves the numbering is correct by reconstructing the proposal. */
function applyPatch(diff: string, original: string): string {
  const lines = diff.split("\n").filter((l) => l !== "");
  const aLines = original.split("\n");
  const out: string[] = [];
  let aIdx = 0; // next original line not yet emitted
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith("@@")) {
      i++;
      continue;
    }
    const m = line.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/);
    expect(m).not.toBeNull();
    const aFrom = Number(m![1]);
    const aCount = Number(m![2]);
    // Emit untouched original lines before this hunk. Adjacent hunks may
    // SHARE context (hunk1's trailing context can overlap hunk2's leading
    // context — standard unified-diff behavior), so aIdx may already sit
    // inside this hunk's leading context.
    const overlap = Math.max(0, aIdx - (aFrom - 1));
    if (overlap > 0) {
      expect(overlap).toBeLessThanOrEqual(6); // bounded by 2 × context
      let skipped = 0;
      while (skipped < overlap) {
        const body = lines[i + 1 + skipped];
        expect(body[0]).toBe(" "); // overlap is always context
        expect(body.slice(1)).toBe(aLines[aFrom - 1 + skipped]);
        skipped++;
      }
    }
    while (aIdx < aFrom - 1) {
      out.push(aLines[aIdx]);
      aIdx++;
    }
    // Consume exactly aCount original lines' worth of body (the overlap
    // already consumed `overlap` of them).
    let consumed = overlap;
    let j = i + 1 + overlap;
    while (j < lines.length && consumed < aCount) {
      const body = lines[j];
      const op = body[0];
      const text = body.slice(1);
      if (op === " ") {
        expect(aLines[aIdx]).toBe(text); // context must match the original
        out.push(text);
        aIdx++;
        consumed++;
      } else if (op === "-") {
        expect(aLines[aIdx]).toBe(text); // deletion must match the original
        aIdx++;
        consumed++;
      } else if (op === "+") {
        out.push(text);
      } else {
        // truncation marker or garbage — only legal at the very end
        expect(body).toBe("[diff truncated by target-mode]");
        break;
      }
      j++;
    }
    expect(consumed).toBe(aCount);
    // Drain trailing "+" insertions — they belong to this hunk even
    // though no original lines are consumed after the last -/context op.
    while (j < lines.length && lines[j][0] === "+") {
      out.push(lines[j].slice(1));
      j++;
    }
    i = j;
  }
  // Trailing context after the last hunk.
  while (aIdx < aLines.length) {
    out.push(aLines[aIdx]);
    aIdx++;
  }
  return out.join("\n");
}

describe("unifiedDiff", () => {
  test("identical content → empty diff", () => {
    expect(unifiedDiff("a.ts", "same\ncontent", "same\ncontent")).toBe("");
  });

  test("pure addition: header counts, +d line, patch round-trips", () => {
    const original = "a\nb\nc";
    const proposed = "a\nb\nc\nd";
    const diff = unifiedDiff("file.ts", original, proposed);
    expect(diff).toContain("+d");
    expect(diff).not.toContain("-b");
    expect(diff).toMatch(/^--- a\/file\.ts\n\+\+\+ b\/file\.ts\n@@ -1,3 \+1,4 @@/);
    expect(applySingleHunkDiff(diff, original)).toBe(proposed);
  });

  test("pure deletion: -b line, patch round-trips", () => {
    const original = "a\nb\nc";
    const proposed = "a\nc";
    const diff = unifiedDiff("file.ts", original, proposed);
    expect(diff).toContain("-b");
    expect(diff).not.toContain("+b");
    expect(applySingleHunkDiff(diff, original)).toBe(proposed);
  });

  test("mid-file modification keeps context lines and round-trips", () => {
    const original = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"].join("\n");
    const proposed = ["l1", "l2", "l3", "l4", "CHANGED", "l6", "l7", "l8"].join("\n");
    const diff = unifiedDiff("file.ts", original, proposed);
    expect(diff).toContain("-l5");
    expect(diff).toContain("+CHANGED");
    expect(diff).toContain(" l4");
    expect(diff).toContain(" l6");
    expect(applySingleHunkDiff(diff, original)).toBe(proposed);
  });

  test("two distant changes → two hunks, full patch round-trips", () => {
    const original = ["l1", "l2", "l3", "l4", "l5", "g1", "g2", "g3", "g4", "l10"].join("\n");
    const proposed = ["l1", "l2", "l3", "X4", "l5", "g1", "g2", "g3", "g4", "Y10"].join("\n");
    const diff = unifiedDiff("file.ts", original, proposed);
    const headers = diff.split("\n").filter((l) => l.startsWith("@@"));
    expect(headers.length).toBe(2);
    for (const h of headers) {
      expect(h).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    }
    expect(diff).toContain("-l4");
    expect(diff).toContain("+X4");
    expect(diff).toContain("-l10");
    expect(diff).toContain("+Y10");
    expect(applyPatch(diff, original)).toBe(proposed);
  });

  test("insertion between hunks keeps the - and + counts independent", () => {
    // Replace one line with TWO lines, then a distant change: the second
    // hunk's + numbering must account for the extra inserted line, while
    // its - numbering stays aligned with the original. A full patch
    // round-trip is the only honest check of both at once.
    const original = ["l1", "l2", "l3", "l4", "l5", "g1", "g2", "g3", "g4", "l10"].join("\n");
    const proposed = ["l1", "l2", "l3", "n1", "n2", "l5", "g1", "g2", "g3", "g4", "Z10"].join("\n");
    const diff = unifiedDiff("file.ts", original, proposed);
    const headers = diff.split("\n").filter((l) => l.startsWith("@@"));
    expect(headers.length).toBe(2);
    expect(applyPatch(diff, original)).toBe(proposed);
  });

  test("diff is capped with an honest truncation marker", () => {
    const original = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const proposed = original.replace("line 500", "CHANGED") + "\ntail " + Array.from({ length: 1000 }, (_, i) => `t${i}`).join("\n");
    const diff = unifiedDiff("big.ts", original, proposed, 50);
    expect(diff).toContain("[diff truncated by target-mode]");
    expect(diff.split("\n").length).toBeLessThan(80);
  });
});

describe("nextTargetBranchNumber", () => {
  test("no branches → 1", () => {
    expect(nextTargetBranchNumber([])).toBe(1);
  });
  test("max loop-t-N + 1, ignoring other branches", () => {
    expect(nextTargetBranchNumber(["main", "loop-4", "loop-t-3", "loop-t-11", "dev"])).toBe(12);
  });
  test("malformed loop-t names do not crash it", () => {
    expect(nextTargetBranchNumber(["loop-t-", "loop-t-x", "loop-t-2"])).toBe(3);
  });
});
