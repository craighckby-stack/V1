import { NextResponse } from "next/server";
import { getUsableToken } from "@/lib/pipeline/api/github-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CommitFileRequest {
  repo: string;
  path: string;
  branch: string;
  content: string;
  message: string;
  sha?: string;
  token?: string;
}

interface GitHubCommitResponse {
  content?: { sha?: string; path?: string };
  commit?: { sha?: string };
  message?: string;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as CommitFileRequest;
    // Audit 2, item 17: `!body.content` rejected the legitimate empty-string
    // file (a valid thing to commit). Type-check instead of truthiness.
    if (!body.repo || !body.path || !body.branch || typeof body.content !== "string" || !body.message) {
      return NextResponse.json(
        { error: "repo, path, branch, content (string, may be empty), and message are required" },
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

    const url = `https://api.github.com/repos/${body.repo}/contents/${body.path}`;
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
