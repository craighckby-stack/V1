import { NextResponse } from "next/server";
import { z } from "zod";
import { getStoredTarget } from "@/lib/pipeline/autonomous/push-target";
import { parseBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Repo visibility — the share-link enabler.
 *
 * The BRANCHES dialog shows commit links like
 *   https://github.com/{owner}/{repo}/commit/{sha}
 * but the auto-created repo is PRIVATE by default, so every link 404s
 * for anyone who isn't a collaborator. "The link to share doesn't work"
 * was the bug report. This endpoint lets the owner flip the repo
 * PUBLIC from inside the CONFIG dialog so the links start resolving
 * for the people they share them with.
 *
 *   GET  → { configured, repo, private, error? }
 *   POST body { private: boolean } → { ok, repo, private }
 *
 * Uses the SAME classic PAT already stored for pushes — the `repo`
 * scope covers visibility changes. No new auth is required.
 */

async function ghFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
}

/** GET — read the repo's CURRENT visibility straight from GitHub,
 *  because the locally stored `isPublic` flag can drift out of sync
 *  if the owner flips it on github.com directly. */
export async function GET() {
  try {
    const t = await getStoredTarget();
    if (!t) return NextResponse.json({ configured: false }, { status: 200 });
    const r = await ghFetch(`/repos/${t.repo}`, t.token);
    if (!r.ok) {
      return NextResponse.json(
        { configured: true, repo: t.repo, error: `GitHub ${r.status}` },
        { status: 200 }
      );
    }
    const data = (await r.json()) as { private?: boolean; message?: string };
    if (typeof data.private !== "boolean") {
      return NextResponse.json(
        { configured: true, repo: t.repo, error: data.message ?? "no private field" },
        { status: 200 }
      );
    }
    return NextResponse.json({ configured: true, repo: t.repo, private: data.private });
  } catch (err) {
    return NextResponse.json({ configured: false, error: (err as Error).message }, { status: 500 });
  }
}

const visibilitySchema = z.object({
  private: z.boolean(),
}).strict();

/** POST — flip visibility. Body: { private: boolean }.
 *  PATCH /repos/{owner}/{repo} with { private: bool } is the official
 *  GitHub REST path for toggling public/private. The PAT's `repo`
 *  scope grants this — no admin:org needed for user-owned repos. */
export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, visibilitySchema);
    if (!parsed.ok) return parsed.response;
    const t = await getStoredTarget();
    if (!t) {
      return NextResponse.json({ ok: false, error: "no push target configured" }, { status: 404 });
    }
    const r = await ghFetch(`/repos/${t.repo}`, t.token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // audit H4: the `name` field is dropped — GitHub validates it against
      // the URL path's repo and a renamed repo made the PATCH 422.
      body: JSON.stringify({ private: parsed.data.private }),
    });
    if (!r.ok) {
      const txt = await r.text();
      return NextResponse.json(
        { ok: false, error: `GitHub ${r.status}: ${txt.slice(0, 200)}` },
        { status: 502 }
      );
    }
    const data = (await r.json()) as { private?: boolean };
    return NextResponse.json({
      ok: true,
      repo: t.repo,
      private: typeof data.private === "boolean" ? data.private : parsed.data.private,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
