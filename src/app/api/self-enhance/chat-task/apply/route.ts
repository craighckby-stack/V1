import { NextResponse } from "next/server";
import { z } from "zod";
import { applyTaskPlan, type ChatTaskPlan } from "@/lib/pipeline/autonomous/chat-task";
import { parseBody, isRepoRelativePath } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/self-enhance/chat-task/apply
 * Body: ChatTaskPlan (the plan the user approved)
 *
 * Applies the plan: for each file, asks the LLM to generate the new content,
 * writes it, typechecks the whole project, reverts if it fails, commits and
 * pushes if it succeeds.
 *
 * Validation: the plan writes files to disk and runs tsc, so filePaths must
 * be repo-relative (no `..`, no leading `/`, no drive letters). The old route
 * did a bare `as ChatTaskPlan` cast — a malformed payload with crafted
 * `filePath` entries (e.g. `../../.git/config`) was a path-traversal vector.
 */
const fileSpecSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(500)
    .refine(isRepoRelativePath, "path must be repo-relative (no .. or leading /)"),
  action: z.enum(["modify", "create"]),
  reason: z.string().min(1).max(2000),
});

const chatTaskPlanSchema = z.object({
  ok: z.literal(true),
  userGoal: z.string().min(1).max(2000),
  understanding: z.string().min(1).max(8000),
  files: z.array(fileSpecSchema).min(1).max(50),
  summary: z.string().min(1).max(4000),
  error: z.string().max(2000).optional(),
}).strict();

export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, chatTaskPlanSchema);
    if (!parsed.ok) return parsed.response;

    const plan: ChatTaskPlan = parsed.data;
    const result = await applyTaskPlan(plan);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
