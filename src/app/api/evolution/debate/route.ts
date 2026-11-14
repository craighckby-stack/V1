import { NextResponse } from "next/server";
import { z } from "zod";
import { conductLlmDebate } from "@/lib/pipeline/llm/debate-llm";
import { parseBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const debateSchema = z.object({
  filePath: z.string().min(1).max(500),
  candidateCode: z.string().min(1).max(500_000),
  topic: z.string().min(1).max(2000).optional(),
}).strict();

/**
 * POST /api/evolution/debate
 * Runs the LLM-driven dual-perspective review tribunal (Security +
 * Architecture in parallel, then Lead synthesis). If any LLM call fails,
 * conductLlmDebate THROWS — no fabricated fallback verdict. The error is
 * returned honestly as a 500.
 */
export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, debateSchema);
    if (!parsed.ok) return parsed.response;

    const topic = parsed.data.topic ?? `Code Review for ${parsed.data.filePath}`;
    const { verdict, usedLlm, llmError } = await conductLlmDebate(
      topic,
      parsed.data.candidateCode,
      parsed.data.filePath
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

