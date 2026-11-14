import { NextResponse } from "next/server";
import { proposeTaskPlan } from "@/lib/pipeline/autonomous/chat-task";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/self-enhance/chat-task/propose
 * Body: { goal: string }
 *
 * Takes a user's goal in plain English, gathers codebase context, and asks
 * the LLM to propose a plan (which files to change, why). Does NOT modify
 * anything — returns the plan for user approval.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { goal?: string };
    if (!body.goal || !body.goal.trim()) {
      return NextResponse.json(
        { ok: false, error: "A goal is required" },
        { status: 400 }
      );
    }

    const plan = await proposeTaskPlan(body.goal.trim());
    return NextResponse.json(plan);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
