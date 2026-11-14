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
        { error: "filePath and candidateCode are required, and candidateCode cannot be empty" },
        { status: 400 }
      );
    }

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
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during debate execution. Please check server logs for details.";
    console.error("Error during LLM debate execution:", err);
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}