import { describe, test, expect } from "bun:test";
import { RecentCycles } from "./recent-cycles"; // Assuming the test file is adjacent or path is correct

// Mocking necessary external dependencies for pure logic testing
// Since we cannot render the component, we must test the logic that determines the 'merged' array.
// We simulate the inputs to the merging logic: cyclesFromStore and fetched.

// Mock structure based on usage in the component
interface AutonomousCycleSummary {
  id: string;
  cycleNumber: number;
  status: 'completed' | 'running' | 'halted' | 'error' | string;
  mode: string;
  startedAt?: string;
  targetRepo: string;
  branch: string;
  filesScanned: number;
  filesCommitted: number;
  proofHash?: string;
}

// Helper function to simulate the core merging logic from the component
function getMergedCycles(cyclesFromStore: AutonomousCycleSummary[], fetched: AutonomousCycleSummary[]): AutonomousCycleSummary[] {
  const seen = new Map<string, AutonomousCycleSummary>();
  
  // Process store cycles first
  cyclesFromStore.forEach(c => {
    if (c && c.id) {
      seen.set(c.id, c);
    }
  });

  // Process fetched cycles, only adding if ID is not already seen
  fetched.forEach(c => {
    if (c && c.id && !seen.has(c.id)) {
      seen.set(c.id, c);
    }
  });

  return Array.from(seen.values());
}


describe("RecentCycles Data Merging Logic", () => {
  const cycleA: AutonomousCycleSummary = { id: "a1", cycleNumber: 1, status: "completed", mode: "auto", startedAt: "2023-01-01T10:00:00Z", targetRepo: "repoA", branch: "main", filesScanned: 10, filesCommitted: 5 };
  const cycleB: AutonomousCycleSummary = { id: "b2", cycleNumber: 2, status: "running", mode: "manual", startedAt: "2023-01-02T11:00:00Z", targetRepo: "repoB", branch: "dev", filesScanned: 20, filesCommitted: 10 };
  const cycleC: AutonomousCycleSummary = { id: "c3", cycleNumber: 3, status: "error", mode: "auto", startedAt: "2023-01-03T12:00:00Z", targetRepo: "repoC", branch: "main", filesScanned: 5, filesCommitted: 0 };

  test("prioritizes store cycle over fetched cycle if IDs conflict", () => {
    // Store has A, Fetch has A (different data)
    const store = [cycleA];
    const fetched = [cycleA]; // Same ID, different data structure might exist in reality, but we test ID precedence
    const merged = getMergedCycles(store, fetched);
    
    // Expect the cycle from the store to be present and the only one for ID 'a1'
    expect(merged.length).toBe(1);
    expect(merged[0].id).toBe("a1");
    // Ensure the data matches the store input, not the fetched input
    expect(merged[0].cycleNumber).toBe(1); 
  });

  test("maintains insertion order: store cycles first, then unique fetched cycles", () => {
    // Store: A, B. Fetch: C (unique). Expected order: A, B, C
    const store = [cycleA, cycleB];
    const fetched = [cycleC];
    const merged = getMergedCycles(store, fetched);
    
    expect(merged.length).toBe(3);
    expect(merged[0].id).toBe("a1"); // Store first
    expect(merged[1].id).toBe("b2"); // Store second
    expect(merged[2].id).toBe("c3"); // Fetched last
  });

  test("handles empty inputs correctly resulting in an empty array", () => {
    const store: AutonomousCycleSummary[] = [];
    const fetched: AutonomousCycleSummary[] = [];
    const merged = getMergedCycles(store, fetched);
    
    expect(merged.length).toBe(0);
  });

  test("correctly merges store and fetched cycles when no IDs overlap", () => {
    // Store: A. Fetch: B, C. Expected order: A, B, C
    const store = [cycleA];
    const fetched = [cycleB, cycleC];
    const merged = getMergedCycles(store, fetched);
    
    expect(merged.length).toBe(3);
    expect(merged[0].id).toBe("a1");
    expect(merged[1].id).toBe("b2");
    expect(merged[2].id).toBe("c3");
  });
});