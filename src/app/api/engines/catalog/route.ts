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
      status: "active",
    }));
    return NextResponse.json({ sources });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
