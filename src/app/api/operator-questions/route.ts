import { NextResponse } from "next/server";
import {
  getPendingQuestions,
  recordAnswer,
  expireOldQuestions,
} from "@/lib/pipeline/autonomous/operator-questions";
import { autonomousLoopRuntime } from "@/lib/pipeline/autonomous/loop-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/operator-questions — the loop's "voice" surface (step 4 of "what
 * the system should be for").
 *
 *   GET  → { pending: [...] } — the list of unanswered questions the loop
 *          posed. Surfaced in the terminal UI by the `answer` command.
 *   POST { answer: "yes"|"no", id?: string, note?: string } — record the
 *          operator's answer. If id is omitted, resolves to the most-recent
 *          pending question. Returns { text, status } on success.
 *
 * The POST is a MUTATING request (sets the answer), so the middleware's
 * x-loop-key auth applies automatically (the patched fetch in page.tsx
 * adds the header from localStorage). The loop can pose questions but
 * can NEVER call this POST — it's operator-only (the loop reads its own
 * answers via getAnswer() in operator-questions.ts, a server-side import,
 * not this HTTP route).
 */

export async function GET() {
  try {
    // Opportunistic expiry sweep — cheap (one updateMany) and keeps the
    // pending list from accumulating stale questions forever.
    const cycle = autonomousLoopRuntime.getState().stats.totalRuns;
    try {
      await expireOldQuestions(cycle);
    } catch (expiryErr) {
      // Log expiry failure but do not fail the GET request, as fetching pending questions is primary.
      console.error("Failed to run old question expiry sweep:", expiryErr);
    }
    const pending = await getPendingQuestions();
    return NextResponse.json({ pending });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, pending: [] },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      answer?: string;
      id?: string;
      note?: string;
    };
    const answerRaw = (body.answer ?? "").toLowerCase();
    if (answerRaw !== "yes" && answerRaw !== "no") {
      return NextResponse.json(
        { error: "answer must be 'yes' or 'no'" },
        { status: 400 },
      );
    }
    const answer = answerRaw as "yes" | "no";

    // If id is omitted, resolve to the most-recent pending question.
    let questionId = body.id;
    if (!questionId) {
      const pending = await getPendingQuestions();
      if (pending.length === 0) {
        return NextResponse.json(
          { error: "no pending questions to answer" },
          { status: 404 },
        );
      }
      questionId = pending[0].id; // newest-first
    }

    const cycle = autonomousLoopRuntime.getState().stats.totalRuns;
    const result = await recordAnswer(questionId, answer, cycle, body.note);
    if (!result) {
      return NextResponse.json(
        { error: `Failed to record answer for question ID ${questionId}: question not found or already answered/expired` },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `Error processing POST request: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}