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
        { error: "Catalog sources not available: SIPHON_SOURCES is undefined." },
        { status: 500 }
      );
    }

    if (!Array.isArray(SIPHON_SOURCES)) {
      return NextResponse.json(
        { error: "SIPHON_SOURCES must be an array." },
        { status: 500 }
      );
    }

    const sources: CatalogEntry[] = SIPHON_SOURCES
      .map((source) => {
        if (!source || !Array.isArray(source.patterns)) {
          // Log the issue but skip the invalid source instead of throwing and failing the whole request
          console.warn(`Invalid siphon source found and skipped: source object is missing required or invalid 'patterns' property. Source data: ${JSON.stringify(source)}`);
          return null;
        }
        
        return {
          source,
          count: source.patterns.length,
          complianceStandard: "AST Diff Gate + Shannon Entropy Sanitizer",
          // Honest label: these are CONFIGURED siphon sources (declarative
          // config), not verified-live remote repositories. No liveness probe
          // is performed here, so we don't claim "active".
          status: "configured",
        } as CatalogEntry;
      })
      .filter((source): source is CatalogEntry => source !== null);
    
    return NextResponse.json({ sources });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Log the detailed error internally for debugging, providing context about the operation.
    console.error("Error retrieving siphon catalog: Operation failed. Details:", errorMessage, err);
    
    return NextResponse.json(
      { error: "Failed to retrieve catalog due to a server error. Please check server logs for specific details." },
      { status: 500 }
    );
  }
}