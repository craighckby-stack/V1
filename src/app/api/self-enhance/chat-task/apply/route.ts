import { NextResponse } from "next/server";
import { applyTaskPlan, type ChatTaskPlan } from "@/lib/pipeline/autonomous/chat-task";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/self-enhance/chat-task/apply
 * Body: ChatTaskPlan (the plan the user approved)
 *
 * Applies the plan: for each file, asks the LLM to generate the new content,
 * writes it, typechecks the whole project, reverts if it fails, commits and
 * pushes if it succeeds.
 */
export async function POST(req: Request) {
  try {
    const plan = (await req.json()) as ChatTaskPlan;
    if (!plan || !plan.ok || plan.files.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Invalid or empty plan" },
        { status: 400 }
      );
    }

    const result = await applyTaskPlan(plan);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
