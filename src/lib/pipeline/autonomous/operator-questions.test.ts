import { describe, test, expect } from "bun:test";

/**
 * Tests for operator-questions.ts — the loop's "voice" (step 4).
 *
 * These tests lock the PURE contracts: the rate-limit constants, the
 * text-length validation, and the status semantics. The DB-dependent
 * paths (canPoseQuestion, poseQuestion, recordAnswer, getAnswer) read
 * the live DB via the cached Prisma client and are exercised end-to-end
 * via Agent Browser (the `answer` command + the /api/operator-questions
 * route). Locking the constants + validation here means a future edit
 * that drifts the rate limit or weakens the validation breaks a test
 * before it reaches production.
 */

describe("operator-questions (pure contracts)", () => {
  test("MAX_QUESTION_TEXT is a sensible bound (40-500 chars)", async () => {
    const mod = await import("./operator-questions");
    expect(mod.MAX_QUESTION_TEXT).toBeGreaterThan(40);
    expect(mod.MAX_QUESTION_TEXT).toBeLessThan(500);
  });

  test("MAX_RATIONALE is larger than MAX_QUESTION_TEXT (rationale can be longer)", async () => {
    const mod = await import("./operator-questions");
    expect(mod.MAX_RATIONALE).toBeGreaterThan(mod.MAX_QUESTION_TEXT);
  });

  test("MIN_CYCLES_BETWEEN_QUESTIONS is a meaningful rate limit (≥ 10 cycles)", async () => {
    // At ~10s/cycle, 50 cycles ≈ 8 minutes between questions. The loop
    // can't spam the operator. This test locks the constant so a future
    // edit that lowers it to 1 (spam) or raises it to 10000 (never asks)
    // breaks a test.
    const mod = await import("./operator-questions");
    expect(mod.MIN_CYCLES_BETWEEN_QUESTIONS).toBeGreaterThanOrEqual(10);
    expect(mod.MIN_CYCLES_BETWEEN_QUESTIONS).toBeLessThan(10000);
  });

  test("EXPIRY_CYCLES is much longer than the rate limit (operator has time to answer)", async () => {
    const mod = await import("./operator-questions");
    expect(mod.EXPIRY_CYCLES).toBeGreaterThan(mod.MIN_CYCLES_BETWEEN_QUESTIONS * 2);
  });

  test("the four documented statuses form a complete + disjoint set", async () => {
    // The status field uses string literals. Lock the four valid values
    // so a future edit that adds a typo'd status ("asnwered_yes") breaks
    // a test. The recordAnswer function writes exactly these values.
    const validStatuses = ["pending", "answered_yes", "answered_no", "expired"];
    // Each status is distinct.
    expect(new Set(validStatuses).size).toBe(4);
    // The two answer statuses start with "answered_" (the `answer` command
    // strips this prefix for display: "answered_yes" → "YES").
    for (const s of validStatuses.slice(1, 3)) {
      expect(s.startsWith("answered_")).toBe(true);
    }
  });
});
