import { NextResponse } from "next/server";
import { emgRagInstance, VectorEntry } from "@/lib/pipeline/emg/emg-rag";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/memory/entries
 *
 * Ensures the RAG memory store is seeded, then returns every persisted
 * memory entry (clean patterns, failure diagnoses, etc.).
 */
export async function GET() {
  try {
    // Check if emgRagInstance is properly initialized
    if (!emgRagInstance) {
      return NextResponse.json(
        { error: "Memory service is not properly initialized." },
        { status: 500 }
      );
    }

    // Ensure the RAG memory store is seeded
    await emgRagInstance.ensureSeeded();
    
    // Get all entries
    const entries: VectorEntry[] | null = emgRagInstance.getAll();
    
    // Ensure we return an array, even if getAll returns null
    return NextResponse.json({ entries: entries || [] });
  } catch (err: unknown) {
    let errorMessage = "An internal system error occurred while fetching memory entries.";
    
    if (err instanceof Error) {
      // Provide context but sanitize the message for external API consumption.
      // Only expose the message if it doesn't look like an internal stack trace or path.
      const errorMsg = err.message;
      if (errorMsg && !errorMsg.includes("at ") && !errorMsg.includes("/node_modules/")) {
        errorMessage = `Failed to retrieve memory entries: ${errorMsg}`;
      } else {
        errorMessage = "Failed to retrieve memory entries due to a service error.";
      }
    } else {
      // Handle non-Error objects (e.g., primitives thrown)
      errorMessage = "Failed to retrieve memory entries due to an unknown error type.";
    }
    
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}