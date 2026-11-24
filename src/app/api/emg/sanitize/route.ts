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
    const parsedBody = await req.json();
    
    // Input Validation: Check structure and type robustly immediately after parsing
    if (typeof parsedBody !== 'object' || parsedBody === null || typeof parsedBody.code !== 'string') {
        return NextResponse.json(
            { error: "Invalid request body format. Expected { code: string }." },
            { status: 400 }
        );
    }
    body = parsedBody as SanitizeRequest;

  } catch (e) {
    if (e instanceof SyntaxError) {
      return NextResponse.json(
        { error: "Invalid JSON format in request body. Ensure the body is valid JSON." },
        { status: 400 }
      );
    }
    // Handle other request reading errors (e.g., network issues during read)
    return NextResponse.json(
      { error: "Failed to read or parse request body due to an unexpected I/O error." },
      { status: 500 }
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
    
    // FIX: Ensure 'violations' is a mutable array (string[]) as required by SanitizeResult, 
    // even if sanitizeAndGovern returns a readonly array (SecuritySanitizerResult).
    const resultWithMutableViolations = {
        ...result,
        violations: Array.from(result.violations),
    };

    return NextResponse.json({
      clean: resultWithMutableViolations.clean,
      sanitizedCode: resultWithMutableViolations.sanitizedCode,
      violations: resultWithMutableViolations.violations,
      errorClass: resultWithMutableViolations.errorClass,
      highEntropyTokensFound: resultWithMutableViolations.highEntropyTokensFound,
    });
  } catch (err) {
    // Catch errors originating from sanitizeAndGovern, ensuring safe casting and context
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during sanitization.";
    const inputSnippet = body.code.substring(0, Math.min(50, body.code.length));
    
    return NextResponse.json(
      { error: `Sanitization failed for input code starting with: ${inputSnippet}... Error: ${errorMessage}` },
      { status: 500 }
    );
  }
}