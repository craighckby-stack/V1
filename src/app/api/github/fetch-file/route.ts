import { NextResponse } from "next/server";
import { getUsableToken, githubHeaders } from "@/lib/pipeline/api/github-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface GitHubContentsResponse {
  content?: string;
  sha?: string;
  path?: string;
  encoding?: string;
}

interface FetchFileRequest {
  repo: string;
  path: string;
  branch?: string;
  token?: string;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as FetchFileRequest;
    if (!body.repo || !body.path) {
      return NextResponse.json(
        { error: "repo and path are required" },
        { status: 400 }
      );
    }
    const branch = body.branch || "main";
    const token = getUsableToken(body.token);

    const url = `https://api.github.com/repos/${body.repo}/contents/${body.path}?ref=${branch}`;
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
