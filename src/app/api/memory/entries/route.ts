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
    if (err instanceof Error) {
      console.error("Error retrieving memory entries:", err.message, err.stack);
      
      // Provide actionable error context based on the caught error
      const errorMessage = `Failed to access memory store: ${err.message}. Please check service logs for details.`;
      return NextResponse.json(
        { error: errorMessage },
        { status: 500 }
      );
    } else {
      console.error("Error retrieving memory entries:", err);
      
      // Provide actionable error context for non-Error objects
      const errorMessage = "An unknown error occurred while accessing the memory store.";
      return NextResponse.json(
        { error: errorMessage },
        { status: 500 }
      );
    }
  }
}