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
    // Log the actual error for debugging purposes before sending a generic response
    console.error("Error retrieving memory entries:", err);

    let errorMessage = "An error occurred while accessing the memory store. Please check server logs for details.";
    
    // Simplified error handling: if it's an Error instance, we know it has a message, 
    // but we still return the generic message to prevent leaking internal stack traces.
    if (err instanceof Error) {
      // Use the generic message as intended by the original logic's intent (hiding details)
    } else if (typeof err === 'object' && err !== null && 'message' in err) {
      // Handle objects that might resemble errors but aren't instances of Error
      // Still use the generic message for security/stability.
    }
    
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}