import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CoherenceGateRequest {
  originalCode: string;
  proposedCode: string;
}

type CoherenceStatus = "COHERENT" | "EXCESSIVE_DRIFT";

interface CoherenceGateResponse {
  passed: boolean;
  structuralDriftRatio: number;
  saturationScore: number;
  status: CoherenceStatus;
}

/**
 * POST /api/evolution/coherence-gate
 *
 * Lightweight length-ratio coherence check used by the front-end to decide
 * whether a candidate refactoring should be queued for the full pipeline.
 * Passes when |propLen - origLen| / origLen < 0.7.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // Provide actionable error context on JSON parsing failure.
    return NextResponse.json(
        { error: "Failed to parse request body. Ensure the request content type is application/json and the body is valid JSON." },
        { status: 400 }
    );
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json(
        { error: "Request body must be a valid JSON object." },
        { status: 400 }
    );
  }
  
  const typedBody = body as CoherenceGateRequest;

  if (typeof typedBody.originalCode !== "string" || typeof typedBody.proposedCode !== "string") {
    return NextResponse.json(
      { error: "originalCode and proposedCode must be provided as strings" },
      { status: 400 }
    );
  }

  if (typedBody.originalCode.trim() === "" && typedBody.proposedCode.trim() === "") {
    // Both empty, ratio is 0, which is < 0.7, so this is coherent.
    // We allow this case to proceed to calculation, but if we strictly enforce non-empty,
    // we should return 400. Based on existing logic, we only reject if *either* is empty,
    // but the check below handles individual emptiness. Let's stick to the original intent:
    // reject if *either* is empty string after trim.
  }

  if (typedBody.originalCode.trim() === "" || typedBody.proposedCode.trim() === "") {
    return NextResponse.json(
      { error: "originalCode and proposedCode must be non-empty strings" },
      { status: 400 }
    );
  }

  const origLen = typedBody.originalCode.length;
  const propLen = typedBody.proposedCode.length;
  
  let structuralDriftRatio: number;

  // Guard against division by zero if original code is empty.
  // Since we validated against empty strings above, origLen > 0 is guaranteed here.
  // However, if the validation was bypassed or if we consider length 0 possible despite trim check:
  if (origLen === 0) {
    // This path should be unreachable due to the guard clause above, but for safety:
    structuralDriftRatio = propLen === 0 ? 0 : Infinity;
  } else {
    structuralDriftRatio = Math.abs(propLen - origLen) / origLen;
  }
      
  const passed = structuralDriftRatio < 0.7;
  
  // Calculate saturationScore: 0 if drift is Infinity, otherwise max(0, 1 - ratio)
  const saturationScore = structuralDriftRatio === Infinity ? 0 : Math.max(0, 1 - structuralDriftRatio);
  
  const status: CoherenceStatus = passed ? "COHERENT" : "EXCESSIVE_DRIFT";

  const response: CoherenceGateResponse = {
    passed,
    structuralDriftRatio,
    saturationScore,
    status,
  };
  return NextResponse.json(response);
}