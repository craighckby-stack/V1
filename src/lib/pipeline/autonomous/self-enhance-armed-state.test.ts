import { describe, test, expect } from "bun:test";
import { markSelfEnhanceArmed, readSelfEnhanceArmedState, type SelfEnhanceArmedState } from "./self-enhance-armed-state";

// CHARACTERIZATION SCOPE (deliberately narrow — see below):
// This module writes a WIPE-PROOF armed-intent file under .git/info/ that the
// boot auto-start reads. bun:test cannot intercept its module imports, so a
// happy-path write test would mutate the operator's LIVE armed state (a stray
// `bun test` would re-arm the loop — test pollution of a safety-relevant
// tier). Therefore the happy-path write is deliberately NOT exercised here;
// only the guard paths (which provably do not write) and the read contract
// (which is side-effect-free) are pinned.
describe("SelfEnhanceArmedState Contract", () => {
  test("markSelfEnhanceArmed rejects non-boolean 'armed' input without throwing", () => {
    // Guard: typeof armed !== "boolean" → console.error + return (no write).
    expect(() => markSelfEnhanceArmed("true" as unknown as boolean, "test")).not.toThrow();
  });

  test("markSelfEnhanceArmed rejects empty string 'by' input without throwing", () => {
    // Guard: by.trim().length === 0 → console.error + return (no write).
    expect(() => markSelfEnhanceArmed(true, " ")).not.toThrow();
  });

  test("readSelfEnhanceArmedState never fabricates: null or structurally-valid state, nothing else", () => {
    // The read is side-effect-free and honest regardless of live state:
    // absent/unreadable/malformed file → null; valid file → the exact shape.
    const result = readSelfEnhanceArmedState();
    if (result === null) {
      expect(result).toBeNull();
    } else {
      const state: SelfEnhanceArmedState = result;
      expect(typeof state.armed).toBe("boolean");
      expect(typeof state.at).toBe("string");
      expect(state.at.length).toBeGreaterThan(0);
      expect(typeof state.by).toBe("string");
      expect(state.by.trim().length).toBeGreaterThan(0);
    }
  });

  test("SelfEnhanceArmedState's validated shape is { armed, at, by }", () => {
    // Type-level pin: a valid state literal must satisfy the interface.
    const validState: SelfEnhanceArmedState = {
      armed: true,
      at: "2024-01-01T00:00:00.000Z",
      by: "operator-start",
    };
    expect(validState.armed).toBe(true);
    expect(validState.by.length).toBeGreaterThan(0);
  });
});
