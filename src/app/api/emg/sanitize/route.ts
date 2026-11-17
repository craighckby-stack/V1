import { NextResponse } from "next/server";
import { sanitizeAndGovern } from "@/lib/pipeline/emg/sanitizer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SanitizeRequest {
  code: string;
}

export async function POST(req: Request) {
  let body: SanitizeRequest;
  try {
    body = (await req.json()) as SanitizeRequest;
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to parse request body. Ensure the body is valid JSON." },
      { status: 400 }
    );
  }

  if (!body || typeof body.code !== "string") {
    return NextResponse.json(
      { error: "code (string) is required in the request body." },
      { status: 400 }
    );
  }

  try {
    const result = sanitizeAndGovern(body.code);
    return NextResponse.json({
      clean: result.clean,
      sanitizedCode: result.sanitizedCode,
      violations: result.violations,
      errorClass: result.errorClass,
      highEntropyTokensFound: result.highEntropyTokensFound,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Sanitization failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}