import { NextResponse } from "next/server";
import { z } from "zod";
import { getUsableToken } from "@/lib/pipeline/api/github-helpers";
import { parseBody, REPO_REGEX, isRepoRelativePath } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface BatchResultEntry {
  path: string;
  success: boolean;
  sha?: string;
  error?: string;
}

interface GitHubCommitResponse {
  content?: { sha?: string; path?: string };
  message?: string;
}

// Audit 2, item 16: an EMPTY files array used to pass validation and then
// report success ("committed 0 of 0") — a no-op dressed as a success.
const batchCommitSchema = z.object({
  repo: z.string().regex(REPO_REGEX, "repo must be 'owner/name'").max(100),
  branch: z.string().min(1).max(100),
  files: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(1000)
          .refine(isRepoRelativePath, "path must be repo-relative (no .. or leading /)"),
        content: z.string().max(10_000_000),
        sha: z.string().min(1).max(100).optional(),
      }).strict(),
    )
    .min(1)
    .max(100),
  message: z.string().min(1).max(1000),
  token: z.string().min(1).max(500).optional(),
}).strict();

export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, batchCommitSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const token = getUsableToken(body.token);
    if (!token) {
      return NextResponse.json(
        { error: "A valid GitHub token is required to commit files" },
        { status: 401 }
      );
    }

    const results: BatchResultEntry[] = [];
    let committedCount = 0;

    for (const file of body.files) {
      try {
        const url = `https://api.github.com/repos/${encodeURIComponent(body.repo)}/contents/${encodeURIComponent(file.path)}`;
        const payload: Record<string, unknown> = {
          message: body.message,
          content: Buffer.from(file.content).toString("base64"),
          branch: body.branch,
        };
        if (file.sha) {
          payload.sha = file.sha;
        }

        const res = await fetch(url, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "Architecture-Helper-Pipeline",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        const data = (await res.json().catch(() => ({}))) as GitHubCommitResponse;
        if (res.ok) {
          committedCount++;
          results.push({
            path: file.path,
            success: true,
            sha: data.content?.sha,
          });
        } else {
          results.push({
            path: file.path,
            success: false,
            error: data.message ?? `HTTP ${res.status}`,
          });
        }
      } catch (err) {
        results.push({
          path: file.path,
          success: false,
          error: (err as Error).message,
        });
      }
    }

    return NextResponse.json({
      success: committedCount === body.files.length,
      committedCount,
      totalCount: body.files.length,
      results,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
