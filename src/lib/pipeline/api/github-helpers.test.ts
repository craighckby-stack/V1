import { describe, test, expect } from "bun:test";
import { getUsableToken, githubHeaders } from "./github-helpers";

describe("github-helpers", () => {
  describe("getUsableToken", () => {
    test("returns null for undefined input", () => {
      expect(getUsableToken(undefined)).toBeNull();
    });

    test("returns null for empty string input", () => {
      expect(getUsableToken("")).toBeNull();
    });

    test("returns null for whitespace-only input", () => {
      expect(getUsableToken("   ")).toBeNull();
    });

    test("returns null for token shorter than MIN_TOKEN_LENGTH", () => {
      expect(getUsableToken("short")).toBeNull();
    });

    test("returns null for token with invalid prefix", () => {
      expect(getUsableToken("MY_token123")).toBeNull();
    });

    test("returns null for token containing invalid value", () => {
      expect(getUsableToken("some[REDACTED]token")).toBeNull();
    });

    test("returns trimmed token that meets all requirements", () => {
      expect(getUsableToken("  valid_token123  ")).toBe("valid_token123");
    });

    test("returns valid token without trimming if already trimmed", () => {
      expect(getUsableToken("valid_token123")).toBe("valid_token123");
    });
  });

  describe("githubHeaders", () => {
    test("returns headers without Authorization when token is null", () => {
      const headers = githubHeaders(null);
      expect(headers).toEqual({
        "User-Agent": "Architecture-Helper-Pipeline",
        Accept: "application/vnd.github.v3+json",
      });
      expect(headers).not.toHaveProperty("Authorization");
    });

    test("returns headers with Authorization for valid token", () => {
      const headers = githubHeaders("valid_token123");
      expect(headers).toEqual({
        "User-Agent": "Architecture-Helper-Pipeline",
        Accept: "application/vnd.github.v3+json",
        Authorization: "Bearer valid_token123",
      });
    });

    test("throws error for token shorter than MIN_TOKEN_LENGTH", () => {
      expect(() => githubHeaders("short")).toThrow(
        "Invalid token provided: must be at least 8 characters long. Received: 5 characters"
      );
    });

    test("throws error for whitespace-only token", () => {
      expect(() => githubHeaders("   ")).toThrow(
        "Invalid token provided: must be at least 8 characters long. Received: 0 characters"
      );
    });

    test("trims token before validation and adding to headers", () => {
      const headers = githubHeaders("  valid_token123  ");
      expect(headers).toEqual({
        "User-Agent": "Architecture-Helper-Pipeline",
        Accept: "application/vnd.github.v3+json",
        Authorization: "Bearer valid_token123",
      });
    });
  });
});