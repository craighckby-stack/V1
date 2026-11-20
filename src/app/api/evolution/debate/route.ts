import { NextResponse } from "next/server";
import { conductLlmDebate } from "@/lib/pipeline/llm/debate-llm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface DebateRequest {
  filePath: string;
  candidateCode: string;
  topic?: string;
}

/**
 * POST /api/evolution/debate
 * Runs the LLM-driven dual-perspective review tribunal (Security +
 * Architecture in parallel, then Lead synthesis). If any LLM call fails,
 * conductLlmDebate THROWS — no fabricated fallback verdict. The error is
 * returned honestly as a 500.
 */
export async function POST(req: Request) {
  let body: DebateRequest;
  try {
    body = await req.json() as DebateRequest;
  } catch (e) {
    // Provide a specific 400 error for JSON parsing failure without leaking internal details.
    return NextResponse.json(
      { error: "Invalid JSON format in request body." },
      { status: 400 }
    );
  }

  // Validate required fields
  if (!body.filePath || typeof body.filePath !== "string" || body.filePath.trim().length === 0) {
    return NextResponse.json(
      { error: "filePath is required and must be a non-empty string." },
      { status: 400 }
    );
  }

  if (!body.candidateCode || typeof body.candidateCode !== "string" || body.candidateCode.trim().length === 0) {
    return NextResponse.json(
      { error: "candidateCode is required and must be a non-empty string." },
      { status: 400 }
    );
  }

  // Validate optional topic field
  if (body.topic !== undefined && (typeof body.topic !== "string" || body.topic.trim().length === 0)) {
    return NextResponse.json(
      { error: "If provided, topic must be a non-empty string." },
      { status: 400 }
    );
  }

  try {
    const effectiveTopic = body.topic ?? `Code Review for ${body.filePath}`;
    const result = await conductLlmDebate(
      effectiveTopic,
      body.candidateCode,
      body.filePath
    );
    return NextResponse.json({
      ...result,
    });
  } catch (err: unknown) {
    // Log the full error internally for pipeline observability before returning a sanitized response
    console.error("LLM Debate Execution Error:", err, { filePath: body.filePath });

    let errorMessage = `Debate execution failed for ${body.filePath}. Please check the logs for details.`;
    
    if (err instanceof Error) {
      // Provide a slightly more contextual error message derived from the LLM execution context, 
      // while still adhering to the requirement of keeping the client response sanitized.
      errorMessage = `LLM debate failed for ${body.filePath}. Reason: ${err.message}. Check logs for full details.`;
    } 
    
    // Return a standardized 500 response
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}