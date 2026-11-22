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
    const parsedBody = await req.json();
    body = parsedBody as SanitizeRequest;
  } catch {
    // Catch JSON parsing errors specifically
    return NextResponse.json(
      { error: "Invalid JSON format in request body." },
      { status: 400 }
    );
  }

  // Check for required structure and type
  if (!body || typeof body.code !== "string") {
    return NextResponse.json(
      { error: "code (string) is required in the request body." },
      { status: 400 }
    );
  }

  // Additional validation for empty string code
  if (body.code.trim() === "") {
    return NextResponse.json(
      { error: "code cannot be an empty string." },
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
      { error: `Sanitization failed for input code: ${body.code.substring(0, 50)}... Error: ${errorMessage}` },
      { status: 500 }
    );
  }
}