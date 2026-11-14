import { NextResponse } from "next/server";
import { z } from "zod";
import { duressPurgePat } from "@/lib/pipeline/core/duress";
import { parseBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/duress/purge
 *
 * Manually trigger the duress/purge protocol. This is the operator's
 * panic button — it runs the full PKM §3 sequence (KEYS → CACHE →
 * SAFE-MODE → READ-BACK → HALT), purging the PAT from all three
 * persistence tiers and raising safe-mode so the autonomous loop halts
 * until cleared. See docs/CONCEPTS-GRAFTED.md GRAFT 2.
 *
 * Body (optional):
 *   { reason?: string }  — why the operator triggered the purge.
 *                         Defaults to "manual operator trigger".
 *
 * Validation: the panic button is behind the middleware's auth gate, but
 * the body is still validated so a malicious payload can't ship an
 * unbounded `reason` string into the postmortem/audit logs. The schema is
 * `.strict()` so unknown keys are rejected — a duress payload should never
 * carry extra fields. An empty body (no `req.json()`) still works: the
 * `parseBody` helper returns BAD_BODY on a JSON parse failure, and we
 * treat that as "use the default reason" since the operator may be
 * mashing the button in a real incident with no time to type.
 */
const duressPurgeSchema = z.object({
  reason: z.string().max(300).optional(),
}).strict();

export async function POST(req: Request) {
  try {
    let reason = "manual operator trigger";
    const parsed = await parseBody(req, duressPurgeSchema);
    if (parsed.ok) {
      if (parsed.data.reason && parsed.data.reason.trim()) {
        reason = parsed.data.reason.trim();
      }
    }
    // If parseBody failed (bad JSON / validation), we still proceed with
    // the default reason — duress/purge must NOT be blockable by a body
    // parse error. The auth gate is the only thing that can stop it.
    const result = await duressPurgePat({ reason, setBy: "operator" });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
