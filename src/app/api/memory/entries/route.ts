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
      { error: "Memory service is not properly initialized." },
      { status: 500 }
    );
  }

  try {
    // Ensure the RAG memory store is seeded
    await emgRagInstance.ensureSeeded();
    
    // Get all entries
    const entries: VectorEntry[] | null = emgRagInstance.getAll();
    
    // Ensure we return an array, even if getAll returns null
    return NextResponse.json({ entries: entries || [] });
  } catch (err: unknown) {
    let errorMessage = "Failed to retrieve memory entries due to an internal service error.";
    
    if (err instanceof Error) {
      // Provide context from the error message, but keep the response clean.
      errorMessage = `Failed to retrieve memory entries: ${err.message}`;
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