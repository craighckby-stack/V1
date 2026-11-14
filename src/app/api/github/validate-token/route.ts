import { NextResponse } from "next/server";
import { z } from "zod";
import { getUsableToken, githubHeaders } from "@/lib/pipeline/api/github-helpers";
import { parseBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface GitHubUserResponse {
  login: string;
  avatar_url?: string;
  name?: string | null;
}

const validateTokenSchema = z.object({
  token: z.string().min(1).max(500).optional(),
}).strict();

export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, validateTokenSchema);
    if (!parsed.ok) return parsed.response;
    const token = getUsableToken(parsed.data.token);
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
