import { NextResponse } from "next/server";
import { conductDebate, DebateVerdict } from "@/lib/pipeline/emg/debate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface DebateRequest {
  filePath: string;
  candidateCode: string;
  topic?: string;
}

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
    const verdict: DebateVerdict = conductDebate(topic, body.candidateCode, body.filePath);
    return NextResponse.json(verdict);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
