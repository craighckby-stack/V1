import { NextResponse } from "next/server";
import { autonomousLoopRuntime, LoopConfig } from "@/lib/pipeline/autonomous/loop-runtime";
import { REPO_REGEX } from "@/lib/api/validate";

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
 * VALIDATION (2026-11-17): the body used to be spread into the live runtime
 * config verbatim — `POST {intervalMinutes: "banana"}` made restartScheduler
 * compute `Date.now() + NaN` and THROW "Invalid time value" AFTER
 * `config.enabled = true` had already merged, leaving the runtime "enabled"
 * with no armed scheduler until the next explicit start. The patch is now
 * built field-by-field: unknown fields are dropped, wrong-typed fields are
 * rejected with 400 (no partial application — the runtime config is merged
 * only after the whole patch validates), and numerics are clamped to the
 * ranges the UI's own controls enforce.
 */

const LOOP_MODES = ["scheduled", "watch", "continuous", "manual"] as const;

/** Git-branch-safe: no whitespace, no "..", no leading dash (option
 *  injection), no control characters, reasonable length. */
const BRANCH_REGEX = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\-/]{1,120}$/;

interface ConfigValidationError {
  field: string;
  problem: string;
}

function buildPatch(body: Record<string, unknown>):
  | { ok: true; patch: Partial<LoopConfig> }
  | { ok: false; errors: ConfigValidationError[] } {
  const patch: Partial<LoopConfig> = {};
  const errors: ConfigValidationError[] = [];

  const isBool = (v: unknown): v is boolean => typeof v === "boolean";
  const num = (field: string, v: unknown, min: number, max: number): number | null => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isFinite(n)) {
      errors.push({ field, problem: "must be a finite number" });
      return null;
    }
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const str = (field: string, v: unknown, maxLen: number): string | null => {
    if (typeof v !== "string") {
      errors.push({ field, problem: "must be a string" });
      return null;
    }
    if (v.length > maxLen) {
      errors.push({ field, problem: `exceeds ${maxLen} characters` });
      return null;
    }
    return v;
  };

  if ("enabled" in body) {
    if (isBool(body.enabled)) patch.enabled = body.enabled;
    else errors.push({ field: "enabled", problem: "must be a boolean" });
  }
  if ("mode" in body) {
    if (typeof body.mode === "string" && (LOOP_MODES as readonly string[]).includes(body.mode)) {
      patch.mode = body.mode as LoopConfig["mode"];
    } else {
      errors.push({ field: "mode", problem: `must be one of ${LOOP_MODES.join(", ")}` });
    }
  }
  if ("intervalMinutes" in body) {
    const n = num("intervalMinutes", body.intervalMinutes, 1, 1440);
    if (n !== null) patch.intervalMinutes = n;
  }
  if ("maxCycles" in body) {
    const n = num("maxCycles", body.maxCycles, 0, 1_000_000);
    if (n !== null) patch.maxCycles = n;
  }
  if ("maxFilesPerCycle" in body) {
    const n = num("maxFilesPerCycle", body.maxFilesPerCycle, 1, 50);
    if (n !== null) patch.maxFilesPerCycle = n;
  }
  if ("targetRepo" in body) {
    const s = str("targetRepo", body.targetRepo, 200);
    if (s !== null) {
      if (REPO_REGEX.test(s)) patch.targetRepo = s;
      else errors.push({ field: "targetRepo", problem: "must be owner/repo format" });
    }
  }
  for (const field of ["branch", "evolutionBranch"] as const) {
    if (field in body) {
      const s = str(field, body[field], 120);
      if (s !== null) {
        if (BRANCH_REGEX.test(s)) patch[field] = s;
        else errors.push({ field, problem: "not a git-branch-safe name" });
      }
    }
  }
  if ("autoPush" in body) {
    if (isBool(body.autoPush)) patch.autoPush = body.autoPush;
    else errors.push({ field: "autoPush", problem: "must be a boolean" });
  }
  if ("siphonSourceId" in body) {
    const s = str("siphonSourceId", body.siphonSourceId, 200);
    if (s !== null) patch.siphonSourceId = s;
  }
  if ("userPrompt" in body) {
    const s = str("userPrompt", body.userPrompt, 8000);
    if (s !== null) patch.userPrompt = s;
  }
  if ("githubToken" in body) {
    const s = str("githubToken", body.githubToken, 400);
    if (s !== null) patch.githubToken = s;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, patch };
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json(
        { error: "invalid body — expected a JSON object" },
        { status: 400 }
      );
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // githubToken "[REDACTED]"/empty = "unchanged" from the UI — drop it
  // BEFORE validation so it doesn't trip the string-length check.
  if (
    body.githubToken === undefined ||
    body.githubToken === "" ||
    body.githubToken === "[REDACTED]"
  ) {
    delete body.githubToken;
  }

  const result = buildPatch(body);
  if (!result.ok) {
    return NextResponse.json(
      { error: "invalid config patch", details: result.errors },
      { status: 400 }
    );
  }

  try {
    const updated = autonomousLoopRuntime.updateConfig(result.patch);
    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
