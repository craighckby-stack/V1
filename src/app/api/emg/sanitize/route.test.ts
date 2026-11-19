import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Real route tests for POST /api/emg/sanitize.
 *
 * The sanitizer dependency is replaced with a bun:test mock.module fake
 * BEFORE the route is imported, so the route binds to the fake. Every
 * test invokes the real POST handler with a real Request and asserts on
 * the actual NextResponse — never on a hand-rolled reimplementation.
 *
 * Pinned contract:
 *   - invalid JSON body        → 400 "Invalid JSON format …"
 *   - missing/non-string code  → 400 "code (string) is required …"
 *   - valid code, clean        → 200 with the sanitizer's full output
 *   - valid code, violations   → 200 surfacing violations/errorClass
 *   - sanitizer throws         → 500 "Sanitization failed: <message>"
 */

// The shape the route reads off the sanitizer result. Typed inline so the
// test does not couple to the real module's exported type (and so a
// future rename of that export cannot silently break this contract).
interface SanitizeResult {
  clean: string;
  sanitizedCode: string;
  violations: Array<{ type: string }>;
  errorClass: string;
  highEntropyTokensFound: boolean;
}

const sanitizeAndGovernMock = mock((code: string): SanitizeResult => ({
  clean: code,
  sanitizedCode: code,
  violations: [],
  errorClass: "none",
  highEntropyTokensFound: false,
}));

mock.module("@/lib/pipeline/emg/sanitizer", () => ({
  sanitizeAndGovern: sanitizeAndGovernMock,
}));

// Dynamic import after the mock is registered: the route's import of
// sanitizeAndGovern resolves to the fake above.
const { POST, dynamic, runtime } = await import("./route");

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/emg/sanitize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("route constants", () => {
  test("dynamic is 'force-dynamic'", () => {
    expect(dynamic).toBe("force-dynamic");
  });
  test("runtime is 'nodejs'", () => {
    expect(runtime).toBe("nodejs");
  });
});

describe("POST /api/emg/sanitize", () => {
  beforeEach(() => {
    sanitizeAndGovernMock.mockReset();
    // Default: identity sanitizer (clean in, clean out, no violations).
    sanitizeAndGovernMock.mockImplementation((code: string) => ({
      clean: code,
      sanitizedCode: code,
      violations: [],
      errorClass: "none",
      highEntropyTokensFound: false,
    }));
  });

  test("returns 400 on invalid JSON body and never calls the sanitizer", async () => {
    const req = new Request("http://localhost/api/emg/sanitize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid JSON format");
    expect(sanitizeAndGovernMock).toHaveBeenCalledTimes(0);
  });

  test("returns 400 when code is missing and never calls the sanitizer", async () => {
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("code");
    expect(sanitizeAndGovernMock).toHaveBeenCalledTimes(0);
  });

  test("returns 400 when code is not a string and never calls the sanitizer", async () => {
    const res = await POST(jsonReq({ code: 123 }));
    expect(res.status).toBe(400);
    expect(sanitizeAndGovernMock).toHaveBeenCalledTimes(0);
  });

  test("returns 200 with the sanitizer output for clean code", async () => {
    const res = await POST(jsonReq({ code: "const x = 1;" }));
    expect(res.status).toBe(200);
    expect(sanitizeAndGovernMock).toHaveBeenCalledTimes(1);
    expect(sanitizeAndGovernMock).toHaveBeenCalledWith("const x = 1;");
    const body = await res.json();
    expect(body.clean).toBe("const x = 1;");
    expect(body.sanitizedCode).toBe("const x = 1;");
    expect(body.violations).toEqual([]);
    expect(body.errorClass).toBe("none");
    expect(body.highEntropyTokensFound).toBe(false);
  });

  test("returns 200 and surfaces violations when the sanitizer finds issues", async () => {
    sanitizeAndGovernMock.mockReturnValue({
      clean: "safe",
      sanitizedCode: "safe",
      violations: [{ type: "XSS" }],
      errorClass: "high",
      highEntropyTokensFound: true,
    });
    const res = await POST(jsonReq({ code: "<script>alert(1)</script>" }));
    expect(res.status).toBe(200);
    expect(sanitizeAndGovernMock).toHaveBeenCalledWith("<script>alert(1)</script>");
    const body = await res.json();
    expect(body.violations).toEqual([{ type: "XSS" }]);
    expect(body.errorClass).toBe("high");
    expect(body.highEntropyTokensFound).toBe(true);
  });

  test("returns 500 with the error message when the sanitizer throws", async () => {
    sanitizeAndGovernMock.mockImplementation(() => {
      throw new Error("sanitizer exploded");
    });
    const res = await POST(jsonReq({ code: "anything" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("Sanitization failed");
    expect(body.error).toContain("sanitizer exploded");
  });
});
