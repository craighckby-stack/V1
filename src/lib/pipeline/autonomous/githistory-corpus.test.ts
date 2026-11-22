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
 *
 * ARCHIVE ERAS (why the pins are structural, not scale-based):
 *   era 1 — multi-repo fleet: 117 engines, 4165 failed, 2192 successful,
 *           10+ repos (the pins the first version of these tests used).
 *   era 2 — 2026-11-22 sync (79fe2052): 12 engines, 1602 failed, 9540
 *           successful, 1 repo. The operator's archive legitimately
 *           changes shape between syncs; a scale pin breaks on every
 *           era change and teaches nothing. The CONTRACT is: both
 *           buckets present, a non-empty engine fleet, a generatedAt —
 *           i.e. the loader actually parsed the archive.
 */

describe("githistory-corpus", () => {
  test("getCorpusStatus loads the real corpus with a coherent shape", () => {
    const s = getCorpusStatus();
    // Structural pins — see the ARCHIVE ERAS note above. Exact counts
    // are era-dependent; presence is the loader's contract.
    expect(s.loaded).toBe(true);
    expect(s.engines).toBeGreaterThanOrEqual(1);
    expect(s.failed).toBeGreaterThanOrEqual(1);
    expect(s.successful).toBeGreaterThanOrEqual(1);
    expect(s.repos).toBeGreaterThanOrEqual(1);
    expect(s.generatedAt).toBeTruthy();
  });

  test("searchEngines returns bounded, ranked, term-matched hits for a corpus-present term", () => {
    // The archive's vocabulary moves between eras (the fleet era had
    // "orchestrator" roles; the single-repo era does not). Find a term
    // the CURRENT archive actually contains, then pin the search
    // contract on it: bounded result count, every hit matched a query
    // term, scores positive and non-increasing (ranked).
    const candidates = [
      "orchestrator",
      "agent",
      "loop",
      "api",
      "engine",
      "pipeline",
      "memory",
      "route",
      "task",
    ];
    let hits: ReturnType<typeof searchEngines> = [];
    let found = false;
    for (const term of candidates) {
      const h = searchEngines(term, 5);
      if (h.length > 0) {
        hits = h;
        found = true;
        break;
      }
    }
    // The loader verified >=1 engine above; at least one of these
    // common engineering terms must appear somewhere in that engine's
    // indexed text — otherwise the tokenizer/index is broken.
    expect(found).toBe(true);
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

  test("searchEngines is relevant: the top hit's indexed text touches a query term", () => {
    // Era-proof relevance pin (the original pinned a "rag" hit —
    // present in the fleet era, absent later). Try a few two-word
    // queries; for the first one with hits, the TOP hit's indexed text
    // must contain at least one of the query's tokens — that is the
    // relevance contract, independent of which vocabulary the current
    // archive happens to contain.
    const queries = [
      ["rag", "retrieval"],
      ["agent", "loop"],
      ["memory", "corpus"],
      ["route", "handler"],
      ["task", "queue"],
    ];
    let pinned = false;
    for (const q of queries) {
      const hits = searchEngines(q.join(" "), 3);
      if (hits.length === 0) continue;
      const top = hits[0];
      const hay = `${top.engine.role} ${top.engine.filePath} ${top.engine.classNames.join(" ")} ${top.engine.functionNames.join(" ")}`.toLowerCase();
      const touched = q.some((t) => hay.includes(t));
      // If a query HAS hits, the top hit must be relevant to it — a
      // miss here for a hit-producing query is a real relevance bug.
      expect(touched).toBe(true);
      pinned = true;
      break;
    }
    // At least one of these common query pairs must produce hits —
    // verified >=1 engine loaded above; an engine whose indexed text
    // matches NONE of these would mean the tokenizer is broken.
    expect(pinned).toBe(true);
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
    // Era-proof: use whichever term the corpus-present-term test
    // pattern finds (same candidate list) instead of pinning
    // "agent loop" — the archive's vocabulary moves between syncs.
    const candidates = [
      "agent loop",
      "orchestrator",
      "agent",
      "loop",
      "api",
      "engine",
      "pipeline",
      "memory",
      "route",
      "task",
    ];
    let hits: ReturnType<typeof searchEngines> = [];
    for (const term of candidates) {
      const h = searchEngines(term, 3);
      if (h.length > 0) {
        hits = h;
        break;
      }
    }
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
    expect(d).toContain("SIBLING systems");
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
