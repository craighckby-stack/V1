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

    // Run expiry sweep and fetch questions concurrently to reduce latency.
    const [expiryResult, pendingSettled] = await Promise.allSettled([
      expireOldQuestions(cycle),
      getPendingQuestions(),
    ]);

    if (expiryResult.status === 'rejected') {
      // Log expiry failure but do not fail the GET request, as fetching pending questions is primary.
      console.error("Failed to run old question expiry sweep:", expiryResult.reason instanceof Error ? expiryResult.reason.message : String(expiryResult.reason));
    }

    const pending = pendingSettled.status === "fulfilled" ? pendingSettled.value : [];
    return NextResponse.json({ pending });
  } catch (err) {
    // Provide actionable error context instead of just the raw message
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during question retrieval.";
    return NextResponse.json(
      { error: `Failed to retrieve pending questions: ${errorMessage}`, pending: [] },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    let body;
    try {
        body = await req.json();
    } catch (e) {
        return NextResponse.json(
            { error: "Failed to parse request body as JSON. Ensure content-type is application/json." },
            { status: 400 }
        );
    }
    
    if (typeof body !== 'object' || body === null) {
        return NextResponse.json(
            { error: "Request body must be a valid JSON object." },
            { status: 400 }
        );
    }

    const parsedBody = body as {
      answer?: string;
      id?: string;
      note?: string;
    };

    if (!parsedBody.answer) {
        return NextResponse.json(
            { error: "The 'answer' field is required in the request body." },
            { status: 400 }
        );
    }

    const answerRaw = parsedBody.answer.toLowerCase();
    if (answerRaw !== "yes" && answerRaw !== "no") {
      return NextResponse.json(
        { error: "answer must be 'yes' or 'no'" },
        { status: 400 },
      );
    }
    const answer = answerRaw as "yes" | "no";

    // If id is omitted, resolve to the most-recent pending question.
    let questionId = parsedBody.id;
    if (!questionId) {
      // Fetch pending questions only when ID is not provided, optimizing for direct ID updates.
      const pending = await getPendingQuestions();
      if (pending.length === 0) {
        return NextResponse.json(
          { error: "no pending questions to answer" },
          { status: 404 },
        );
      }
      // Assuming pending is ordered newest-first as per comment
      questionId = pending[0].id; 
    }

    const cycle = autonomousLoopRuntime.getState().stats.totalRuns;
    
    const result = await recordAnswer(questionId, answer, cycle, parsedBody.note);
    if (!result) {
      return NextResponse.json(
        { error: `Failed to record answer for question ID ${questionId}: question not found or already answered/expired` },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    // Provide actionable error context
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred while processing the POST request.";
    return NextResponse.json(
      { error: `Error processing POST request: ${errorMessage}` },
      { status: 500 },
    );
  }
}