import { NextResponse } from "next/server";
import { z } from "zod";
import { autonomousLoopRuntime, LoopConfig } from "@/lib/pipeline/autonomous/loop-runtime";
import { parseBody, REPO_REGEX } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/autonomous/config
 *
 * Updates the autonomous loop configuration. The githubToken field is special:
 * the UI re-sends "[REDACTED]" (or empty) when the user has *not* changed the
 * token. We must NOT overwrite the stored token in that case — only persist
 * real new tokens.
 *
 * Validation: the old route did `{ ...body }` (spread) — any key the client
 * sent was forwarded into `updateConfig`, and `targetRepo` was interpolated
 * raw into GitHub REST URLs. The `.strict()` schema below allow-lists only
 * known config fields and rejects unknown keys; `targetRepo` must match
 * `owner/name`; numeric fields are bounded so a malicious or buggy payload
 * can't set `intervalMinutes: 0` (busy loop) or `maxFilesPerCycle: 1e9`.
 */
const configPatchSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["scheduled", "watch", "continuous", "manual"]).optional(),
  intervalMinutes: z.number().int().min(1).max(1440).optional(),
  targetRepo: z
    .string()
    .regex(REPO_REGEX, "targetRepo must be 'owner/name'")
    .max(100)
    .optional(),
  branch: z.string().min(1).max(100).optional(),
  evolutionBranch: z.string().min(1).max(100).optional(),
  maxCycles: z.number().int().min(0).max(100000).optional(),
  maxFilesPerCycle: z.number().int().min(1).max(100).optional(),
  autoPush: z.boolean().optional(),
  siphonSourceId: z.string().min(1).max(200).optional(),
  userPrompt: z.string().min(1).max(8000).optional(),
  githubToken: z.string().max(500).optional(),
}).strict();

type AutonomousConfigPatch = Partial<LoopConfig>;

export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, configPatchSchema);
    if (!parsed.ok) return parsed.response;

    const body = parsed.data;
    const patch: AutonomousConfigPatch = { ...body };

    // Preserve existing token unless the caller supplied a real new value.
    if (
      patch.githubToken === undefined ||
      patch.githubToken === "" ||
      patch.githubToken === "[REDACTED]"
    ) {
      delete patch.githubToken;
    }

    const updated = autonomousLoopRuntime.updateConfig(patch);
    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
