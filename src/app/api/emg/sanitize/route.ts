import { NextResponse } from "next/server";
import { sanitizeAndGovern } from "@/lib/pipeline/emg/sanitizer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SanitizeRequest {
  code: string;
}

export async function POST(req: Request) {
  let body: SanitizeRequest | undefined;
  try {
    body = (await req.json()) as SanitizeRequest;
  } catch (e) {
    // Catch JSON parsing errors specifically
    return NextResponse.json(
      { error: "Invalid JSON format in request body." },
      { status: 400 }
    );
  }

  // Check for undefined body (e.g., empty body that resolves but isn't a valid object structure)
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
    // Catch errors originating from sanitizeAndGovern, ensuring safe casting and context
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during sanitization.";
    return NextResponse.json(
      { error: `Sanitization failed: ${errorMessage}` },
      { status: 500 }
    );
  }
}