import { NextResponse } from "next/server";
import { z } from "zod";
import { proposeTaskPlan } from "@/lib/pipeline/autonomous/chat-task";
import { parseBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const proposeSchema = z.object({
  goal: z.string().min(1).max(4000),
}).strict();

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
    const parsed = await parseBody(req, proposeSchema);
    if (!parsed.ok) return parsed.response;

    const plan = await proposeTaskPlan(parsed.data.goal.trim());
    return NextResponse.json(plan);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
