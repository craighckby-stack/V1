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
  /** Optional base branch — when `branch` does not exist yet, it is
   *  created from this branch's HEAD before the commit (rea-revival
   *  stage-5 dispatch: evolution branches are born on first push). */
  baseBranch?: string;
}

interface GitHubCommitResponse {
  content?: { sha?: string; path?: string };
  commit?: { sha?: string };
  message?: string;
}

/**
 * Ensure `branch` exists on the repo; if missing, create it from
 * `baseBranch`'s HEAD (falling back to the repo's default branch).
 * Returns true when the branch exists (or was created); false when it
 * could not be ensured — in that case the caller proceeds to the PUT
 * anyway so GitHub's own error surfaces to the client.
 */
async function ensureBranch(
  repo: string,
  branch: string,
  baseBranch: string | undefined,
  token: string
): Promise<boolean> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Architecture-Helper-Pipeline",
  };

  // Already exists? Nothing to do.
  const refRes = await fetch(
    `https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    { headers }
  );
  if (refRes.ok) return true;
  if (refRes.status !== 404) return false; // unexpected — let the PUT surface it

  // Resolve the base SHA: explicit baseBranch first, else the default branch.
  let baseSha: string | null = null;
  if (baseBranch) {
    const baseRes = await fetch(
      `https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
      { headers }
    );
    if (baseRes.ok) {
      const baseData = (await baseRes.json()) as { object?: { sha?: string } };
      baseSha = baseData.object?.sha ?? null;
    }
  }
  if (!baseSha) {
    const repoRes = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    if (!repoRes.ok) return false;
    const repoData = (await repoRes.json()) as { default_branch?: string };
    const def = repoData.default_branch;
    if (!def) return false;
    const defRes = await fetch(
      `https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(def)}`,
      { headers }
    );
    if (!defRes.ok) return false;
    const defData = (await defRes.json()) as { object?: { sha?: string } };
    baseSha = defData.object?.sha ?? null;
  }
  if (!baseSha) return false;

  const createRes = await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });
  return createRes.ok;
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

    // Evolution-branch support: if the target branch doesn't exist yet,
    // create it from baseBranch (or the default branch) before committing.
    // Fail-open by design: on an unexpected GitHub error we still attempt
    // the PUT below so the real failure reaches the client.
    await ensureBranch(body.repo, body.branch, body.baseBranch, token);

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
