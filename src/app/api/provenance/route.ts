import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { gitLogForFile, classifyCommitActor } from "@/lib/pipeline/core/git-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/provenance?file=<path>
 *
 * The per-file provenance timeline — the direct answer to "what part of
 * the system fixed this, and when?" The data already exists in five
 * places (git log, mutation corpus, postmortems, pipeline runs, lessons);
 * this route joins them into ONE chronological timeline per file so the
 * operator can read the file's whole story without reconstructing it.
 *
 * Sources joined (oldest → newest):
 *   git log       — every commit that touched the file, classified:
 *                    "loop"     = "Self-enhancement: <file>" (the autonomous loop)
 *                    "operator" = manual pushes, audits, the original authoring
 *   mutationCorpus— every autonomous-loop attempt (cycle, gate outcome,
 *                    transform summary, failure type, lessons injected).
 *   postmortem    — every scar for the file (failure type, symptom,
 *                    status, attempts, source label).
 *   pipelineRun   — every gauntlet run (manual/auto) on the file.
 *   lesson        — active distilled rules (the aggregate the file's
 *                    postmortems feed into; shown for context, not a
 *                    per-file FK — lessons are distilled from ALL
 *                    autonomous postmortems, not per-file).
 *
 * Actor classification on the timeline:
 *   operator — git commits not from the loop; the human in the loop.
 *   loop     — the autonomous self-enhance loop's mutations + the
 *              "Self-enhancement:" commits it pushes.
 *   system   — red-team / duress / hot-swap records (postmortem.source
 *              === "system").
 *   manual   — the gauntlet's manual runner (postmortem.source ===
 *              "manual"; pipelineRun.triggeredBy === "manual").
 *   auto     — the gauntlet's one-click runner (postmortem.source ===
 *              "auto"; pipelineRun.triggeredBy === "auto").
 *
 * The timeline is capped at 200 entries (newest-first) so a heavily-
 * mutated file (the loop has touched some files 100+ times) doesn't
 * flood the terminal. `summary` gives the headline counts.
 */

