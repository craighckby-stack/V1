import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CoherenceStatus = "COHERENT" | "EXCESSIVE_DRIFT";

interface CoherenceGateResponse {
  passed: boolean;
  structuralDriftRatio: number;
  saturationScore: number;
  status: CoherenceStatus;
}

const coherenceGateSchema = z.object({
  originalCode: z.string().max(500_000),
  proposedCode: z.string().max(500_000),
}).strict();

/**
 * POST /api/evolution/coherence-gate
 *
 * Lightweight length-ratio coherence check used by the front-end to decide
 * whether a candidate refactoring should be queued for the full pipeline.
 * Passes when |propLen - origLen| / origLen < 0.7.
 */
export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, coherenceGateSchema);
    if (!parsed.ok) return parsed.response;

    const origLen = parsed.data.originalCode.length || 1;
    const propLen = parsed.data.proposedCode.length;
    const structuralDriftRatio = Math.abs(propLen - origLen) / origLen;
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
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
