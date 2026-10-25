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
 * Architecture in parallel, then Lead synthesis). Falls back to the
 * rule-based tribunal if the LLM is unavailable.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as DebateRequest;
    if (!body.filePath || typeof body.candidateCode !== "string") {
      return NextResponse.json(
        { error: "filePath and candidateCode are required" },
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
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}

