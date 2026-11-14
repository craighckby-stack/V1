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
  try {
    const body = (await req.json()) as DebateRequest;
    if (!body.filePath || typeof body.filePath !== "string" || body.filePath.length === 0 || !body.candidateCode || typeof body.candidateCode !== "string" || body.candidateCode.length === 0) {
      return NextResponse.json(
        { error: "filePath and candidateCode are required, and both must be non-empty strings." },
        { status: 400 }
      );
    }

    const topic = body.topic;
    if (topic !== undefined && (typeof topic !== "string" || topic.length === 0)) {
        return NextResponse.json(
            { error: "If provided, topic must be a non-empty string." },
            { status: 400 }
        );
    }
    
    const finalTopic = topic ?? `Code Review for ${body.filePath}`;

    const { verdict, usedLlm, llmError } = await conductLlmDebate(
      finalTopic,
      body.candidateCode,
      body.filePath
    );
    return NextResponse.json({
      ...verdict,
      usedLlm,
      llmError,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during debate execution.";
    console.error("Error during LLM debate execution:", err);
    return NextResponse.json(
      { error: "Internal server error during debate execution. Please try again or check server logs." },
      { status: 500 }
    );
  }
}