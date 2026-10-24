import { NextResponse } from "next/server";
import { getUsableToken } from "@/lib/pipeline/api/github-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface BatchFileEntry {
  path: string;
  content: string;
  sha?: string;
}

interface BatchCommitRequest {
  repo: string;
  branch: string;
  files: BatchFileEntry[];
  message: string;
  token?: string;
}

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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as BatchCommitRequest;
    if (!body.repo || !body.branch || !Array.isArray(body.files) || !body.message) {
      return NextResponse.json(
        { error: "repo, branch, files, and message are required" },
        { status: 400 }
      );
    }

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
        const url = `https://api.github.com/repos/${body.repo}/contents/${file.path}`;
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
