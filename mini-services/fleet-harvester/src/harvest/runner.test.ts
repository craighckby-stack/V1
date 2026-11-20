import { describe, test, expect } from "bun:test";
import { decideLlmBudgetCap, sortCommitsNewestFirst } from "./runner";
import type { ExtractionSettings } from "../types/git";

/**
 * Tests for the pure helpers extracted from runHarvest. These cover the
 * logic that was previously inline and untested (the subagent review
 * flagged zero coverage on the new runner code).
 *
 * The full runHarvest needs network + a GitHub token + the Z.AI cortex;
 * it's verified via the manual smoke harvest (Agent Browser + CLI). These
 * tests lock in the two pieces of pure logic that the runner relies on:
 * the budget-cap threshold decision and the stable newest-first sort.
 */

function makeSettings(overrides: Partial<ExtractionSettings> = {}): ExtractionSettings {
  return {
    authorFilter: "",
    sources: "craighckby-stack",
    extAuthor: "",
    repoFilter: "",
    sinceDate: "",
    untilDate: "",
    branchScope: "default",
    siphonEngines: true,
    includePrivate: true,
    includeForks: false,
    skipOwn: true,
    includeEmails: false,
    includeMine: false,
    ciLookup: true,
    failRx: "\\b(wip|broken)\\b",
    okRx: "\\b(passed)\\b",
    aiStrategy: "consensus",
    useGemini: true,
    useGeminiBackup: false,
    useLlm: true,
    nvKey: "",
    nvModel: "",
    nvEndpoint: "",
    nvPrivate: false,
    ...overrides,
  };
}

describe("decideLlmBudgetCap", () => {
  test("does NOT cap when total commits is below the 2x threshold", () => {
    const result = decideLlmBudgetCap(500, 500, makeSettings());
    expect(result.capped).toBe(0);
    expect(result.extraction.useGemini).toBe(true);
    expect(result.extraction.useLlm).toBe(true);
  });

  test("does NOT cap at exactly the 2x threshold (strict >)", () => {
    // 2x cap = 1000; at exactly 1000, the LLM still runs (strict >).
    const result = decideLlmBudgetCap(1000, 500, makeSettings());
    expect(result.capped).toBe(0);
  });

  test("caps when total commits exceed 2x the threshold", () => {
    const result = decideLlmBudgetCap(1001, 500, makeSettings());
    expect(result.capped).toBe(1);
    expect(result.extraction.useGemini).toBe(false);
    expect(result.extraction.useLlm).toBe(false);
  });

  test("caps at high commit counts (10k-commit repo scenario)", () => {
    const result = decideLlmBudgetCap(10_000, 500, makeSettings());
    expect(result.capped).toBe(1);
    expect(result.extraction.useLlm).toBe(false);
  });

  test("does not mutate the input extraction settings", () => {
    const settings = makeSettings({ useGemini: true, useLlm: true });
    decideLlmBudgetCap(10_000, 500, settings);
    expect(settings.useGemini).toBe(true);
    expect(settings.useLlm).toBe(true);
  });

  test("preserves the rest of the extraction settings when capping", () => {
    const settings = makeSettings({ authorFilter: "octocat", branchScope: "all", siphonEngines: false });
    const result = decideLlmBudgetCap(10_000, 500, settings);
    expect(result.extraction.authorFilter).toBe("octocat");
    expect(result.extraction.branchScope).toBe("all");
    expect(result.extraction.siphonEngines).toBe(false);
  });
});

describe("sortCommitsNewestFirst", () => {
  test("sorts newest first by date", () => {
    const commits = [
      { date: "2026-11-20T12:00:00Z", sha: "a1" },
      { date: "2026-11-20T13:00:00Z", sha: "b2" },
      { date: "2026-11-20T11:00:00Z", sha: "c3" },
    ];
    const sorted = sortCommitsNewestFirst(commits);
    expect(sorted.map((c) => c.sha)).toEqual(["b2", "a1", "c3"]);
  });

  test("uses SHA as a stable tiebreaker for same-timestamp commits", () => {
    // Same date → order by SHA ascending (deterministic across runs)
    const commits = [
      { date: "2026-11-20T12:00:00Z", sha: "zzz" },
      { date: "2026-11-20T12:00:00Z", sha: "aaa" },
      { date: "2026-11-20T12:00:00Z", sha: "mmm" },
    ];
    const sorted = sortCommitsNewestFirst(commits);
    expect(sorted.map((c) => c.sha)).toEqual(["aaa", "mmm", "zzz"]);
  });

  test("does not mutate the input array", () => {
    const commits = [
      { date: "2026-11-20T12:00:00Z", sha: "a1" },
      { date: "2026-11-20T11:00:00Z", sha: "b2" },
    ];
    const originalOrder = commits.map((c) => c.sha);
    sortCommitsNewestFirst(commits);
    expect(commits.map((c) => c.sha)).toEqual(originalOrder);
  });

  test("handles empty input", () => {
    expect(sortCommitsNewestFirst([])).toEqual([]);
  });

  test("handles a single commit", () => {
    const commits = [{ date: "2026-11-20T12:00:00Z", sha: "a1" }];
    expect(sortCommitsNewestFirst(commits).map((c) => c.sha)).toEqual(["a1"]);
  });

  test("deterministic: sorting twice yields the same order", () => {
    const commits = [
      { date: "2026-11-20T12:00:00Z", sha: "x1" },
      { date: "2026-11-20T12:00:00Z", sha: "a1" },
      { date: "2026-11-20T13:00:00Z", sha: "z9" },
    ];
    const first = sortCommitsNewestFirst(commits).map((c) => c.sha);
    const second = sortCommitsNewestFirst(commits).map((c) => c.sha);
    expect(first).toEqual(second);
  });
});
