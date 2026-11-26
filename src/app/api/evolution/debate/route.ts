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

    // Validate optional topic field
    if (json.topic !== undefined && (typeof json.topic !== "string" || json.topic.trim().length === 0)) {
        throw new Error("If provided, topic must be a non-empty string.");
    }

    body = json as DebateRequest;

  } catch (e) {
    // Handle JSON parsing errors or structural/validation errors thrown above
    if (e instanceof SyntaxError) {
        return NextResponse.json(
          { error: "Invalid JSON format in request body." },
          { status: 400 }
        );
    }
    
    const errorMessage = e instanceof Error ? e.message : "Unknown input error during request parsing.";
    
    return NextResponse.json(
      { error: `Invalid request body: ${errorMessage}` },
      { status: 400 }
    );
  }

  // Topic determination is fast and can proceed immediately after successful validation
  const effectiveTopic = body.topic ?? `Code Review for ${body.filePath}`;
  
  try {
    // Execute LLM debate
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