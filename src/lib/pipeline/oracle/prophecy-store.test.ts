import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { createProphecy, listPendingProphecies, listDueProphecies, listRecentProphecies, getProphecy, judgeProphecy, getProphecyCounts, getJudgedPropheciesForCalibration } from "./prophecy-store";

/**
 * TEST DATA HYGIENE (audit 9, 2026-11-22 — the "Test prophecy" flood).
 *
 * These tests exercise the REAL store against the LIVE operator DB
 * (same pattern as the rest of the suite — that integration value is
 * the point). But for their entire prior life every row they created
 * leaked: each run left one "Test prophecy" (pending, +24h) and one
 * "Test prophecy to judge" behind. Seven gauntlet runs later the
 * operator DB held 7 copies of each, and when the +24h horizons came
 * due the 5-min oracle scheduler judged them all FAILED — flooding
 * the operator console with a spam wave for hours. (The polluted
 * wave was observed live on 2026-11-22; the rows were purged in the
 * same audit-9 cleanup.)
 *
 * The hygiene contract, enforced on every run:
 *   1. SWEEP-BEFORE: any residue from a crashed/killed prior run is
 *      deleted before the suite touches the DB (self-healing).
 *   2. CLEANUP-AFTER: every created row is deleted in a finally
 *      block — normal runs leave nothing behind.
 *   3. SWEEP-AFTER + INVARIANT PIN: the suite ends with a sweep and
 *      a final assertion that the marker set matches ZERO rows, so a
 *      future edit that reintroduces leakage fails the gauntlet here
 *      instead of flooding the console a day later.
 *
 * The markers are exact-match only: domain "test-domain" is never
 * produced by the real generator ("general") or the self-prophecy
 * recorder ("self-prediction"), and the fixed claim strings are not
 * LLM-shapeable. Real prophecy rows can never match the sweep.
 */

/** The exact claim strings this suite (and oracle-task-feed.test.ts)
 *  creates. Shared constant so the sweep and the invariant pin can
 *  never drift from what the tests actually write. */
const TEST_PROPHECY_CLAIMS = [
  "Test prophecy",
  "Test prophecy to judge",
  "Broken-snapshot prophecy.",
  "No-filePath prophecy.",
  "Idempotency-check prophecy.",
  "The next push to GitHub will include a dependency install step.",
  "The next refactor mutation attempt on src/lib/pipeline/oracle/oracle-events.ts will pass all gates.",
] as const;

/** Delete every Prophecy row this test family could have created:
 *  the test domain marker, or one of the exact test claims. */
async function sweepTestProphecyResidue(): Promise<number> {
  const res = await db.prophecy.deleteMany({
    where: {
      OR: [
        { domain: "test-domain" },
        { claim: { in: [...TEST_PROPHECY_CLAIMS] } },
      ],
    },
  });
  return res.count;
}

/** Delete SelfTask rows the oracle-failed-prophecy feed queued for
 *  the test claims above (the feed embeds the claim in the task's
 *  evidence). Real self-prophecy claims always carry the
 *  "(typecheck + structural + debate)" qualifier — the exact test
 *  claims end at "all gates." — so a `contains` match on a test
 *  claim can never hit a real task. */
async function sweepTestSelfTaskResidue(): Promise<number> {
  const res = await db.selfTask.deleteMany({
    where: {
      kind: "oracle-failed-prophecy",
      OR: TEST_PROPHECY_CLAIMS.map((claim) => ({ evidence: { contains: claim } })),
    },
  });
  return res.count;
}

