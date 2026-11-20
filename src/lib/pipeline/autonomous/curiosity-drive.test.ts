import { describe, test, expect } from "bun:test";
import {
  curiosityBonusForFile,
  BORED_THRESHOLD,
  MAX_CURIOSITY_BONUS,
  type CuriosityState,
} from "./curiosity-drive";

/**
 * Tests for curiosity-drive.ts — the "get bored when too confident" drive.
 *
 * The pure logic (curiosityBonusForFile + the threshold constants) is
 * testable without DB / self-model / health-trend. The state-computation
 * function (computeCuriosityState) reads DB + trend and is exercised
 * via the Agent Browser end-to-end; these tests lock the per-file bonus
 * rule and the threshold contracts.
 */

function makeState(overrides: Partial<CuriosityState> = {}): CuriosityState {
  return {
    enabled: false,
    firing: false,
    brierScore: null,
    healthTrend: null,
    reason: "",
    ...overrides,
  };
}

describe("curiosityBonusForFile", () => {
  test("returns 0 when the drive is disabled", () => {
    const bonus = curiosityBonusForFile(0.5, makeState({ enabled: false }));
    expect(bonus).toBe(0);
  });

  test("returns 0 when the drive is enabled but not firing", () => {
    const bonus = curiosityBonusForFile(
      0.5,
      makeState({ enabled: true, firing: false }),
    );
    expect(bonus).toBe(0);
  });

  test("boosts low-confidence files when firing (low pass rate → bigger bonus)", () => {
    const state = makeState({ enabled: true, firing: true });
    // A file the loop is bad at (0.2 pass rate) gets a big bonus.
    const lowConf = curiosityBonusForFile(0.2, state);
    // A file the loop is good at (0.9 pass rate) gets a small bonus.
    const highConf = curiosityBonusForFile(0.9, state);
    expect(lowConf).toBeGreaterThan(highConf);
    expect(lowConf).toBeGreaterThan(0);
  });

  test("never exceeds MAX_CURIOSITY_BONUS even for 0-confidence files", () => {
    const state = makeState({ enabled: true, firing: true });
    const bonus = curiosityBonusForFile(0, state);
    expect(bonus).toBeLessThanOrEqual(MAX_CURIOSITY_BONUS);
  });

  test("a 0.5-confidence file (no history) gets no double-counting bonus", () => {
    // The bandit's exploration term already favors untried files; curiosity
    // shouldn't double-count. (1 - 0.5) * scale = 0.15 — not zero, but
    // smaller than the low-confidence case. This locks the contract.
    const state = makeState({ enabled: true, firing: true });
    const bonus = curiosityBonusForFile(0.5, state);
    expect(bonus).toBeGreaterThan(0);
    expect(bonus).toBeLessThan(MAX_CURIOSITY_BONUS);
  });

  test("a 1.0-confidence file gets zero bonus (the loop is certain — no curiosity)", () => {
    const state = makeState({ enabled: true, firing: true });
    const bonus = curiosityBonusForFile(1.0, state);
    expect(bonus).toBe(0);
  });

  test("bonus is monotonic in confidence (lower confidence → higher bonus)", () => {
    const state = makeState({ enabled: true, firing: true });
    const bonuses: number[] = [];
    for (let conf = 0; conf <= 1.0; conf += 0.1) {
      bonuses.push(curiosityBonusForFile(conf, state));
    }
    // Each step should be ≤ the previous (monotonic non-increasing as
    // confidence rises).
    for (let i = 1; i < bonuses.length; i++) {
      expect(bonuses[i]).toBeLessThanOrEqual(bonuses[i - 1]);
    }
  });
});

describe("threshold contracts", () => {
  test("BORED_THRESHOLD is a reasonable value (well-calibrated territory)", () => {
    // 0.08 is well-calibrated per the self-model's verdict scale. Below
    // this, the loop "knows what it's doing". This test locks the constant
    // so a future edit doesn't drift it to a value that never fires or
    // always fires.
    expect(BORED_THRESHOLD).toBeGreaterThan(0);
    expect(BORED_THRESHOLD).toBeLessThan(0.5);
  });

  test("MAX_CURIOSITY_BONUS sits below the exhaustion penalty (0.35)", () => {
    // The exhaustion penalty in the bandit is 0.35. Curiosity must NOT
    // un-sink a finished file — the cap keeps the bonus below exhaustion.
    expect(MAX_CURIOSITY_BONUS).toBeLessThan(0.35);
    expect(MAX_CURIOSITY_BONUS).toBeGreaterThan(0);
  });
});
