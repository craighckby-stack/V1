import { NextResponse } from "next/server";
import { SIPHON_SOURCES, SiphonSource } from "@/lib/pipeline/core/siphon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CatalogEntry {
  source: SiphonSource;
  count: number;
  complianceStandard: string;
  status: string;
}

/**
 * GET /api/engines/catalog
 * Lists every siphon (architectural template) source available to the pipeline.
 */
export async function GET() {
  try {
    const sources: CatalogEntry[] = SIPHON_SOURCES.map((source) => ({
      source,
      count: source.patterns.length,
      complianceStandard: "AST Diff Gate + Shannon Entropy Sanitizer",
      // Honest label: these are CONFIGURED siphon sources (declarative
      // config), not verified-live remote repositories. No liveness probe
      // is performed here, so we don't claim "active".
      status: "configured",
    }));
    return NextResponse.json({ sources });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during catalog retrieval.";
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}