import { NextResponse } from "next/server";
import { seedPostmortemsFromMarkdown } from "@/lib/pipeline/postmortem/postmortem-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SeedRequest {
  markdown: string;
  repo: string;
  branch: string;
  /** Optional direct path override — validated below if present. */
  filePath?: string;
}

/**
 * Extract every filePath the store's markdown parser would seed. Mirrors
 * the entry-header shape (`### ❌ [date] path/to/file.ts`) so the route can
 * gate the paths BEFORE the store ever sees them.
 */
function extractSeededFilePaths(markdown: string): string[] {
  const paths: string[] = [];
  const entries = markdown.split(/^### ❌/m).slice(1);
  for (const entry of entries) {
    const headerMatch = entry.match(/^\s*\[[^\]]*\]\s+(\S+)/);
    if (headerMatch) paths.push(headerMatch[1]);
  }
  return paths;
}

/**
 * POST /api/postmortems/seed
 * Seeds postmortems from an external markdown file (e.g. POSTMORTEMS.md
 * produced by another enhancer). Imports all entries as active postmortems.
 *
 * Body: { markdown: string, repo: string, branch: string }
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SeedRequest;
    if (!body.markdown || typeof body.markdown !== "string") {
      return NextResponse.json(
        { error: "markdown (string) is required" },
        { status: 400 }
      );
    }
    if (!body.repo || !body.branch) {
      return NextResponse.json(
        { error: "repo and branch are required" },
        { status: 400 }
      );
    }

    // AUDIT 3 F4a — traversal via seeded filePath previously reached
    // writeFileSync outside postmortems/. The store side is hardened
    // separately; this is the ROUTE gate: every filePath embedded in the
    // markdown entry headers (or passed directly on the body) is checked
    // for traversal / absolute-path shapes BEFORE the store is called.
    const seededPaths = extractSeededFilePaths(body.markdown);
    if (typeof body.filePath === "string" && body.filePath.trim() !== "") {
      seededPaths.push(body.filePath);
    }
    const badPaths = seededPaths.filter(
      (p) => p.includes("..") || p.startsWith("/") || p.startsWith("\\")
    );
    if (badPaths.length > 0) {
      return NextResponse.json(
        {
          error:
            "Invalid filePath in seeded markdown: paths must be relative and stay inside the project " +
            `(rejected: ${badPaths.slice(0, 5).join(", ")})`,
        },
        { status: 400 }
      );
    }
    const count = await seedPostmortemsFromMarkdown(body.markdown, body.repo, body.branch);
    return NextResponse.json({
      success: true,
      seeded: count,
      repo: body.repo,
      branch: body.branch,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
