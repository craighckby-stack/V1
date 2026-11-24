/**
 * operator-touch tests — NON-WRITING pattern (operator, 2026-11-24).
 *
 * WHY THIS SHAPE: the health monitor's baseline snapshot runs `bun test`
 * against this repo every 15 minutes, INSIDE the live sandbox. The
 * original version of this suite called the real markOperatorTouch()
 * with test dates — which wrote the PRODUCTION touch file
 * (.git/info/loop-operator-touch.json) on every health snapshot,
 * feeding the dead-man's switch garbage timestamps (mid-suite it held
 * 24h-old and invalid dates; the same snapshot run was also observed
 * corrupting the sibling armed-state tier). markOperatorTouch now has
 * a BUN_TEST/VITEST origin guard (same as markArmed) that refuses all
 * test-origin writes, so this suite pins the CONTRACT without writing:
 *   - write paths assert not.toThrow() only
 *   - read paths assert shape conditionally (null OR well-formed)
 * This mirrors armed-state.test.ts, the established convention for
 * wipe-proof-tier modules with test-origin guards.
 */

import { describe, test, expect } from "bun:test";
import {
  markOperatorTouch,
  readOperatorTouch,
  isDeadMansTripped,
  DEFAULT_DEAD_MANS_THRESHOLD_MS,
} from "./operator-touch";

describe("operator-touch", () => {
  test("DEFAULT_DEAD_MANS_THRESHOLD_MS is 24 hours in milliseconds", () => {
    expect(DEFAULT_DEAD_MANS_THRESHOLD_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("markOperatorTouch never throws on valid input (guard-compatible)", () => {
    // The test-origin guard refuses the write under BUN_TEST=1 — the
    // contract being pinned is "valid input never throws", not "the
    // production file changed". Direct write verification is impossible
    // by design (see the file header).
    expect(() =>
      markOperatorTouch("operator-test", new Date("2023-01-01T12:00:00.000Z"))
    ).not.toThrow();
    expect(() => markOperatorTouch("operator-start")).not.toThrow();
  });

  test("markOperatorTouch validates by parameter without throwing", () => {
    expect(() => markOperatorTouch("")).not.toThrow();
    expect(() => markOperatorTouch("   ")).not.toThrow();
    expect(() => markOperatorTouch(123 as unknown as string)).not.toThrow();
    expect(() => markOperatorTouch(null as unknown as string)).not.toThrow();
  });

  test("readOperatorTouch returns null or a well-formed state", () => {
    // Absent/unreadable/malformed → null (fail-closed); a valid tier
    // read → the documented shape. Both are acceptable here because the
    // suite never writes the file — see the header note.
    const state = readOperatorTouch();
    if (state !== null) {
      expect(typeof state.at).toBe("string");
      expect(typeof state.by).toBe("string");
      expect(state.by.trim().length).toBeGreaterThan(0);
    }
  });

  test("readOperatorTouch returns an ISO-parseable at when present", () => {
    const state = readOperatorTouch();
    if (state !== null) {
      expect(Number.isNaN(Date.parse(state.at))).toBe(false);
    }
  });

  test("isDeadMansTripped is true when the touch is older than the threshold", () => {
    // A 1ms threshold: any real touch on record is >1ms old by the time
    // this check runs. RACE GUARD: a LIVE writer (the cron delegate's
    // daily touch, or a production start()) can stamp the file within
    // this same millisecond — only assert when the observed state is
    // comfortably old; a just-written touch is legitimately not-tripped.
    const state = readOperatorTouch();
    const observedAgeMs = state ? Date.now() - Date.parse(state.at) : null;
    if (observedAgeMs === null || observedAgeMs > 100) {
      expect(isDeadMansTripped(1)).toBe(true);
    }
  });

  test("isDeadMansTripped is false when the touch is within the threshold", () => {
    // MAX_SAFE_INTEGER threshold: any recorded touch (which is at most
    // ~57 years old) is within it. Conditional because a machine with
    // NO touch file on record correctly reports tripped even for a
    // huge threshold — absent ≠ recent (fail-closed contract).
    const state = readOperatorTouch();
    if (state !== null) {
      expect(isDeadMansTripped(Number.MAX_SAFE_INTEGER)).toBe(false);
    }
  });

  test("isDeadMansTripped respects a custom threshold", () => {
    // Explicit tiny thresholds behave like the "older than" case above
    // (race-guarded the same way against live writers); invalid
    // thresholds (NaN) are treated as tripped per the module contract —
    // the NaN guard was itself a live bug fix (NaN < 0 is false, so NaN
    // previously escaped the invalid-threshold check and always
    // returned false — the inverse of fail-closed).
    const state = readOperatorTouch();
    const observedAgeMs = state ? Date.now() - Date.parse(state.at) : null;
    if (observedAgeMs === null || observedAgeMs > 100) {
      expect(isDeadMansTripped(1)).toBe(true);
      expect(isDeadMansTripped(0)).toBe(true);
    }
    expect(isDeadMansTripped(NaN)).toBe(true);
  });
});
