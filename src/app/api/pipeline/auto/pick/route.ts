import { NextResponse } from "next/server";
import {
  listTargetTree,
  fetchTargetFile,
  getRepoDefaultBranch,
  type TargetTreeFile,
} from "@/lib/pipeline/target/target-github";
import {
  normalizeTargetRepo,
  validTargetRepoFormat,
  validTargetBranchFormat,
  resolveTargetToken,
} from "@/lib/pipeline/target/target-store";
import { getUsableToken } from "@/lib/pipeline/api/github-helpers";
import { scanTargetContent } from "@/lib/pipeline/target/target-scan";
import {
  rankCandidateFiles,
  pickBestFileToRefactor,
  DEFAULT_PICK_FETCH_COUNT,
  MAX_PICK_FETCH_COUNT,
  type FileScan,
} from "@/lib/pipeline/core/auto-picker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/pipeline/auto/pick — phase 1 of the one-click gauntlet.
 *
 * Resolve repo+branch → list the tree → rank mutable candidates by pure
 * path/size heuristics → fetch + static-scan the shortlist → return the
 * highest-signal file (its content rides back to the client, which then
 * feeds /api/pipeline/run — the same stateless round-trip the manual
 * runner uses).
 *
 * Token: client PAT → sealed [CONFIG] push-target PAT → anonymous.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      repo?: string;
      branch?: string;
      token?: string;
      maxFetch?: number;
    };

    const repo = normalizeTargetRepo(typeof body.repo === "string" ? body.repo : "");
    if (!validTargetRepoFormat(repo)) {
      return NextResponse.json(
        { ok: false, error: `Invalid repo "${body.repo ?? ""}" — expected owner/name` },
        { status: 400 }
      );
    }

    const token = getUsableToken(typeof body.token === "string" ? body.token : undefined)
      ?? (await resolveTargetToken());

    // Branch: explicit (validated) → repo default.
    let branch: string | null = null;
    if (typeof body.branch === "string" && body.branch.trim().length > 0) {
      if (!validTargetBranchFormat(body.branch.trim())) {
        return NextResponse.json(
          { ok: false, error: `Invalid branch "${body.branch}"` },
          { status: 400 }
        );
      }
      branch = body.branch.trim();
    } else {
      branch = await getRepoDefaultBranch(repo, token);
      if (!branch) {
        return NextResponse.json(
          { ok: false, error: `Could not resolve default branch for ${repo} (private repo without a token? 404?)` },
          { status: 404 }
        );
      }
    }

    const treeRes = await listTargetTree(repo, branch, token);
    if (!treeRes.ok) {
      return NextResponse.json({ ok: false, error: treeRes.error }, { status: 502 });
    }

    const ranked = rankCandidateFiles(treeRes.tree.files as TargetTreeFile[]);
    if (ranked.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            `no analyzable candidates in ${repo}@${branch} — need ts/tsx/js/jsx, non-test, ` +
            `non-protected, 400B–100KB (checked ${treeRes.tree.files.length} tree entries)`,
        },
        { status: 422 }
      );
    }

    const fetchCount = Math.max(
      1,
      Math.min(MAX_PICK_FETCH_COUNT, body.maxFetch ?? DEFAULT_PICK_FETCH_COUNT)
    );
    const shortlist = ranked.slice(0, fetchCount);

    // Fetch + scan the shortlist. A single failed fetch is skipped
    // (honestly counted); only ALL-failed is fatal.
    const scans: FileScan[] = [];
    let firstFetchError: string | null = null;
    for (const cand of shortlist) {
      const fres = await fetchTargetFile(repo, cand.path, branch, token);
      if (!fres.ok) {
        if (!firstFetchError) firstFetchError = `${cand.path}: ${fres.error}`;
        continue;
      }
      scans.push({ path: cand.path, findings: scanTargetContent(cand.path, fres.file.content) });
    }

    if (scans.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `could not fetch any of the ${shortlist.length} shortlisted files — ${firstFetchError}`,
        },
        { status: 502 }
      );
    }

    const decision = pickBestFileToRefactor(scans);
    if (!decision) {
      return NextResponse.json(
        { ok: false, error: "shortlist scan produced no decision" },
        { status: 500 }
      );
    }

    // The scans deliberately didn't keep N×100KB of content in memory —
    // one extra fetch of the chosen file only.
    const winRes = await fetchTargetFile(repo, decision.path, branch, token);
    if (!winRes.ok) {
      return NextResponse.json(
        { ok: false, error: `winner re-fetch failed for ${decision.path}: ${winRes.error}` },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      repo,
      branch,
      pick: {
        path: decision.path,
        size: winRes.file.size,
        blobSha: winRes.file.blobSha,
        content: winRes.file.content,
        score: decision.score,
        findings: decision.summary.map((s) => ({ kind: s.kind, count: s.count })),
        fallback: decision.fallback,
        reason: decision.reason,
      },
      meta: {
        candidatesRanked: ranked.length,
        candidatesFetched: scans.length,
        treeTruncated: treeRes.tree.truncated,
        totalTreeFiles: treeRes.tree.files.length,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
