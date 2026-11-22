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

  if (SIPHON_SOURCES.length === 0) {
    return NextResponse.json({ sources: [] });
  }

  const validSources: CatalogEntry[] = [];
  const invalidSources: { index: number; reason: string }[] = [];

  // Process and validate in a single pass for better performance
  for (let i = 0; i < SIPHON_SOURCES.length; i++) {
    const source = SIPHON_SOURCES[i];
    let isValid = true;
    let reason = "";

    if (!source) {
      isValid = false;
      reason = "Source element is null or undefined.";
    } else if (!('patterns' in source) || !Array.isArray(source.patterns)) {
      isValid = false;
      reason = "Source is missing 'patterns' array or 'patterns' is not an array.";
    } else {
      const patterns = source.patterns;
      if (patterns.length === 0) {
        isValid = false;
        reason = "Source patterns array is empty.";
      } else {
        // Check all patterns for validity
        for (let j = 0; j < patterns.length; j++) {
          if (typeof patterns[j] !== 'string') {
            isValid = false;
            reason = `Pattern at index ${j} is not a string.`;
            break; // No need to check more patterns for this source
          }
        }
      }
    }

    if (!isValid) {
      invalidSources.push({ index: i, reason: reason });
    } else {
      // If we made it here, the source is valid
      validSources.push({
        source: source as SiphonSource,
        count: (source as any).patterns.length, // Safe cast as validation passed
        complianceStandard: "AST Diff Gate + Shannon Entropy Sanitizer",
        status: "configured",
      });
    }
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