import { describe, test, expect } from "bun:test";
import {
  searchEngines,
  formatPriorArtBlock,
  getFleetDigest,
  getCorpusStatus,
  __resetCorpusCacheForTests,
} from "./githistory-corpus";

/**
 * REAL-DATA tests — the corpus files (memory/commit-history.*.json) are
 * checked into the repo (checked out from origin/main, pushed by the
 * operator's GitHistory-Sync archive). No mocks: these tests pin the
 * module's contract against the actual archive, so a corpus schema
 * change or a loader regression fails here, not in a live prompt.
 */

describe("githistory-corpus", () => {
  test("getCorpusStatus loads the real corpus with expected scale", () => {
    const s = getCorpusStatus();
    // The archive as committed: 117 engines, 4165 failed, 2192 successful.
    // Assert ranges, not exact counts — the operator re-syncs the archive
    // and counts move; the contract is the SCALE, not the snapshot.
    expect(s.loaded).toBe(true);
    expect(s.engines).toBeGreaterThanOrEqual(100);
    expect(s.failed).toBeGreaterThanOrEqual(4000);
    expect(s.successful).toBeGreaterThanOrEqual(2000);
    expect(s.repos).toBeGreaterThanOrEqual(10);
    expect(s.generatedAt).toBeTruthy();
  });

  test("searchEngines finds orchestrators for an orchestrator query", () => {
    const hits = searchEngines("orchestrator", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(5);
    // Every hit matched at least one query term
    for (const h of hits) {
      expect(h.matchedTerms.length).toBeGreaterThan(0);
      expect(h.score).toBeGreaterThan(0);
    }
    // Ranked: scores non-increasing
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  test("searchEngines is relevant: top hit for a RAG query touches rag", () => {
    const hits = searchEngines("rag retrieval", 3);
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0];
    const hay = `${top.engine.role} ${top.engine.filePath} ${top.engine.classNames.join(" ")} ${top.engine.functionNames.join(" ")}`.toLowerCase();
    expect(hay).toContain("rag");
  });

  test("searchEngines rejects empty and stop-word-only queries", () => {
    expect(searchEngines("")).toEqual([]);
    expect(searchEngines("   ")).toEqual([]);
    // Stop words only (the, and, src, lib...) → no query tokens → no hits
    expect(searchEngines("the and src lib utils")).toEqual([]);
    expect(searchEngines("orchestrator", 0)).toEqual([]);
  });

  test("formatPriorArtBlock is empty for no hits", () => {
    expect(formatPriorArtBlock([])).toBe("");
  });

  test("formatPriorArtBlock renders bounded, labeled, scrubbed output", () => {
    const hits = searchEngines("agent loop", 3);
    expect(hits.length).toBeGreaterThan(0);
    const block = formatPriorArtBlock(hits);
    expect(block).toContain("--- PRIOR ART");
    expect(block).toContain("--- END PRIOR ART ---");
    // Honest framing: patterns, not code
    expect(block.toLowerCase()).toContain("never copy code verbatim");
    // Bounded: 3 hits × (header + signatures) + framing stays small
    expect(block.length).toBeLessThan(2000);
    // Scrub defense: the engine metadata cannot close the block from
    // inside (an en-dash neutralized marker is fine; the literal close
    // marker may only appear ONCE — the real one at the end).
    const closeCount = block.split("--- END PRIOR ART ---").length - 1;
    expect(closeCount).toBe(1);
  });

  test("getFleetDigest reports the honest CI-pending split of failures", () => {
    const d = getFleetDigest();
    expect(d.length).toBeGreaterThan(100);
    // The honesty contract: the digest must NOT launder CI-unverified
    // commits into "failures" — the dominant reason in the corpus is
    // 'CI state is pending', and the digest says so explicitly.
    expect(d).toContain("UNVERIFIED");
    expect(d.toLowerCase()).toContain("ci state pending");
    // Labeled as external evidence, not this system's own history
    expect(d).toContain("GitHistory-Sync corpus");
    expect(d).toContain("sibling systems");
    // Bounded for the distiller prompt
    expect(d.length).toBeLessThan(1500);
  });

  test("getFleetDigest covers both buckets and the engine fleet", () => {
    const d = getFleetDigest();
    expect(d).toContain("verified-successful commits");
    expect(d).toContain("harvested engines");
    expect(d).toContain("Successful change footprints");
  });

  test("cache reset is safe and reloads the same corpus", () => {
    const before = getCorpusStatus();
    __resetCorpusCacheForTests();
    const after = getCorpusStatus();
    expect(after.engines).toBe(before.engines);
    expect(after.failed).toBe(before.failed);
    expect(after.successful).toBe(before.successful);
  });
});
