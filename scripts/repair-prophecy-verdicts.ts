/**
 * One-time operator repair (2026-11-22): re-adjudicate mislabeled
 * self-prophecies from the pre-fix era.
 *
 * WHAT WENT WRONG: before the same-attempt settlement fix (commit
 * 741e1651, deployed 06:12Z), the in-worker auto-adjudicator refused
 * to settle the in-flight attempt (guard bug: currentCycle <=
 * meta.cycleNumber), and the pre-fix app-side evaluator then failed
 * every one of those prophecies at its 10-minute deadline with
 * "no attempt occurred" — even though the MutationCorpus PROVES the
 * predicted attempt ran (often with gateOutcome="enhanced"). ~220
 * verdicts are mislabeled, poisoning the calibration curve with
 * false failures.
 *
 * THE REPAIR: for every failed self-prediction prophecy whose verdict
 * text starts with "Deterministic deadline", look up the predicted
 * attempt in the MutationCorpus (same semantics as the evaluator's
 * retroactiveSelfProphecyVerdict: sameAttempt match on filePath +
 * cycleNumber first, then the earliest attempt on the file after the
 * prophecy was created). If a corpus row exists, re-judge from its
 * recorded gateOutcome — NO LLM, the corpus IS the ground truth. If
 * no row exists, the failed verdict stands (genuinely no attempt).
 *
 * Usage:
 *   bun run scripts/repair-prophecy-verdicts.ts           # dry run
 *   bun run scripts/repair-prophecy-verdicts.ts --apply   # write
 */

import { db } from "@/lib/db";

interface ProphecyMeta {
  selfProphecy?: boolean;
  sameAttempt?: boolean;
  filePath?: string;
  cycleNumber?: number;
  mode?: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const candidates = await db.prophecy.findMany({
    where: { domain: "self-prediction", status: "failed" },
    orderBy: { createdAt: "asc" },
  });

  const mislabeled = candidates.filter(
    (p) => p.evaluation?.startsWith("Deterministic deadline") === true,
  );
  console.log(
    `Found ${candidates.length} failed self-predictions; ${mislabeled.length} carry deadline-timeout verdicts (the mislabeled class).`,
  );

  let repairedToFulfilled = 0;
  let repairedToFailed = 0;
  let leftAsIs = 0;
  let skippedUnparseable = 0;

  for (const p of mislabeled) {
    let meta: ProphecyMeta = {};
    try {
      meta = p.historySnapshot ? (JSON.parse(p.historySnapshot) as ProphecyMeta) : {};
    } catch (e) {
      skippedUnparseable++;
      console.error(`  Skipped prophecy ID ${p.id}: Failed to parse historySnapshot. Error: ${(e as Error).message}`);
      continue;
    }
    if (typeof meta.filePath !== "string" || meta.filePath.length === 0) {
      skippedUnparseable++;
      console.error(`  Skipped prophecy ID ${p.id}: Missing or invalid filePath in snapshot.`);
      continue;
    }

    // Same lookup semantics as the evaluator's retroactive check.
    let attempt: { cycleNumber: number; gateOutcome: string } | null = null;
    try {
      if (meta.sameAttempt === true && typeof meta.cycleNumber === "number") {
        // Performance improvement: run both lookups in parallel for sameAttempt semantics
        const sameAttemptPromise = db.mutationCorpus.findFirst({
          where: { filePath: meta.filePath, cycleNumber: meta.cycleNumber },
          orderBy: { createdAt: "desc" },
          select: { cycleNumber: true, gateOutcome: true },
        });

        const generalAttemptPromise = db.mutationCorpus.findFirst({
          where: { filePath: meta.filePath, createdAt: { gte: p.createdAt } },
          orderBy: { createdAt: "asc" },
          select: { cycleNumber: true, gateOutcome: true },
        });

        const [sameAttemptResult, generalAttemptResult] = await Promise.all([
          sameAttemptPromise,
          generalAttemptPromise,
        ]);

        attempt = sameAttemptResult || generalAttemptResult;
      } else {
        // If sameAttempt is false or cycleNumber is missing/invalid, fall back to general search
        attempt = await db.mutationCorpus.findFirst({
          where: { filePath: meta.filePath, createdAt: { gte: p.createdAt } },
          orderBy: { createdAt: "asc" },
          select: { cycleNumber: true, gateOutcome: true },
        });
      }
    } catch (e) {
      console.error(`  DB error looking up corpus for prophecy ID ${p.id} (File: ${meta.filePath}): ${(e as Error).message}`);
      leftAsIs++;
      continue;
    }

    if (!attempt) {
      // No attempt on record — the original deadline-failure was honest.
      leftAsIs++;
      continue;
    }

    const verdict: "fulfilled" | "failed" =
      attempt.gateOutcome === "enhanced" ? "fulfilled" : "failed";
    const modeDisplay = meta.mode ?? "refactor"; // Handle missing mode safely
    
    // Input validation for confidence before using it in string formatting
    const confidenceValue = typeof p.confidence === 'number' ? p.confidence.toFixed(2) : 'N/A';

    const evaluation =
      `Retroactive repair (operator, 2026-11-22): the pre-fix evaluator failed this ` +
      `prophecy at its deadline claiming "no attempt occurred", but the MutationCorpus ` +
      `proves the predicted ${modeDisplay} attempt on ${meta.filePath} at ` +
      `cycle ${attempt.cycleNumber} DID run — recorded gateOutcome="${attempt.gateOutcome}". ` +
      `Re-adjudicated deterministically from the corpus (no LLM): the claim "will pass all ` +
      `gates and be enhanced" is ${verdict === "fulfilled" ? "FULFILLED" : "FAILED"} by that ` +
      `attempt's recorded outcome. (Confidence when made: ${confidenceValue}.)`;

    if (apply) {
      await db.prophecy.update({
        where: { id: p.id },
        data: { status: verdict, evaluation, evaluatedAt: new Date() },
      });
    }
    if (verdict === "fulfilled") repairedToFulfilled++;
    else repairedToFailed++;
  }

  console.log(
    `\n${apply ? "APPLIED" : "DRY RUN"}: ${repairedToFulfilled} → fulfilled, ` +
      `${repairedToFailed} → failed (attempt ran but didn't pass), ` +
      `${leftAsIs} left as-is (no attempt on record — honest deadline-failures), ` +
      `${skippedUnparseable} skipped (unparseable/missing snapshot metadata).`,
  );
  if (!apply) console.log("Run with --apply to write these repairs.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("REPAIR FAILED:", e);
    process.exit(1);
  });