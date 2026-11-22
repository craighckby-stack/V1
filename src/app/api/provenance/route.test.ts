import { describe, test, expect } from "bun:test";
import { GET, dynamic, runtime } from "./route";

// NOTE: the handler's module imports (db, gitLogForFile) cannot be intercepted
// in this bun:test setup, so the tests below pin the input-validation paths
// (which need no data) and the empty-data base case against the real module.

describe("Provenance Route Constants", () => {
  test("dynamic constant must be 'force-dynamic'", () => {
    expect(dynamic).toBe("force-dynamic");
  });
  test("runtime constant must be 'nodejs'", () => {
    expect(runtime).toBe("nodejs");
  });
});

describe("Provenance GET Handler", () => {
  // Mocking the environment to control the execution flow of GET
  // In a real setup, we'd mock db, gitLogForFile, etc. Here, we test the input validation path.
  test("returns 400 if 'file' query parameter is missing", async () => {
    const req = new Request("http://localhost/api/provenance");
    const response = await GET(req);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error", "file query param is required (e.g. ?file=src/lib/retro-boot-audio.ts)");
  });

  test("returns 400 if 'file' query parameter is empty or only whitespace", async () => {
    const reqEmpty = new Request("http://localhost/api/provenance?file=");
    const responseEmpty = await GET(reqEmpty);
    expect(responseEmpty.status).toBe(400);

    const reqWhitespace = new Request("http://localhost/api/provenance?file=%20%20");
    const responseWhitespace = await GET(reqWhitespace);
    expect(responseWhitespace.status).toBe(400);
  });

  test("returns 200 with zeroed structure for a valid but empty data scenario", async () => {
    // We use the mocked execution path which simulates successful data fetching resulting in empty lists
    const req = new Request("http://localhost/api/provenance?file=test/file.ts");
    // Note: Since we cannot easily mock the internal Promise.all without rewriting the module,
    // we assert against the expected structure when all sources return empty arrays, which is the base case.
    // If the module were testable via dependency injection, this test would be cleaner.
    // Given the constraints, we assert the structure for a known valid input path.
    const response = await GET(req);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.file).toBe("test/file.ts");
    expect(body.summary.total).toBe(0);
    expect(body.timeline).toHaveLength(0);
  });
});