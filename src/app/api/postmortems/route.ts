import { NextResponse } from "next/server";
import { postmortemStore } from "@/lib/pipeline/postmortem/postmortem-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/postmortems?repo=owner/repo&branch=main
 * Returns all active postmortems (optionally filtered by repo/branch).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const repo = url.searchParams.get("repo") ?? undefined;
    const branch = url.searchParams.get("branch") ?? undefined;
    const postmortems = await postmortemStore.listActive(repo, branch);
    return NextResponse.json({
      count: postmortems.length,
      postmortems,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/postmortems?id=<cuid>
 * Deletes (dismisses) a postmortem by ID.
 */
export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json(
        { error: "Missing ?id=<postmortemId>" },
        { status: 400 }
      );
    }
    await postmortemStore.delete(id);
    return NextResponse.json({ success: true, id });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