interface TimelineEntry {
  at: string; // ISO timestamp (sortable)
  atMs: number; // epoch ms for sorting
  kind: "git-commit" | "mutation" | "postmortem" | "pipeline-run" | "lesson";
  actor: "operator" | "loop" | "system" | "manual" | "auto";
  /** A short human-readable headline. */
  title: string;
  /** Structured details for the terminal renderer. */
  details: Record<string, unknown>;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const fileParam = url.searchParams.get("file") ?? "";
    if (!fileParam.trim()) {
      return NextResponse.json(
        { error: "file query param is required (e.g. ?file=src/lib/retro-boot-audio.ts)" },
        { status: 400 }
      );
    }
    // Normalize: strip leading ./ and the project root, collapse // .
    let filePath = fileParam.trim();
    filePath = filePath.replace(/^\.?\//, "");
    const projectRoot = process.cwd().replace(/\/$/, "");
    if (filePath.startsWith(projectRoot + "/")) filePath = filePath.slice(projectRoot.length + 1);

    // ── Gather all sources in parallel ────────────────────────────
    // PERF-3 fix: cap gitLogForFile at 200 (matching the timeline cap) so
    // a heavily-mutated file (100+ commits) doesn't spawn a full-history git
    // log only to truncate after sorting. The cap matches the timeline cap.
    const [gitLog, mutations, postmortems, pipelineRuns, lessons] = await Promise.all([
      gitLogForFile(projectRoot, filePath, 200),
      // MutationCorpus is the SELF-loop only (no repo field) — these
      // are the autonomous loop's attempts on this file.
      db.mutationCorpus
        .findMany({
          where: { filePath },
          select: {
            cycleNumber: true,
            branchNumber: true,
            gateOutcome: true,
            failureType: true,
            originalSha: true,
            mutatedSha: true,
            transformSummary: true,
            lessonIdsInjected: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        })
        .catch(() => []),
      db.postmortem
        .findMany({
          where: { filePath },
          select: {
            targetRepo: true,
            branch: true,
            status: true,
            verificationStatus: true,
            failureType: true,
            symptom: true,
            attempts: true,
            source: true,
            createdAt: true,
            updatedAt: true,
            resolvedAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        })
        .catch(() => []),
      db.pipelineRun
        .findMany({
          where: { filePath },
          select: {
            targetRepo: true,
            targetBranch: true,
            status: true,
            astScore: true,
            consensus: true,
            proofHash: true,
            triggeredBy: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        })
        .catch(() => []),
      db.lesson
        .findMany({
          where: { active: true },
          select: {
            id: true,
            content: true,
            kind: true,
            sourceType: true,
            sourceCount: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        })
        .catch(() => []),
    ]);

    // ── Build the timeline ────────────────────────────────────────
    const entries: TimelineEntry[] = [];

    // Git commits (classify loop vs operator).
    for (const c of gitLog) {
      const actor = classifyCommitActor(c.message);
      entries.push({
        at: c.at,
        atMs: Date.parse(c.at) || 0,
        kind: "git-commit",
        actor,
        title:
          actor === "loop"
            ? `loop self-enhancement commit ${c.sha}`
            : `${c.author} · ${c.message.split("\n")[0].slice(0, 80)}`,
        details: { sha: c.sha, author: c.author, message: c.message },
      });
    }

    // Mutation corpus (autonomous loop attempts).
    for (const m of mutations as Array<{
      cycleNumber: number; branchNumber: number | null; gateOutcome: string;
      failureType: string | null; originalSha: string; mutatedSha: string | null;
      transformSummary: string | null; lessonIdsInjected: string; createdAt: Date;
    }>) {
      entries.push({
        at: m.createdAt.toISOString(),
        atMs: m.createdAt.getTime(),
        kind: "mutation",
        actor: "loop",
        title: `cycle ${m.cycleNumber} · ${m.gateOutcome}${m.branchNumber ? ` · loop-${m.branchNumber}` : ""}`,
        details: {
          cycle: m.cycleNumber,
          branch: m.branchNumber,
          outcome: m.gateOutcome,
          failureType: m.failureType,
          transform: m.transformSummary?.slice(0, 120) ?? null,
          lessonsInjected: (() => {
            try { return JSON.parse(m.lessonIdsInjected) as string[]; } catch { return []; }
          })(),
        },
      });
    }

    // Postmortems (scars — actor from the source label).
    for (const p of postmortems as Array<{
      targetRepo: string; branch: string; status: string; verificationStatus: string;
      failureType: string; symptom: string; attempts: number; source: string;
      createdAt: Date; updatedAt: Date; resolvedAt: Date | null;
    }>) {
      const actor =
        p.source === "manual" ? "manual"
        : p.source === "auto" ? "auto"
        : p.source === "system" ? "system"
        : "loop";
      entries.push({
        at: p.createdAt.toISOString(),
        atMs: p.createdAt.getTime(),
        kind: "postmortem",
        actor,
        title:
          `${p.failureType} · ${p.status}${p.attempts > 1 ? ` (attempt #${p.attempts})` : ""} · ${p.targetRepo}/${p.branch}`,
        details: {
          repo: p.targetRepo,
          branch: p.branch,
          failureType: p.failureType,
          symptom: p.symptom.slice(0, 160),
          status: p.status,
          verification: p.verificationStatus,
          attempts: p.attempts,
          source: p.source,
          resolvedAt: p.resolvedAt?.toISOString() ?? null,
        },
      });
    }

    // Pipeline runs (gauntlet — actor from triggeredBy).
    for (const r of pipelineRuns as Array<{
      targetRepo: string; targetBranch: string; status: string; astScore: number;
      consensus: string; proofHash: string; triggeredBy: string; createdAt: Date;
    }>) {
      const actor =
        r.triggeredBy === "manual" ? "manual"
        : r.triggeredBy === "auto" ? "auto"
        : r.triggeredBy === "autonomous" ? "loop"
        : "operator";
      entries.push({
        at: r.createdAt.toISOString(),
        atMs: r.createdAt.getTime(),
        kind: "pipeline-run",
        actor,
        title: `${r.triggeredBy} gauntlet · ${r.status} · AST ${r.astScore} · ${r.consensus}`,
        details: {
          repo: r.targetRepo,
          branch: r.targetBranch,
          status: r.status,
          astScore: r.astScore,
          consensus: r.consensus,
          proof: r.proofHash,
        },
      });
    }

    // Lessons (active distilled rules — context, not per-file).
    for (const l of lessons as Array<{
      id: string; content: string; kind: string; sourceType: string; sourceCount: number; createdAt: Date;
    }>) {
      entries.push({
        at: l.createdAt.toISOString(),
        atMs: l.createdAt.getTime(),
        kind: "lesson",
        actor: "loop",
        title: `${l.kind} lesson (${l.sourceType}, ${l.sourceCount} scars) — ${l.content.slice(0, 100)}`,
        details: {
          id: l.id,
          kind: l.kind,
          sourceType: l.sourceType,
          sourceCount: l.sourceCount,
          content: l.content.slice(0, 200),
        },
      });
    }

    // Sort newest-first; cap at 200.
    entries.sort((a, b) => b.atMs - a.atMs);
    const capped = entries.slice(0, 200);

    // ── Summary ──────────────────────────────────────────────────
    const byActor: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    for (const e of entries) {
      byActor[e.actor] = (byActor[e.actor] ?? 0) + 1;
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    }

    return NextResponse.json({
      file: filePath,
      summary: {
        total: entries.length,
        shown: capped.length,
        byActor,
        byKind,
        gitCommits: gitLog.length,
        loopMutations: (mutations as unknown[]).length,
        postmortems: (postmortems as unknown[]).length,
        pipelineRuns: (pipelineRuns as unknown[]).length,
        activeLessons: (lessons as unknown[]).length,
      },
      timeline: capped,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `provenance lookup failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
