import { describe, test, expect } from "bun:test";
import { GET, dynamic, runtime } from "./route";
import { NextResponse } from "next/server";

describe("route constants", () => {
  test("dynamic constant must be 'force-dynamic'", () => {
    expect(dynamic).toBe("force-dynamic");
  });
  test("runtime constant must be 'nodejs'", () => {
    expect(runtime).toBe("nodejs");
  });
});

describe("GET handler", () => {
  test("GET handler returns a NextResponse object", async () => {
    const response = await GET();
    expect(response instanceof NextResponse).toBe(true);
  });

  test("GET handler returns the correct service information", async () => {
    const response = await GET();
    const data = await response.json();
    expect(data.service).toBe("LOOP — autonomous self-enhancement system");
  });

  test("GET handler includes the correct list of self-enhance endpoints", async () => {
    const response = await GET();
    const data = await response.json();
    const selfEnhance = data.api.selfEnhance;
    expect(selfEnhance).toContain("GET  /api/self-enhance/status");
    expect(selfEnhance).toContain("POST /api/self-enhance/llm-config   (configure Gemini direct)");
    expect(selfEnhance.length).toBe(7);
  });

  test("GET handler includes the correct list of autonomous endpoints", async () => {
    const response = await GET();
    const data = await response.json();
    const autonomous = data.api.autonomous;
    expect(autonomous).toContain("GET  /api/autonomous/status");
    expect(autonomous).toContain("POST /api/autonomous/{start,stop,trigger,config}");
    expect(autonomous.length).toBe(3);
  });

  test("GET handler includes the correct list of oracle endpoints", async () => {
    const response = await GET();
    const data = await response.json();
    const oracle = data.api.oracle;
    expect(oracle).toContain("GET  /api/oracle/status   (track record + calibration + Brier)");
    expect(oracle).toContain("POST /api/oracle/{generate,evaluate}");
    expect(oracle.length).toBe(4);
  });
});