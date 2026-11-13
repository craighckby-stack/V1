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
    
    // Empty entries array is a valid response, not an error
    return NextResponse.json({ entries: entries || [] });
  } catch (err) {
    let errorMessage = "An unknown error occurred while fetching memory entries.";
    if (err instanceof Error) {
      // Provide context but sanitize the message for external API consumption
      errorMessage = `Failed to retrieve memory entries: ${err.message}`;
    }
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}