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
  test("should return the correct service information and API map on GET /api", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.service).toBe("LOOP — autonomous self-enhancement system");
    expect(body.api.health).toEqual(["GET /api/health"]);
  });

  test("should correctly list self-enhance endpoints", async () => {
    const response = await GET();
    const body = await response.json();
    const selfEnhanceEndpoints = body.api.selfEnhance;
    expect(selfEnhanceEndpoints).toContain("GET  /api/self-enhance/status");
    expect(selfEnhanceEndpoints).toContain("POST /api/self-enhance/llm-config   (configure Gemini direct)");
    expect(selfEnhanceEndpoints.length).toBe(7);
  });

  test("should correctly list autonomous endpoints", async () => {
    const response = await GET();
    const body = await response.json();
    const autonomousEndpoints = body.api.autonomous;
    expect(autonomousEndpoints).toContain("GET  /api/autonomous/status");
    expect(autonomousEndpoints).toContain("POST /api/autonomous/{start,stop,trigger,config}");
    expect(autonomousEndpoints.length).toBe(3);
  });

  test("should correctly list oracle endpoints", async () => {
    const response = await GET();
    const body = await response.json();
    const oracleEndpoints = body.api.oracle;
    expect(oracleEndpoints).toContain("GET  /api/oracle/prophecies");
    expect(oracleEndpoints).toContain("POST /api/oracle/{generate,evaluate}");
    expect(oracleEndpoints.length).toBe(4);
  });
});