import { NextResponse } from "next/server";
import { getUsableToken, githubHeaders } from "@/lib/pipeline/api/github-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CODE_EXT_REGEX = /\.(ts|tsx|js|jsx|json|md|py|go|rs|css|html|yaml|yml|sh|sql)$/i;
const IGNORED_DIR_REGEX = /^(node_modules|\.git|\.next|dist|build|coverage)\//i;

interface GitHubTreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

interface GitHubTreeResponse {
  tree: GitHubTreeEntry[];
  truncated: boolean;
}

interface RepoTreeRequest {
  repo: string;
  branch?: string;
  token?: string;
}

interface RepoFileEntry {
  path: string;
  sha: string;
  size?: number;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RepoTreeRequest;
    if (!body.repo) {
      return NextResponse.json(
        { error: "repo is required (format: owner/name)" },
        { status: 400 }
      );
    }
    const branch = body.branch || "main";
    const token = getUsableToken(body.token);

    let res = await fetch(
      `https://api.github.com/repos/${body.repo}/git/trees/${branch}?recursive=1`,
      { headers: githubHeaders(token) }
    );
    let resolvedBranch = branch;

    if (!res.ok && branch === "main") {
      // Fall back to "master" if the default branch isn't "main".
      res = await fetch(
        `https://api.github.com/repos/${body.repo}/git/trees/master?recursive=1`,
        { headers: githubHeaders(token) }
      );
      resolvedBranch = "master";
    }

    if (!res.ok) {
      return NextResponse.json(
        { error: `GitHub tree fetch failed (HTTP ${res.status})` },
        { status: res.status }
      );
    }

    const data = (await res.json()) as GitHubTreeResponse;
    const allBlobs = (data.tree ?? []).filter((item) => item.type === "blob");
    const files: RepoFileEntry[] = allBlobs
      .filter(
        (item) => CODE_EXT_REGEX.test(item.path) && !IGNORED_DIR_REGEX.test(item.path)
      )
      .map((item) => ({
        path: item.path,
        sha: item.sha,
        size: item.size,
      }));

    return NextResponse.json({
      files,
      totalCount: files.length,
      truncated: data.truncated ?? false,
      resolvedBranch,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
