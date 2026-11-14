import { NextResponse } from "next/server";
import { z } from "zod";
import { seedPostmortemsFromMarkdown } from "@/lib/pipeline/postmortem/postmortem-store";
import { parseBody, isRepoRelativePath } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const seedSchema = z.object({
  markdown: z.string().min(1).max(2_000_000),
  repo: z.string().min(1).max(200),
  branch: z.string().min(1).max(100),
  filePath: z.string().min(1).max(500).optional(),
}).strict();

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
    const parsed = await parseBody(req, seedSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    // AUDIT 3 F4a — traversal via seeded filePath previously reached
    // writeFileSync outside postmortems/. The store side is hardened
    // separately; this is the ROUTE gate: every filePath embedded in the
    // markdown entry headers (or passed directly on the body) is checked
    // for traversal / absolute-path shapes BEFORE the store is called.
    // Uses the shared isRepoRelativePath helper so it also catches Windows
    // drive-letter paths (C:\…), UNC (\\…), and ~ shorthands that the old
    // inline check missed (audit H8).
    const seededPaths = extractSeededFilePaths(body.markdown);
    if (body.filePath && body.filePath.trim() !== "") {
      seededPaths.push(body.filePath);
    }
    const badPaths = seededPaths.filter((p) => !isRepoRelativePath(p));
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
