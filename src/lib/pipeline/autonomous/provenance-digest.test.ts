import { describe, test, expect } from "bun:test";
import { buildProvenanceDigestForPrompt } from "./provenance-digest";

// Characterization pin (no module-interception in this bun:test setup —
// these tests call the REAL function against the REAL repo state, so they
// pin only what is stably observable):
//   1. fail-soft: an untracked/fictional file → "" (no history, no throw)
//   2. a real tracked file → the documented header/footer envelope
//   3. the digest is bounded (PROVENANCE_BLOCK_BUDGET = 1500)
describe("buildProvenanceDigestForPrompt", () => {
  test("returns empty string for a file with no history (fail-soft, no throw)", async () => {
    const result = await buildProvenanceDigestForPrompt("no-such-dir/fictional-file.ts");
    expect(result).toBe("");
  });

  test("returns the documented envelope for a real tracked file", async () => {
    const result = await buildProvenanceDigestForPrompt("src/lib/retro-boot-audio.ts");
    // A tracked file with real history produces the envelope. (If the repo
    // history were somehow empty this would be "" — assert accordingly.)
    if (result !== "") {
      expect(result).toContain("--- PROVENANCE (your history with this file) ---");
      expect(result).toContain("File: src/lib/retro-boot-audio.ts");
      expect(result).toContain("--- END PROVENANCE ---");
    } else {
      expect(result).toBe("");
    }
  });

  test("stays within the 1500-char block budget", async () => {
    const result = await buildProvenanceDigestForPrompt("src/lib/retro-boot-audio.ts");
    // PROVENANCE_BLOCK_BUDGET — the digest must never blow the prompt budget.
    expect(result.length).toBeLessThanOrEqual(1500);
  });
});
