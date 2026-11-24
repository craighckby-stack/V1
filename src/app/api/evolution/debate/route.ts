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
    const json = await req.json();
    
    // Validate structure and cast in one step
    if (typeof json !== 'object' || json === null || !('filePath' in json) || !('candidateCode' in json)) {
        throw new Error("Request body structure is invalid or missing required fields: 'filePath' and 'candidateCode' are required.");
    }
    
    // Perform strict type checking before casting to DebateRequest
    if (typeof json.filePath !== "string" || json.filePath.trim().length === 0 || 
        typeof json.candidateCode !== "string" || json.candidateCode.trim().length === 0) {
        throw new Error("filePath and candidateCode must be non-empty strings.");
    }

    body = json as DebateRequest;

    // Validate optional topic field
    if (body.topic !== undefined && (typeof body.topic !== "string" || body.topic.trim().length === 0)) {
        throw new Error("If provided, topic must be a non-empty string.");
    }

  } catch (e) {
    // Handle JSON parsing errors or structural/validation errors thrown above
    const errorMessage = e instanceof Error ? e.message : "Unknown input error during request parsing.";
    
    return NextResponse.json(
      { error: `Invalid request body: ${errorMessage}` },
      { status: 400 }
    );
  }

  try {
    // Use nullish coalescing for cleaner fallback logic
    const effectiveTopic = body.topic ?? `Code Review for ${body.filePath}`;
    
    // Execute LLM debate concurrently (assuming conductLlmDebate internally handles parallel Security/Architecture calls)
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
    console.error("LLM Debate Execution Error:", err, { 
      filePath: body.filePath,
      candidateCode: body.candidateCode.substring(0, 50) + '...', // Log first 50 chars for privacy
      topic: body.topic 
    });

    // Return a standardized 500 response with a clear, non-leaking message
    return NextResponse.json(
      { error: `LLM debate failed for ${body.filePath}. Please check the logs for full details.` },
      { status: 500 }
    );
  }
}