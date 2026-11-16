import { describe, test, expect } from "bun:test";
import { GET, dynamic, runtime } from "./route";

// Mocking external dependencies required for GET function execution path testing
// Since we cannot mock Next.js Request/NextResponse easily in a pure bun:test environment
// without mocking the entire module context, we focus on testing the constant exports
// and simulating the expected behavior paths based on input validation logic.

describe("Constants", () => {
  test("dynamic constant must be 'force-dynamic'", () => {
    expect(dynamic).toBe("force-dynamic");
  });
  test("runtime constant must be 'nodejs'", () => {
    expect(runtime).toBe("nodejs");
  });
});

// Note: Testing the async GET function requires mocking emgRagInstance and Request,
// which is outside the scope of simple observable contract pinning without a full mocking framework.
// We test the input validation logic paths which are pure based on request parameters.

describe("GET function input validation", () => {
  // Mocking a minimal Request object structure for testing URL parsing
  const createMockRequest = (query: string): Request => {
    const url = new URL(`http://localhost/api/memory/query?${query}`);
    return { url, text: () => Promise.resolve("") } as unknown as Request;
  };

  test("returns 400 if query parameter 'q' is missing", async () => {
    const req = createMockRequest(""); // No ?q=
    // We expect the specific 400 response body structure defined in the implementation
    const response = await GET(req);
    expect(response.status).toBe(400);
    // Asserting the specific error message structure
    const body = await response.json();
    expect(body.error).toContain("Missing or invalid ?q=<query> parameter");
  });

  test("returns 400 if query parameter 'q' is an empty string", async () => {
    const req = createMockRequest("q="); // q= but no value
    const response = await GET(req);
    expect(response.status).toBe(400);
  });

  test("returns 400 if query parameter 'q' is only whitespace", async () => {
    const req = createMockRequest("q=%20%20"); // URL encoded spaces
    const response = await GET(req);
    expect(response.status).toBe(400);
  });

  test("returns 400 if query length exceeds 1000 characters", async () => {
    const longQuery = "a".repeat(1001);
    const req = createMockRequest(`q=${encodeURIComponent(longQuery)}`);
    const response = await GET(req);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Query too long. Maximum length is 1000 characters.");
  });
});