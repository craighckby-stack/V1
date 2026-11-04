import { NextResponse } from "next/server";
import { getStoredTarget } from "@/lib/pipeline/autonomous/push-target";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/branches[?details=1]
 * Lists the `loop-NN` mutation branches on the configured GitHub remote.
 *
 * WHY THIS EXISTS: the autonomous loop creates one branch per
 * successful enhancement (mutation) — `loop-01` = first mutation,
 * `loop-02` = second, etc. After a sandbox reboot that wiped the local
 * branch counter, the loop was about to reuse `loop-01` and contaminate
 * the first mutation's branch. This endpoint makes the full mutation
 * history visible + inspectable so the operator can audit what the loop
 * has actually produced, and verify the counter reconciliation.
 *
 * PAGINATION (audit 3 F8 — same fix as reconcileBranchNumberFromGitHub):
 * the repo holds 108+ loop branches; the old single `?per_page=100` page
 * silently undercounted. Pages are walked until a short page returns
 * (cap 30 pages ≈ 3000 refs, GitHub's own ceiling). `truncated` now means
 * the cap was hit, not "100 on the first page".
 *
 * DETAILS ON DEMAND: the per-branch commit message/date costs one GitHub
 * GET per branch (108+ calls). The boot splash only needs the COUNT, so
 * per-commit metadata is fetched only when `?details=1` is present (the
 * branches panel passes it; the splash path stays one-cheap-call).
 *
 * Returns: { total, branches: [{ name, number, sha, message, date, url }] }
 */

interface BranchRow {
  name: string;
  commit?: {
    sha?: string;
    commit?: {
      message?: string;
      author?: { date?: string };
      html_url?: string;
    };
  };
  _links?: { html?: string };
}

export async function GET(req: Request) {
  try {
    const wantDetails = new URL(req.url).searchParams.get("details") === "1";
    const target = await getStoredTarget();
    if (!target || !target.token) {
      return NextResponse.json(
        {
          ok: false,
          total: 0,
          branches: [],
          reason: "No push target configured — set the PAT via the [CONFIG] panel.",
        },
        { status: 200 }
      );
    }

    // Walk ALL pages. Short page (<100) = last page. 30-page hard cap
    // mirrors GitHub's ~3000-ref API ceiling.
    const data: BranchRow[] = [];
    let hitCap = false;
    for (let page = 1; page <= 30; page++) {
      const res = await fetch(
        `https://api.github.com/repos/${target.repo}/branches?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${target.token}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "Architecture-Helper-Pipeline",
          },
        }
      );
      if (!res.ok) {
        return NextResponse.json(
          {
            ok: false,
            total: 0,
            branches: [],
            reason: `GitHub API returned ${res.status}`,
          },
          { status: 200 }
        );
      }
      const pageData = (await res.json()) as BranchRow[];
      data.push(...pageData);
      if (pageData.length < 100) break;
      if (page === 30) hitCap = true;
    }

    const loopMeta: Array<{ name: string; number: number; sha: string }> = [];
    let maxNumber = 0;
    for (const b of data) {
      const m = /^loop-(\d+)$/.exec(b.name);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (n > maxNumber) maxNumber = n;
      loopMeta.push({
        name: b.name,
        number: n,
        sha: b.commit?.sha ?? "",
      });
    }

    // Per-commit metadata only when the caller asked for it. The names-only
    // path (splash, counter reconciliation) does ZERO extra GitHub calls.
    const commitDetails = wantDetails
      ? await Promise.all(
          loopMeta.map(async (lm) => {
            if (!lm.sha) {
              return { ...lm, message: "(no sha)", date: null, url: "" };
            }
            try {
              const cRes = await fetch(
                `https://api.github.com/repos/${target.repo}/commits/${lm.sha}`,
                {
                  headers: {
                    Authorization: `Bearer ${target.token}`,
                    Accept: "application/vnd.github.v3+json",
                    "User-Agent": "Architecture-Helper-Pipeline",
                  },
                }
              );
              if (!cRes.ok) {
                return { ...lm, message: `(fetch failed: ${cRes.status})`, date: null, url: "" };
              }
              const cData = (await cRes.json()) as {
                commit?: { message?: string; author?: { date?: string } };
                html_url?: string;
              };
              const fullMsg = cData.commit?.message ?? "(no message)";
              return {
                ...lm,
                message: fullMsg.split("\n")[0]?.slice(0, 120) ?? "",
                date: cData.commit?.author?.date ?? null,
                url: cData.html_url ?? "",
              };
            } catch {
              return { ...lm, message: "(fetch error)", date: null, url: "" };
            }
          })
        )
      : loopMeta.map((lm) => ({ ...lm, message: "", date: null, url: "" }));

    const loopBranches = commitDetails
      .map((c) => ({
        name: c.name,
        number: c.number,
        sha: c.sha.slice(0, 7),
        message: c.message,
        date: c.date,
        url:
          c.url ||
          `https://github.com/${target.repo}/tree/${c.name}`,
      }))
      .sort((a, b) => a.number - b.number);

    // Also note the non-loop branches (main, Original, etc.) for context.
    const otherBranches = data
      .filter((b) => !/^loop-\d+$/.test(b.name))
      .map((b) => ({
        name: b.name,
        sha: b.commit?.sha?.slice(0, 7) ?? "?",
        message: "", // not fetched for non-loop branches (not interesting)
      }));

    return NextResponse.json({
      ok: true,
      repo: target.repo,
      total: loopBranches.length,
      maxLoopNumber: maxNumber,
      nextMutationBranch: `loop-${String(maxNumber + 1).padStart(2, "0")}`,
      truncated: hitCap,
      branches: loopBranches,
      otherBranches,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message, total: 0, branches: [] },
      { status: 500 }
    );
  }
}
