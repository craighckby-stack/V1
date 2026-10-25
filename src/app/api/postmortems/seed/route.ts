import { NextResponse } from "next/server";
import { seedPostmortemsFromMarkdown } from "@/lib/pipeline/postmortem/postmortem-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SeedRequest {
  markdown: string;
  repo: string;
  branch: string;
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
