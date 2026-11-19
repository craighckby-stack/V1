/**
 * Target Store tests — the PURE validation/normalization layer.
 *
 * The DB round-trip (SystemFlag upsert/read) is intentionally NOT tested
 * here: it uses the exact same two-line pattern already proven in
 * duress.ts and hot-swap.ts, and keeping this file DB-free means
 * `bun test` never touches the live database.
 */

import { describe, test, expect } from "bun:test";
import {
  normalizeTargetRepo,
  validTargetRepoFormat,
  validTargetBranchFormat,
} from "./target-store";

describe("normalizeTargetRepo", () => {
  test("strips scheme, host, and .git suffix", () => {
    expect(normalizeTargetRepo("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(normalizeTargetRepo("http://github.com/owner/repo")).toBe("owner/repo");
    expect(normalizeTargetRepo("  owner/repo  ")).toBe("owner/repo");
    expect(normalizeTargetRepo("owner/repo")).toBe("owner/repo");
  });
});

describe("validTargetRepoFormat", () => {
  test("accepts owner/name shapes", () => {
    expect(validTargetRepoFormat("owner/repo")).toBe(true);
    expect(validTargetRepoFormat("Owner.Name/repo-1_x")).toBe(true);
  });
  test("rejects traversal, extra segments, and junk", () => {
    expect(validTargetRepoFormat("")).toBe(false);
    expect(validTargetRepoFormat("owner")).toBe(false);
    expect(validTargetRepoFormat("owner/repo/extra")).toBe(false);
    expect(validTargetRepoFormat("a/../b")).toBe(false);
    expect(validTargetRepoFormat("owner/repo name")).toBe(false);
    expect(validTargetRepoFormat("owner//repo")).toBe(false);
  });
});

describe("validTargetBranchFormat", () => {
  test("accepts ordinary branch names", () => {
    expect(validTargetBranchFormat("main")).toBe(true);
    expect(validTargetBranchFormat("feature/x")).toBe(true);
    expect(validTargetBranchFormat("v1.0-beta")).toBe(true);
  });
  test("rejects refs git would reject (and our storage would mangle)", () => {
    expect(validTargetBranchFormat("")).toBe(false);
    expect(validTargetBranchFormat("has space")).toBe(false);
    expect(validTargetBranchFormat("-leading-dash")).toBe(false);
    expect(validTargetBranchFormat("a..b")).toBe(false);
    expect(validTargetBranchFormat("ends.lock")).toBe(false);
  });
});
