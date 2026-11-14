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
  if (!emgRagInstance) {
    return NextResponse.json(
      { error: "Memory service is not properly initialized. Check service startup logs." },
      { status: 500 }
    );
  }

  try {
    // Ensure the RAG memory store is seeded
    await emgRagInstance.ensureSeeded();
    
    // Get all entries
    const entries: VectorEntry[] | null | undefined = emgRagInstance.getAll();
    
    // Ensure we return an array, defaulting to empty array if null or undefined
    return NextResponse.json({ entries: entries || [] });
  } catch (err: unknown) {
    let errorMessage = "Failed to retrieve memory entries due to an internal service error.";
    
    if (err instanceof Error) {
      // Use a contextual message but avoid exposing raw internal error details in the public response body
      errorMessage = "An error occurred while accessing the memory store. Please check server logs for details.";
    } else if (typeof err === 'object' && err !== null && 'message' in err) {
      // Handle objects that might resemble errors but aren't instances of Error
      errorMessage = "An unknown error occurred while accessing the memory store. Please check server logs for details.";
    }
    
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}