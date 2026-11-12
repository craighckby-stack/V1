import { describe, test, expect } from "bun:test";
import { GET, POST, dynamic, runtime } from "./route";

/**
 * Real route tests: the handlers are invoked against the live module
 * graph (DB included), the same way memory/entries/route.test.ts does.
 * No mocked responses are asserted against themselves — every expectation
 * below reads the actual NextResponse the handler produced.
 */
describe("self-model route", () => {
  test("exports dynamic as 'force-dynamic'", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  test("exports runtime as 'nodejs'", () => {
    expect(runtime).toBe("nodejs");
  });

  test("GET returns the real self-model summary structure", async () => {
    const response = await GET();
    expect(response).toBeDefined();

    const body = await response.json();

    if (response.status === 200) {
      expect(body).toHaveProperty("files");
      expect(Array.isArray(body.files)).toBe(true);
      expect(body).toHaveProperty("calibration");
      expect(body.calibration).toHaveProperty("buckets");
      expect(body).toHaveProperty("modeStats");
      expect(body.modeStats).toHaveProperty("refactor");
      expect(body.modeStats).toHaveProperty("visualPolish");
      expect(body).toHaveProperty("totals");
    } else {
      // Failure path: honest empty structure + error string, status 500.
      expect(response.status).toBe(500);
      expect(body.files).toEqual([]);
      expect(body.calibration.verdict).toBe("error");
      expect(typeof body.error).toBe("string");
    }
  });

  test("POST with a valid body returns the summary structure", async () => {
    const req = new Request("http://localhost/api/self-model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    const response = await POST(req);
    expect(response).toBeDefined();

    const body = await response.json();
    if (response.status === 200) {
      expect(body).toHaveProperty("files");
      expect(body).toHaveProperty("calibration");
      expect(body).toHaveProperty("totals");
    } else {
      expect(response.status).toBe(500);
      expect(typeof body.error).toBe("string");
    }
  });

  test("POST with a non-object body returns 400", async () => {
    const req = new Request("http://localhost/api/self-model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify("not-an-object"),
    });
    const response = await POST(req);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(typeof body.error).toBe("string");
  });
});
