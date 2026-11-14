import { describe, test, expect } from "bun:test";
import { createProphecy, listPendingProphecies, listDueProphecies, listRecentProphecies, getProphecy, judgeProphecy, getProphecyCounts, getJudgedPropheciesForCalibration } from "./prophecy-store";

describe("prophecy-store", () => {
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
    
    const result = await createProphecy(input);
    
    expect(result).not.toBeNull();
    expect(result?.claim).toBe(input.claim);
    expect(result?.confidence).toBe(input.confidence);
    expect(result?.status).toBe("pending");
    expect(result?.contextSha).toBe(input.contextSha);
    expect(result?.historySnapshot).toBe(input.historySnapshot);
    expect(result?.domain).toBe(input.domain);
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
      expect(prophecy?.id).toBe(allProphecies[0].id);
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
    
    if (!newProphecy) {
      throw new Error("Failed to create test prophecy");
    }
    
    // Judge the prophecy
    const verdict = "fulfilled";
    const evaluation = "Test evaluation";
    const judged = await judgeProphecy(newProphecy.id, verdict, evaluation);
    
    expect(judged).not.toBeNull();
    expect(judged?.status).toBe(verdict);
    expect(judged?.evaluation).toBe(evaluation);
    expect(judged?.evaluatedAt).not.toBeNull();
    
    // Verify the update persisted
    const updated = await getProphecy(newProphecy.id);
    expect(updated?.status).toBe(verdict);
    expect(updated?.evaluation).toBe(evaluation);
    expect(updated?.evaluatedAt).not.toBeNull();
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
});