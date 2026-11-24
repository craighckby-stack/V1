import { NextResponse } from "next/server";
import { sanitizeAndGovern } from "@/lib/pipeline/emg/sanitizer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SanitizeRequest {
  code: string;
}

// Assuming SanitizeResult is defined in "@/lib/pipeline/emg/sanitizer"
// and its 'violations' property is mutable (string[]), not readonly string[].
// We must ensure the return type matches the expected structure exactly.
// Since we cannot see the definition, we rely on the postmortem constraint:
// SecuritySanitizerResult.violations (readonly string[]) must map to SanitizeResult.violations (string[]).
// This implies we must copy the array if the underlying function returns a readonly array.

export async function POST(req: Request) {
  let json: SanitizeRequest;
  try {
    json = (await req.json()) as SanitizeRequest;
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

  // Check for required structure and type
  if (typeof json.code !== "string") {
    return NextResponse.json(
      { error: "code (string) is required in the request body." },
      { status: 400 }
    );
  }

  // Additional validation for empty string code
  if (json.code.trim() === "") {
    return NextResponse.json(
      { error: "code cannot be an empty string." },
      { status: 400 }
    );
  }

  try {
    const result = sanitizeAndGovern(json.code);
    
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
    const inputSnippet = json.code.substring(0, 50);
    
    return NextResponse.json(
      { error: `Sanitization failed for input code starting with: ${inputSnippet}... Error: ${errorMessage}` },
      { status: 500 }
    );
  }
}