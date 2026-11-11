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
    await emgRagInstance.ensureSeeded();
    const entries: VectorEntry[] = emgRagInstance.getAll();
    return NextResponse.json({ entries });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred while fetching memory entries.";
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}