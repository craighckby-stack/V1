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
  const invalidSources: { index: number; reason: string }[] = [];

  for (let i = 0; i < SIPHON_SOURCES.length; i++) {
    const source = SIPHON_SOURCES[i];
    
    // Check for null/undefined source element first
    if (!source) {
      invalidSources.push({ index: i, reason: "Source element is null or undefined." });
      continue;
    }

    // Check for required structure: 'patterns' must exist and be an array
    if (!('patterns' in source) || !Array.isArray((source as any).patterns)) {
      invalidSources.push({ index: i, reason: "Source is missing 'patterns' array or 'patterns' is not an array." });
      continue; // Skip invalid entry
    }
    
    // Safely cast after structural validation
    const typedSource = source as SiphonSource;

    // Ensure patterns property on the typed source is an array before accessing length
    const patterns = (typedSource as any).patterns;
    if (!Array.isArray(patterns)) {
        invalidSources.push({ index: i, reason: "Source patterns property is not an array after initial check." });
        continue;
    }

    validSources.push({
      source: typedSource,
      count: patterns.length,
      complianceStandard: "AST Diff Gate + Shannon Entropy Sanitizer",
      // Honest label: these are CONFIGURED siphon sources (declarative
      // config), not verified-live remote repositories. No liveness probe
      // is performed here, so we don't claim "active".
      status: "configured",
    });
  }

  if (invalidSources.length > 0) {
    return NextResponse.json(
      { 
        error: "Input validation failed: One or more siphon sources are invalid.", 
        invalidSources: invalidSources.map(inv => ({ index: inv.index, reason: inv.reason }))
      },
      { status: 400 }
    );
  }
    
  return NextResponse.json({ sources: validSources });
}