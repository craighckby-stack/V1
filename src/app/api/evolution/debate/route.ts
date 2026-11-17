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
    body = (await req.json()) as DebateRequest;
  } catch (e) {
    return NextResponse.json(
      { error: "Invalid JSON format in request body." },
      { status: 400 }
    );
  }

  if (!body.filePath || typeof body.filePath !== "string" || body.filePath.length === 0 || typeof body.candidateCode !== "string" || body.candidateCode.length === 0) {
    return NextResponse.json(
      { error: "filePath and candidateCode are required and must be non-empty strings." },
      { status: 400 }
    );
  }

  if (body.topic !== undefined && (typeof body.topic !== "string" || body.topic.length === 0)) {
    return NextResponse.json(
      { error: "If provided, topic must be a non-empty string." },
      { status: 400 }
    );
  }

  try {
    const topic = body.topic ?? `Code Review for ${body.filePath}`;
    const { verdict, usedLlm, llmError } = await conductLlmDebate(
      topic,
      body.candidateCode,
      body.filePath
    );
    return NextResponse.json({
      ...verdict,
      usedLlm,
      llmError,
    });
  } catch (err: unknown) {
    // Log the full error internally for pipeline observability before returning a sanitized response
    console.error("LLM Debate Execution Error:", err, { filePath: body.filePath });

    let errorMessage = "An error occurred during the LLM debate execution.";
    
    if (err instanceof Error) {
      errorMessage = `Debate execution failed: ${err.message}`;
    } else if (typeof err === 'string') {
      errorMessage = `Debate execution failed: ${err}`;
    }
    // If it's neither Error nor string, errorMessage remains the default, which is safe.
    
    // Return a standardized 500 response
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}