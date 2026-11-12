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
    if (!SIPHON_SOURCES) {
      return NextResponse.json(
        { error: "Catalog sources not available - SIPHON_SOURCES is undefined" },
        { status: 500 }
      );
    }

    const sources: CatalogEntry[] = SIPHON_SOURCES.map((source, index) => {
      if (!source) {
        throw new Error(`Invalid siphon source at index ${index}: source is null or undefined`);
      }
      
      if (!source.patterns || !Array.isArray(source.patterns)) {
        throw new Error(`Invalid siphon source at index ${index}: missing or invalid 'patterns' property`);
      }
      
      return {
        source,
        count: source.patterns.length,
        complianceStandard: "AST Diff Gate + Shannon Entropy Sanitizer",
        // Honest label: these are CONFIGURED siphon sources (declarative
        // config), not verified-live remote repositories. No liveness probe
        // is performed here, so we don't claim "active".
        status: "configured",
      };
    });
    
    return NextResponse.json({ sources });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during catalog retrieval.";
    return NextResponse.json(
      { error: `Failed to retrieve catalog from /api/engines/catalog: ${errorMessage}` },
      { status: 500 }
    );
  }
}