describe("prophecy-store", () => {
  beforeAll(async () => {
    await sweepTestProphecyResidue();
    await sweepTestSelfTaskResidue();
  });

  afterAll(async () => {
    await sweepTestProphecyResidue();
    await sweepTestSelfTaskResidue();
  });

  // Test createProphecy
  test("createProphecy returns the saved row on success", async () => {
    const now = new Date();
    const futureDate = new Date(now.getTime() + 86400000); // 1 day from now
    const input = {
      claim: "Test prophecy",
      confidence: 0.8,
      rationale: "Test rationale",
      falsifiabilityCriterion: "Test criterion",
      evaluateBy: futureDate,
      contextSha: "test-context",
      historySnapshot: "test-snapshot",
      domain: "test-domain",
    };

    try {
      const result = await createProphecy(input);

      expect(result).not.toBeNull();
      expect(result!.claim).toBe(input.claim);
      expect(result!.confidence).toBe(input.confidence);
      expect(result!.status).toBe("pending");
      expect(result!.contextSha).toBe(input.contextSha);
      expect(result!.historySnapshot).toBe(input.historySnapshot);
      expect(result!.domain).toBe(input.domain);
    } finally {
      // HYGIENE: never leave the created row behind (see header).
      if (input.claim === "Test prophecy") {
        await db.prophecy.deleteMany({ where: { claim: input.claim, domain: input.domain } });
      }
    }
  });

  // Test listPendingProphecies
  test("listPendingProphecies returns pending prophecies ordered by createdAt ascending", async () => {
    // This test assumes we have some pending prophecies in the database
    const prophecies = await listPendingProphecies();

    expect(Array.isArray(prophecies)).toBe(true);

    // Check if they're ordered by createdAt ascending
    for (let i = 1; i < prophecies.length; i++) {
      expect(new Date(prophecies[i].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(prophecies[i - 1].createdAt).getTime()
      );
    }
  });

  // Test listDueProphecies
  test("listDueProphecies returns pending prophecies whose evaluateBy is <= asOf", async () => {
    const now = new Date();
    const pastDate = new Date(now.getTime() - 86400000); // 1 day ago

    const prophecies = await listDueProphecies(pastDate);

    expect(Array.isArray(prophecies)).toBe(true);

    // Check if all returned prophecies are pending and due
    for (const prophecy of prophecies) {
      expect(prophecy.status).toBe("pending");
      expect(new Date(prophecy.evaluateBy).getTime()).toBeLessThanOrEqual(pastDate.getTime());
    }
  });

  // Test listRecentProphecies
  test("listRecentProphecies returns the most recent prophecies limited by the specified parameter", async () => {
    const limit = 5;
    const prophecies = await listRecentProphecies(limit);

    expect(Array.isArray(prophecies)).toBe(true);
    expect(prophecies.length).toBeLessThanOrEqual(limit);

    // Check if they're ordered by createdAt descending
    for (let i = 1; i < prophecies.length; i++) {
      expect(new Date(prophecies[i].createdAt).getTime()).toBeLessThanOrEqual(
        new Date(prophecies[i - 1].createdAt).getTime()
      );
    }
  });

  // Test getProphecy
  test("getProphecy returns a prophecy by ID or null if not found", async () => {
    // Test with a valid ID (assuming we have at least one prophecy)
    const allProphecies = await listRecentProphecies(1);
    if (allProphecies.length > 0) {
      const prophecy = await getProphecy(allProphecies[0].id);
      expect(prophecy).not.toBeNull();
      expect(prophecy!.id).toBe(allProphecies[0].id);
    }

    // Test with an invalid ID
    const invalidProphecy = await getProphecy("non-existent-id");
    expect(invalidProphecy).toBeNull();
  });

  // Test judgeProphecy
  test("judgeProphecy updates a prophecy's status, evaluation, and evaluatedAt", async () => {
    // Create a prophecy to judge
    const futureDate = new Date(new Date().getTime() + 86400000);
    const newProphecy = await createProphecy({
      claim: "Test prophecy to judge",
      confidence: 0.7,
      rationale: "Test rationale",
      falsifiabilityCriterion: "Test criterion",
      evaluateBy: futureDate,
    });

    try {
      if (!newProphecy) {
        throw new Error("Failed to create test prophecy");
      }

      // Judge the prophecy
      const verdict = "fulfilled";
      const evaluation = "Test evaluation";
      const judged = await judgeProphecy(newProphecy.id, verdict, evaluation);

      expect(judged).not.toBeNull();
      expect(judged!.status).toBe(verdict);
      expect(judged!.evaluation).toBe(evaluation);
      expect(judged!.evaluatedAt).not.toBeNull();

      // Verify the update persisted
      const updated = await getProphecy(newProphecy.id);
      expect(updated!.status).toBe(verdict);
      expect(updated!.evaluation).toBe(evaluation);
      expect(updated!.evaluatedAt).not.toBeNull();
    } finally {
      // HYGIENE: never leave the created+judged row behind (see header).
      if (newProphecy) {
        await db.prophecy.deleteMany({ where: { id: newProphecy.id } });
      }
    }
  });

  // Test getProphecyCounts
  test("getProphecyCounts returns counts for each status plus total", async () => {
    const counts = await getProphecyCounts();

    expect(typeof counts).toBe("object");
    expect(typeof counts.pending).toBe("number");
    expect(typeof counts.fulfilled).toBe("number");
    expect(typeof counts.failed).toBe("number");
    expect(typeof counts.retired).toBe("number");
    expect(typeof counts.total).toBe("number");

    // Verify total equals sum of all statuses
    expect(counts.total).toBe(
      counts.pending + counts.fulfilled + counts.failed + counts.retired
    );
  });

  // Test getJudgedPropheciesForCalibration
  test("getJudgedPropheciesForCalibration returns fulfilled and failed prophecies with confidence and status", async () => {
    const judged = await getJudgedPropheciesForCalibration();

    expect(Array.isArray(judged)).toBe(true);

    // Check if all returned prophecies are fulfilled or failed
    for (const prophecy of judged) {
      expect(["fulfilled", "failed"].includes(prophecy.status)).toBe(true);
      expect(typeof prophecy.confidence).toBe("number");
      expect(prophecy.confidence).toBeGreaterThanOrEqual(0);
      expect(prophecy.confidence).toBeLessThanOrEqual(1);
    }
  });

  // ── HYGIENE INVARIANT (audit 9) ──────────────────────────────────
  // Runs LAST (bun:test executes tests in file order). After the
  // per-test finally cleanups and one more sweep, ZERO rows may
  // match the test marker set. This is the pin that keeps the
  // "Test prophecy" flood class dead: if a future edit to this suite
  // leaks rows again, THIS test fails in the gauntlet immediately —
  // not 24 hours later as an operator-console spam wave when the
  // leaked horizons come due.
  test("suite leaves zero test-marker rows in the operator DB (pollution invariant)", async () => {
    await sweepTestProphecyResidue();
    await sweepTestSelfTaskResidue();
    const residue = await db.prophecy.findFirst({
      where: {
        OR: [
          { domain: "test-domain" },
          { claim: { in: [...TEST_PROPHECY_CLAIMS] } },
        ],
      },
    });
    expect(residue).toBeNull();
  });
});
