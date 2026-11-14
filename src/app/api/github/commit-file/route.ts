import { NextResponse } from "next/server";
import { z } from "zod";
import { getUsableToken } from "@/lib/pipeline/api/github-helpers";
import { parseBody, REPO_REGEX, isRepoRelativePath } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface GitHubCommitResponse {
  content?: { sha?: string; path?: string };
  commit?: { sha?: string };
  message?: string;
}

const commitFileSchema = z.object({
  repo: z.string().regex(REPO_REGEX, "repo must be 'owner/name'").max(100),
  path: z
    .string()
    .min(1)
    .max(1000)
    .refine(isRepoRelativePath, "path must be repo-relative (no .. or leading /)"),
  branch: z.string().min(1).max(100),
  // Audit 2, item 17: an EMPTY string is a legitimate file content — type
  // check, never truthiness.
  content: z.string().max(10_000_000),
  message: z.string().min(1).max(1000),
  sha: z.string().min(1).max(100).optional(),
  token: z.string().min(1).max(500).optional(),
}).strict();

export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, commitFileSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const token = getUsableToken(body.token);
    if (!token) {
      return NextResponse.json(
        { error: "A valid GitHub token is required to commit files" },
        { status: 401 }
      );
    }

    const url = `https://api.github.com/repos/${encodeURIComponent(body.repo)}/contents/${encodeURIComponent(body.path)}`;
    const payload: Record<string, unknown> = {
      message: body.message,
      content: Buffer.from(body.content).toString("base64"),
      branch: body.branch,
    };
    if (body.sha) {
      payload.sha = body.sha;
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
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
