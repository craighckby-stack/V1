import { NextResponse } from "next/server";
import { getStoredTarget } from "@/lib/pipeline/autonomous/push-target";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/branches
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
 * Returns: { total, branches: [{ name, number, sha, message, date, url }] }
 */
export async function GET() {
  try {
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

    // Fetch all branches (per_page=100 covers the current 38; if it ever
    // exceeds 100, pagination would be needed — flagged with truncated:true).
    const res = await fetch(
      `https://api.github.com/repos/${target.repo}/branches?per_page=100`,
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

    const data = (await res.json()) as Array<{
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
    }>;

    // The branches LIST endpoint only returns { sha, url } per commit —
    // no message, no date. To show what each mutation actually did, fetch
    // each branch's HEAD commit in parallel (38 small GETs complete in
    // ~1-2s; GitHub tolerates parallel reads fine). This is on-demand
    // (only when the operator opens the branches view), not per-cycle.
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

    const commitDetails = await Promise.all(
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
    );

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
      truncated: data.length >= 100,
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
