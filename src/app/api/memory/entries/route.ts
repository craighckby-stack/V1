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
    const error = err instanceof Error ? err : new Error("An unknown error occurred during memory retrieval.");
    console.error("Error retrieving memory entries:", error.message, error);
    
    let errorMessage = "An error occurred while accessing the memory store. Please check server logs for details.";
    
    // We only need to ensure we return a safe, non-descriptive error message to the client.
    
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}