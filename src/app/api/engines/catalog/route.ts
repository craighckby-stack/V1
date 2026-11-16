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
  if (!SIPHON_SOURCES) {
    return NextResponse.json(
      { error: "Catalog sources not available: SIPHON_SOURCES is undefined or null." },
      { status: 500 }
    );
  }

  if (!Array.isArray(SIPHON_SOURCES)) {
    return NextResponse.json(
      { error: "SIPHON_SOURCES must be an array." },
      { status: 500 }
    );
  }

  const validSources: CatalogEntry[] = [];
  let hasInvalidSource = false;

  for (const source of SIPHON_SOURCES) {
    if (!source || !Array.isArray(source.patterns)) {
      hasInvalidSource = true;
      continue; // Skip invalid entry instead of throwing
    }
    
    validSources.push({
      source,
      count: source.patterns.length,
      complianceStandard: "AST Diff Gate + Shannon Entropy Sanitizer",
      // Honest label: these are CONFIGURED siphon sources (declarative
      // config), not verified-live remote repositories. No liveness probe
      // is performed here, so we don't claim "active".
      status: "configured",
    });
  }

  if (hasInvalidSource) {
    return NextResponse.json(
      { error: "Input validation failed: One or more siphon sources are missing or have non-array 'patterns' property." },
      { status: 400 }
    );
  }
    
  return NextResponse.json({ sources: validSources });
}