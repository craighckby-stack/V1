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
  try {
    const body = await req.json();
    
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

    const origLen = typedBody.originalCode.length;
    const propLen = typedBody.proposedCode.length;
    
    // Guard against division by zero if original code is empty
    const structuralDriftRatio = origLen === 0 
      ? propLen === 0 ? 0 : Infinity // If orig is 0 and prop is not, drift is infinite (fails coherence)
      : Math.abs(propLen - origLen) / origLen;
      
    const passed = structuralDriftRatio < 0.7;
    const saturationScore = Math.max(0, 1 - structuralDriftRatio);
    const status: CoherenceStatus = passed ? "COHERENT" : "EXCESSIVE_DRIFT";

    const response: CoherenceGateResponse = {
      passed,
      structuralDriftRatio,
      saturationScore,
      status,
    };
    return NextResponse.json(response);
  } catch (err) {
    if (err instanceof SyntaxError) {
        return NextResponse.json(
            { error: "Invalid JSON format in request body." },
            { status: 400 }
        );
    }
    
    if (err instanceof Error) {
      console.error("Coherence Gate POST error:", err.message, err.stack);
    } else {
      console.error("Coherence Gate POST error: Unknown non-Error object during request processing.", err);
    }

    return NextResponse.json(
      { error: "Internal server error while processing coherence gate request." },
      { status: 500 }
    );
  }
}