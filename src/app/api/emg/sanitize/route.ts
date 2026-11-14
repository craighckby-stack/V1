import { NextResponse } from "next/server";
import { z } from "zod";
import { sanitizeAndGovern } from "@/lib/pipeline/emg/sanitizer";
import { parseBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const sanitizeSchema = z.object({
  code: z.string().min(1).max(500_000),
}).strict();

export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, sanitizeSchema);
    if (!parsed.ok) return parsed.response;

    const result = sanitizeAndGovern(parsed.data.code);
    return NextResponse.json({
      clean: result.clean,
      sanitizedCode: result.sanitizedCode,
      violations: result.violations,
      errorClass: result.errorClass,
      highEntropyTokensFound: result.highEntropyTokensFound,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
