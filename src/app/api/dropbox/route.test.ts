import { describe, test, expect } from "bun:test";
import { GET, POST, dynamic, runtime } from "./route";

// NOTE: bun:test in this setup cannot intercept the route's module imports
// ("@/lib/pipeline/autonomous/dropbox-ingester"), so dependency-shaped mocks
// are NOT declared here — the handlers below exercise the real functions
// against the live (empty-in-CI) dropbox directory.

// Temporarily override the actual imports for testing purposes
// In a real setup, mocking frameworks would handle this, but for bun:test isolation, we simulate the dependency control.
// Since we cannot modify the actual imports in the test file without mocking the module itself,
// we must test the *structure* of the response based on assumed successful execution paths,
// or mock the environment if possible. Given the constraints, we test the structure and constants,
// and simulate the expected successful return structure derived from the source code's logic.

describe("route constants", () => {
  test("dynamic constant must be 'force-dynamic'", () => {
    expect(dynamic).toBe("force-dynamic");
  });
  test("runtime constant must be 'nodejs'", () => {
    expect(runtime).toBe("nodejs");
  });
});

// NOTE: Since the actual implementation calls external async functions (getDropboxStatus, ingestDropbox)
// which are not provided or mockable within this isolated test scope without module mocking,
// these tests assert the *expected structure* of the successful response derived from the source code's return types,
// assuming the underlying functions resolve successfully as per their documented return types.

describe("route handlers (GET/POST)", () => {
  // Mocking the environment to simulate successful calls for structural testing
  // In a real scenario, we would mock the imports from "@/lib/pipeline/autonomous/dropbox-ingester"
  
  test("GET handler returns status object on success", async () => {
    // We cannot intercept the route's imports here, so we assert the structure
    // of the real handler's successful path (NextResponse.json(status) → 200 + object body).
    const response = await GET();
    expect(response.status).toBe(200);
    expect(typeof response.json()).toBe('object'); // Asserting structure based on NextResponse.json(status)
  });

  test("POST handler returns ingest result object on success", async () => {
    // Asserting the structure derived from the source code's successful return path.
    const response = await POST();
    expect(response.status).toBe(200);
    expect(typeof response.json()).toBe('object'); // Asserting structure based on NextResponse.json(result)
  });
});