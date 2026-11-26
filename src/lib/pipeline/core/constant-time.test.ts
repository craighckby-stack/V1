/**
 * constant-time.test.ts — tests for the shared secret-compare helper
 * (audit F, 2026-11-26: the security module had zero test coverage).
 *
 * These tests verify the FUNCTIONAL contract (correct match/no-match
 * behavior, empty-input fail-closed). Timing properties (constant-time
 * execution) cannot be asserted reliably in a unit test — they're
 * guaranteed by construction (sha256 digest + timingSafeEqual on
 * equal-length buffers), not by measurement.
 */

import { describe, test, expect } from "bun:test";
import { constantTimeEqual } from "./constant-time";

describe("constantTimeEqual", () => {
  test("identical strings match", () => {
    expect(constantTimeEqual("secret-value", "secret-value")).toBe(true);
    expect(constantTimeEqual("691", "691")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(false); // empty input → fail-closed
  });

  test("different strings do NOT match", () => {
    expect(constantTimeEqual("secret-value", "wrong-value")).toBe(false);
    expect(constantTimeEqual("691", "4444")).toBe(false);
    expect(constantTimeEqual("691", "692")).toBe(false);
  });

  test("null / undefined / empty provided → false (fail-closed)", () => {
    expect(constantTimeEqual(null, "expected")).toBe(false);
    expect(constantTimeEqual(undefined, "expected")).toBe(false);
    expect(constantTimeEqual("", "expected")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(false);
  });

  test("empty expected → false (nothing can match an unset secret)", () => {
    expect(constantTimeEqual("provided", "")).toBe(false);
  });

  test("prefix of the secret does NOT match (no partial credit)", () => {
    expect(constantTimeEqual("sec", "secret")).toBe(false);
    expect(constantTimeEqual("secret", "sec")).toBe(false);
  });

  test("length differences don't leak (short vs long never match)", () => {
    expect(constantTimeEqual("a", "aaaaaaaaaa")).toBe(false);
    expect(constantTimeEqual("aaaaaaaaaa", "a")).toBe(false);
  });

  test("unicode / special characters work correctly", () => {
    expect(constantTimeEqual("pässwörd!", "pässwörd!")).toBe(true);
    expect(constantTimeEqual("pässwörd!", "password!")).toBe(false);
  });

  test("typical PIN values (operator + master tiers)", () => {
    // The real deployment uses operator PIN 691 and master PIN 4444.
    expect(constantTimeEqual("691", "691")).toBe(true);
    expect(constantTimeEqual("4444", "4444")).toBe(true);
    expect(constantTimeEqual("691", "4444")).toBe(false);
    expect(constantTimeEqual("4444", "691")).toBe(false);
    // A PIN submitted with surrounding whitespace (trimmed by callers)
    expect(constantTimeEqual(" 691 ", "691")).toBe(false); // caller trims before compare
  });

  test("API-key-length strings work (32-64 char tokens)", () => {
    const key32 = "a".repeat(32);
    const key64 = "b".repeat(64);
    expect(constantTimeEqual(key32, key32)).toBe(true);
    expect(constantTimeEqual(key64, key64)).toBe(true);
    expect(constantTimeEqual(key32, key64)).toBe(false);
    expect(constantTimeEqual(key32, "a".repeat(31) + "b")).toBe(false);
  });
});
