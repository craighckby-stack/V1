/**
 * Shared API validation + error-envelope helpers.
 *
 * audit (smells): 38 of 67 routes used `(await req.json()) as Type` with no
 * runtime validation. zod was already in deps but unused. This module gives
 * every mutating route one shape:
 *
 *   const parsed = await parseBody(req, schema);
 *   if (!parsed.ok) return parsed.response;
 *   // parsed.data is typed as the schema's inferred type
 *
 * The error envelope is standardized:
 *   { ok: false, error: string, code: string }
 *
 * `code` is a short machine-readable token ("BAD_BODY", "VALIDATION", etc.)
 * so the UI can branch on it without parsing the human message.
 */
import { NextResponse } from "next/server";
import { ZodError, ZodSchema } from "zod";

/** Standard error envelope. `code` lets the UI branch without regex. */
export interface ApiError {
  readonly ok: false;
  readonly error: string;
  readonly code: string;
}

/** Build a 4xx/5xx NextResponse with the standard error envelope. */
export function apiError(
  status: number,
  code: string,
  message: string,
): NextResponse<ApiError> {
  return NextResponse.json({ ok: false, error: message, code }, { status });
}

/** Convert a zod issue path into a readable "field: message" string. */
function formatZodError(err: ZodError): string {
  const issues = err.issues.slice(0, 5); // cap to avoid huge payloads
  const parts = issues.map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : "(root)";
    return `${path}: ${i.message}`;
  });
  return parts.join("; ");
}

/** Parse and validate a request body against a zod schema.
 *
 * Returns one of:
 *   - { ok: true, data: T }            — validated body, safe to use
 *   - { ok: false, response }          — a ready-to-return 400 (bad JSON or
 *                                        schema violation). The caller just
 *                                        returns `parsed.response`.
 *
 * Usage:
 *   const parsed = await parseBody(req, mySchema);
 *   if (!parsed.ok) return parsed.response;
 *   await doThing(parsed.data);
 */
export async function parseBody<T>(
  req: Request,
  schema: ZodSchema<T>,
): Promise<
  | { ok: true; data: T }
  | { ok: false; response: NextResponse<ApiError> }
> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (e) {
    // Handle JSON parsing errors specifically
    return {
      ok: false,
      response: apiError(400, "BAD_BODY", "request body is not valid JSON"),
    };
  }
  const result = schema.safeParse(raw);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return {
    ok: false,
    response: apiError(
      400,
      "VALIDATION",
      formatZodError(result.error),
    ),
  };
}

/** Parse an OPTIONAL request body: missing/invalid JSON and validation
 *  failures all fall back to `defaults` instead of erroring. Use this for
 *  routes like /api/duress/clear where the body is a convenience and the
 *  action must never be blocked by a malformed payload (the auth gate is
 *  the only gate). Validation only rejects fields with WRONG types (so a
 *  `{ by: 123 }` can't sneak past) — absent fields take the default.
 *
 * Usage:
 *   const { reason, dryRun } = await parseOptionalBody(
 *     req, z.object({ reason: z.string().optional(), dryRun: z.boolean().optional() }),
 *     { reason: "manual", dryRun: false },
 *   );
 */
export async function parseOptionalBody<T extends object>(
  req: Request,
  schema: ZodSchema<T>,
  defaults: T,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return defaults; // no body / bad JSON — caller's defaults win
  }
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return defaults;
  }
  const result = schema.safeParse(raw);
  if (result.success) {
    return { ...defaults, ...result.data };
  }
  // Invalid shape — fall back to defaults rather than blocking the action.
  return defaults;
}

/** Repo path shape: `owner/name`. Used by push-target, autonomous/config,
 *  pipeline/run, and the github/* routes. */
export const REPO_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Reject paths that escape the repo root. Used by chat-task/apply and
 *  pipeline/run — both write files to disk. */
export function isRepoRelativePath(p: string): boolean {
  if (typeof p !== 'string') return false;
  if (p.length === 0) return false;
  if (p.startsWith("/")) return false;          // POSIX absolute
  if (p.startsWith("\\")) return false;         // Windows UNC
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;  // Windows drive-letter
  if (p.startsWith("~")) return false;          // home shorthand
  if (p.includes("..")) return false;           // any traversal segment
  return true;
}