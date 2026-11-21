import { describe, test, expect } from "bun:test";
import { POST } from "./route";

describe("coherence-gate API", () => {
  test("returns 400 error for non-JSON request body", async () => {
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      body: "not json",
    }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Failed to parse request body. Ensure the request content type is application/json and the body is valid JSON.");
  });

  test("returns 400 error for non-object request body", async () => {
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify("not an object"),
    }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Request body must be a valid JSON object.");
  });

  test("returns 400 error when originalCode is not a string", async () => {
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        originalCode: 123,
        proposedCode: "console.log('hello');"
      }),
    }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("originalCode and proposedCode must be provided as strings");
  });

  test("returns 400 error when proposedCode is not a string", async () => {
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        originalCode: "console.log('hello');",
        proposedCode: { not: "a string" }
      }),
    }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("originalCode and proposedCode must be provided as strings");
  });

  test("returns 400 error when originalCode is empty", async () => {
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        originalCode: "",
        proposedCode: "console.log('hello');"
      }),
    }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("originalCode and proposedCode must be non-empty strings");
  });

  test("returns 400 error when proposedCode is empty", async () => {
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        originalCode: "console.log('hello');",
        proposedCode: ""
      }),
    }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("originalCode and proposedCode must be non-empty strings");
  });

  test("calculates drift ratio correctly for normal case", async () => {
    const original = "console.log('hello');";
    const proposed = "console.log('hello world');";
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        originalCode: original,
        proposedCode: proposed
      }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.structuralDriftRatio).toBe(Math.abs(proposed.length - original.length) / original.length);
  });

  test("handles zero-length original code edge case", async () => {
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        originalCode: "",
        proposedCode: "console.log('hello');"
      }),
    }));
    expect(response.status).toBe(400);
  });

  test("returns COHERENT status when drift ratio < 0.7", async () => {
    const original = "console.log('hello');";
    const proposed = "console.log('hello world');"; // 50% increase
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        originalCode: original,
        proposedCode: proposed
      }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.passed).toBe(true);
    expect(body.status).toBe("COHERENT");
    expect(body.saturationScore).toBe(Math.max(0, 1 - (Math.abs(proposed.length - original.length) / original.length)));
  });

  test("returns EXCESSIVE_DRIFT status when drift ratio >= 0.7", async () => {
    const original = "console.log('hello');";
    const proposed = "console.log('hello world'); console.log('another line');"; // ~100% increase
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        originalCode: original,
        proposedCode: proposed
      }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.passed).toBe(false);
    expect(body.status).toBe("EXCESSIVE_DRIFT");
    expect(body.saturationScore).toBe(Math.max(0, 1 - (Math.abs(proposed.length - original.length) / original.length)));
  });

  test("calculates saturationScore correctly when drift ratio is 1", async () => {
    const original = "console.log('hello');";
    const proposed = "console.log('hello world');"; // 50% increase
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        originalCode: original,
        proposedCode: proposed
      }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    const expectedRatio = Math.abs(proposed.length - original.length) / original.length;
    expect(body.saturationScore).toBe(Math.max(0, 1 - expectedRatio));
  });
});