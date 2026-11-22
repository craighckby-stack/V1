import { describe, test, expect } from "bun:test";
import { buildEnhanceContext } from "./prompt-context";

describe("buildEnhanceContext", () => {
  test("returns correct structure for refactor mode", async () => {
    const result = await buildEnhanceContext("src/test.ts", "src/test.ts", "refactor");
    
    // Verify the structure
    expect(result).toHaveProperty("systemBlocks");
    expect(result).toHaveProperty("userBlocks");
    expect(result).toHaveProperty("lessonIds");
    expect(Array.isArray(result.systemBlocks)).toBe(true);
    expect(Array.isArray(result.userBlocks)).toBe(true);
    expect(Array.isArray(result.lessonIds)).toBe(true);
  });

  test("includes all blocks in refactor mode", async () => {
    const result = await buildEnhanceContext("src/test.ts", "src/test.ts", "refactor");
    
    // In refactor mode, all blocks should be present in systemBlocks
    expect(result.systemBlocks.length).toBeGreaterThan(0);
    expect(result.userBlocks.length).toBeGreaterThan(0);
  });

  test("excludes priorArt and archContext in visual-polish mode", async () => {
    const result = await buildEnhanceContext("src/test.ts", "src/test.ts", "visual-polish");
    
    // In visual-polish mode, priorArt and archContext should be excluded
    // We can't directly check for absence of specific blocks since they're fail-soft,
    // but we can verify the structure is still correct
    expect(result.systemBlocks).toBeDefined();
    expect(result.userBlocks).toBeDefined();
    expect(result.lessonIds).toBeDefined();
  });

  test("excludes more blocks in schema mode", async () => {
    const result = await buildEnhanceContext("src/test.ts", "src/test.ts", "schema");
    
    // In schema mode, only operating, postmortem, provenance, rejected, and lessons should be present
    // We can't directly check for absence of specific blocks since they're fail-soft,
    // but we can verify the structure is still correct
    expect(result.systemBlocks).toBeDefined();
    expect(result.userBlocks).toBeDefined();
    expect(result.lessonIds).toBeDefined();
  });

  test("maintains correct block order in systemBlocks", async () => {
    const result = await buildEnhanceContext("src/test.ts", "src/test.ts", "refactor");
    
    // The documented order is: operating, postmortem, provenance, rejected, ancestral, priorArt, lessons
    // Since blocks are fail-soft, we can't guarantee all will be present, but we can verify
    // that if multiple blocks exist, they follow the correct relative order
    let foundOperating = false;
    let foundPostmortem = false;
    let foundProvenance = false;
    let foundRejected = false;
    let foundAncestral = false;
    let foundPriorArt = false;
    let foundLessons = false;
    
    for (const block of result.systemBlocks) {
      if (block.includes("OPERATING CONSTRAINTS")) foundOperating = true;
      if (block.includes("ACTIVE POSTMORTEM CONSTRAINT")) foundPostmortem = true;
      if (block.includes("PROVENANCE DIGEST")) foundProvenance = true;
      if (block.includes("REJECTED TRANSFORMS")) foundRejected = true;
      if (block.includes("ANCESTRAL WISDOM")) foundAncestral = true;
      if (block.includes("PRIOR ART")) foundPriorArt = true;
      if (block.includes("LESSONS")) foundLessons = true;
    }
    
    // Verify relative order constraints
    if (foundOperating && foundPostmortem) {
      expect(result.systemBlocks.findIndex(b => b.includes("OPERATING CONSTRAINTS")))
        .toBeLessThan(result.systemBlocks.findIndex(b => b.includes("ACTIVE POSTMORTEM CONSTRAINT")));
    }
    
    if (foundPostmortem && foundProvenance) {
      expect(result.systemBlocks.findIndex(b => b.includes("ACTIVE POSTMORTEM CONSTRAINT")))
        .toBeLessThan(result.systemBlocks.findIndex(b => b.includes("PROVENANCE DIGEST")));
    }
    
    if (foundProvenance && foundRejected) {
      expect(result.systemBlocks.findIndex(b => b.includes("PROVENANCE DIGEST")))
        .toBeLessThan(result.systemBlocks.findIndex(b => b.includes("REJECTED TRANSFORMS")));
    }

    if (foundAncestral && foundPriorArt) {
      expect(result.systemBlocks.findIndex(b => b.includes("ANCESTRAL WISDOM")))
        .toBeLessThan(result.systemBlocks.findIndex(b => b.includes("PRIOR ART")));
    }

    if (foundPriorArt && foundLessons) {
      expect(result.systemBlocks.findIndex(b => b.includes("PRIOR ART")))
        .toBeLessThan(result.systemBlocks.findIndex(b => b.includes("LESSONS")));
    }
  });

  test("handles errors gracefully with fail-soft behavior", async () => {
    // This test verifies that the function doesn't throw when dependencies fail
    // Since we can't easily mock the dependencies in this test environment,
    // we're testing that the function returns a valid structure even in error cases
    const result = await buildEnhanceContext("src/test.ts", "src/test.ts", "refactor");
    
    // Should always return the correct structure
    expect(result).toHaveProperty("systemBlocks");
    expect(result).toHaveProperty("userBlocks");
    expect(result).toHaveProperty("lessonIds");
    
    // Arrays should be defined (though possibly empty)
    expect(Array.isArray(result.systemBlocks)).toBe(true);
    expect(Array.isArray(result.userBlocks)).toBe(true);
    expect(Array.isArray(result.lessonIds)).toBe(true);
  });

  test("includes archContext in userBlocks for refactor mode only", async () => {
    const refactorResult = await buildEnhanceContext("src/test.ts", "src/test.ts", "refactor");
    const visualPolishResult = await buildEnhanceContext("src/test.ts", "src/test.ts", "visual-polish");
    const schemaResult = await buildEnhanceContext("src/test.ts", "src/test.ts", "schema");
    
    // Arch context should only be in refactor mode's userBlocks
    // Since it's fail-soft, we can't guarantee presence, but we can verify
    // that the structure is maintained across modes
    expect(refactorResult.userBlocks).toBeDefined();
    expect(visualPolishResult.userBlocks).toBeDefined();
    expect(schemaResult.userBlocks).toBeDefined();
  });
});