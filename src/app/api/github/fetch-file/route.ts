import { NextResponse } from "next/server";
import { z } from "zod";
import { getUsableToken, githubHeaders } from "@/lib/pipeline/api/github-helpers";
import { parseBody, REPO_REGEX, isRepoRelativePath } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface GitHubContentsResponse {
  content?: string;
  sha?: string;
  path?: string;
  encoding?: string;
}

const fetchFileSchema = z.object({
  repo: z.string().regex(REPO_REGEX, "repo must be 'owner/name'").max(100),
  path: z
    .string()
    .min(1)
    .max(1000)
    .refine(isRepoRelativePath, "path must be repo-relative (no .. or leading /)"),
  branch: z.string().min(1).max(100).optional(),
  token: z.string().min(1).max(500).optional(),
}).strict();

export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, fetchFileSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const branch = body.branch || "main";
    const token = getUsableToken(body.token);

    // Path/branch are encodeURIComponent'd so `?`/`#`/`../` can't rewrite
    // the URL — the old template literal passed them verbatim.
    const url = `https://api.github.com/repos/${encodeURIComponent(body.repo)}/contents/${encodeURIComponent(body.path)}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, { headers: githubHeaders(token) });
    if (!res.ok) {
      return NextResponse.json(
        { error: `GitHub fetch failed (HTTP ${res.status})` },
        { status: res.status }
      );
    }

    const data = (await res.json()) as GitHubContentsResponse;
    const rawContent = data.content ?? "";
    const content =
      data.encoding === "base64"
        ? Buffer.from(rawContent.replace(/\n/g, ""), "base64").toString("utf-8")
        : rawContent;

    return NextResponse.json({
      content,
      sha: data.sha ?? "",
      path: data.path ?? body.path,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
