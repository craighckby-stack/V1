import { NextResponse } from "next/server";
import { getUsableToken, githubHeaders } from "@/lib/pipeline/api/github-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface GitHubUserResponse {
  login: string;
  avatar_url?: string;
  name?: string | null;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { token?: string };
    const token = getUsableToken(body.token);
    if (!token) {
      return NextResponse.json(
        { valid: false, error: "Invalid or missing GitHub token" },
        { status: 400 }
      );
    }

    const res = await fetch("https://api.github.com/user", {
      headers: githubHeaders(token),
    });

    if (!res.ok) {
      return NextResponse.json(
        { valid: false, error: `GitHub rejected token (HTTP ${res.status})` },
        { status: res.status }
      );
    }

    const data = (await res.json()) as GitHubUserResponse;
    const scopesHeader = res.headers.get("x-oauth-scopes") ?? "";
    const scopes = scopesHeader
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    return NextResponse.json({
      valid: true,
      username: data.login,
      avatarUrl: data.avatar_url ?? null,
      name: data.name ?? null,
      scopes,
    });
  } catch (err) {
    return NextResponse.json(
      { valid: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
