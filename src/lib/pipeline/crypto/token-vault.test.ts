import { describe, test, expect } from "bun:test";
import { isSealedEnvelope, sealToken, openToken, vaultStatus } from "./token-vault";

describe("token-vault", () => {
  describe("isSealedEnvelope", () => {
    test("returns true for valid sealed envelopes", () => {
      expect(isSealedEnvelope("enc:v1:.abc.def.ghi")).toBe(true);
    });
    
    test("returns false for strings without the prefix", () => {
      expect(isSealedEnvelope("not-an-envelope")).toBe(false);
    });
    
    test("returns false for non-string inputs", () => {
      expect(isSealedEnvelope(123 as unknown as string)).toBe(false);
      expect(isSealedEnvelope(null as unknown as string)).toBe(false);
      expect(isSealedEnvelope(undefined as unknown as string)).toBe(false);
    });
    
    test("returns false for empty string", () => {
      expect(isSealedEnvelope("")).toBe(false);
    });
  });
  
  describe("sealToken", () => {
    test("returns unchanged value for already sealed envelope", () => {
      const sealed = "enc:v1:.abc.def.ghi";
      expect(sealToken(sealed)).toBe(sealed);
    });
    
    test("returns unchanged value for empty string", () => {
      expect(sealToken("")).toBe("");
    });
    
    test("returns unchanged value for whitespace-only string", () => {
      expect(sealToken("   ")).toBe("   ");
    });
    
    test("returns unchanged value for short token", () => {
      expect(sealToken("short")).toBe("short");
    });
    
    test("returns unchanged value for token with whitespace", () => {
      expect(sealToken("token with space")).toBe("token with space");
    });
    
    test("returns sealed envelope for valid token", () => {
      const token = "ghp_validGitHubToken123";
      const sealed = sealToken(token);
      expect(sealed).not.toBe(token);
      expect(isSealedEnvelope(sealed)).toBe(true);
      expect(sealed.startsWith("enc:v1:")).toBe(true);
      expect(sealed.split(".").length).toBe(3);
    });
  });
  
  describe("openToken", () => {
    test("returns plaintext for non-envelope input", () => {
      expect(openToken("plaintext")).toBe("plaintext");
    });
    
    test("returns empty string for null input", () => {
      expect(openToken(null as unknown as string)).toBe("");
    });
    
    test("returns empty string for undefined input", () => {
      expect(openToken(undefined as unknown as string)).toBe("");
    });
    
    test("returns empty string for empty string input", () => {
      expect(openToken("")).toBe("");
    });
    
    test("returns decrypted token for valid sealed envelope", () => {
      const token = "ghp_validGitHubToken123";
      const sealed = sealToken(token);
      const opened = openToken(sealed);
      expect(opened).toBe(token);
    });
    
    test("returns empty string for malformed envelope (wrong parts count)", () => {
      expect(openToken("enc:v1:.abc")).toBe("");
    });
    
    test("returns empty string for malformed envelope (invalid base64url)", () => {
      expect(openToken("enc:v1:invalid.invalid.invalid")).toBe("");
    });
  });
  
  describe("vaultStatus", () => {
    test("returns correct status when key is present", () => {
      const status = vaultStatus();
      expect(status).toEqual({
        sealed: true,
        cipher: "AES-256-GCM",
        keyPresent: true,
        keyFile: ".git/info/loop-vault-key"
      });
    });
  });
});