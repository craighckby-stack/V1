import { describe, test, expect } from "bun:test";
import { GET, dynamic, runtime } from "./route";

describe("memory entries route", () => {
  test("exports dynamic as 'force-dynamic'", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  test("exports runtime as 'nodejs'", () => {
    expect(runtime).toBe("nodejs");
  });

  test("GET returns entries array after ensuring seeding", async () => {
    // The implementation calls emgRagInstance.ensureSeeded() then emgRagInstance.getAll()
    // The expected response is NextResponse.json({ entries: VectorEntry[] })
    const response = await GET();
    
    // Check response structure
    expect(response).toBeDefined();
    expect(response.status).toBe(200);
    
    // Check that the response has a body with entries property
    const body = await response.json();
    expect(body).toHaveProperty("entries");
    expect(Array.isArray(body.entries)).toBe(true);
  });

  // (Cripple-check F17: the former "GET returns 500 error" test was
  // VACUOUS — it constructed a local {status:500, body:{...}} literal and
  // asserted on it, never executing the route's error path. Deleted; the
  // error path needs real dependency mocking to test honestly.)
});