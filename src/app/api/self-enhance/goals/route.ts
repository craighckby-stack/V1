import { NextResponse } from "next/server";
import { getGoalsSnapshot } from "@/lib/pipeline/autonomous/goal-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Goal Engine status — the loop's self-set SYSTEM DIRECTION.
 *
 * The LoopGoal table holds the higher-level goals injected into every
 * mutation prompt (rendered as the SYSTEM DIRECTION block) and carried
 * in the debate topic. Seeded with the three operator goals
 * (provenance "operator-seed"), then reviewed every
 * GOAL_REVIEW_INTERVAL cycles by the loop's own goal review — an LLM
 * pass over recent evidence that may retire one goal and mint one
 * under hard clamps (see goal-engine.ts, which is in PROTECTED_FILES:
 * the loop can write goal ROWS through the clamped API but can never
 * rewrite its own goal governance).
 *
 * Lives under /api/self-enhance/ (protected prefix — the loop can
 * never edit the API that exposes its own goals) and reads the shared
 * DB directly: the review runs in the loop-worker process, this route
 * only observes.
 *
 *   GET → { active: GoalRow[], retired: GoalRow[] }
 */
export async function GET() {
  try {
    const snapshot = await getGoalsSnapshot();
    return NextResponse.json(snapshot);
  } catch (err) {
    const errorMessage =
      (err as Error)?.message || "An unknown error occurred while fetching goals.";
    return NextResponse.json(
      { active: [], retired: [], error: `Failed to retrieve goals: ${errorMessage}` },
      { status: 500 }
    );
  }
}
