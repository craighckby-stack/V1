/**
 * Target Runner — ONE gated mutation attempt against an EXTERNAL repo.
 *
 * This is the Direction 3 graft (DIRECTIONS.md): the ORIGINAL external-
 * repo pipeline made ~7,000 ungated garbage commits; the self-enhance
 * era built the gate gauntlet but had no destination. Target mode is the
 * synthesis — foreign repo as destination, SELF-grade gates as the law:
 *
 *   scan (GitHub tree + static analysis)  → same detectors as self-scan
 *   generate (LLM, one focused improvement) → same prompt discipline
 *   gate: mutation-guard → structural → ast-diff(strict) → syntax
 *         → secret-scan (unified diff + commit message) → debate tribunal
 *   land: refs/heads/loop-t-NN created from the base ref, Contents-PUT
 *         commit — NEVER a local disk write, NEVER the live tree
 *   fail: postmortem recorded under (repo, branch, filePath) — the same
 *         store the self-loop uses, repo-scoped so constraints never
 *         leak between self and target mode
 *
 * HONEST GAPS (documented, not hidden): typecheck and the sandbox test
 * gate are SKIPPED for external targets — they need the target's full
 * dependency tree, which API-only mode does not have. The gate list is
 * reported per-run so no output ever implies a full-gate pass. The
 * upgrade path is the workspace-clone model (Level 2).
 *
 * Operator-triggered only (command or API route) in Level 1 — the
 * autonomous loop integration is deliberately NOT wired yet.
 */

import {
  getTargetConfig,
  getTargetLastRun,
  resolveTargetToken,
  recordTargetRun,
  type TargetRunStatus,
} from "./target-store";
import {
  getRepoDefaultBranch,
  listTargetTree,
  fetchTargetFile,
  ensureTargetBranch,
  commitTargetFile,
  listTargetBranches,
  nextTargetBranchNumber,
  unifiedDiff,
} from "./target-github";
import {
  scanTargetContent,
  isMutableTargetPath,
  pickTargetFinding,
  TARGET_KIND_PRIORITY,
  MAX_TARGET_FILE_BYTES,
  type TargetFinding,
} from "./target-scan";
import { runGateChain, type GatePolicy, type GateStepOutcome } from "../core/gate-runner";
import { scanDiff, scanCommitMessage } from "../core/secret-scan";
import { conductLlmDebate } from "../llm/debate-llm";
import { llmComplete, extractCodeBlock } from "../llm/agent-llm";
import { detectTruncation } from "../autonomous/code-analysis";
import { isSafeMode } from "../core/duress";
import { postmortemStore, type PostmortemFailureType } from "../postmortem/postmortem-store";
import { sha16 } from "../core/hash";

/**
 * Target-mode gate policy: everything deterministic EXCEPT typecheck
 * (needs the foreign dependency tree), strict AST tolerance (the
 * "preserve every exported symbol" contract applies to foreign code
 * exactly as it does to ours), and every gate's outcome recorded
 * (fail-fast would hide later verdicts from the operator).
 */
export const TARGET_PATH_POLICY: GatePolicy = {
  guard: true,
  structural: true,
  ast: true,
  astTolerance: "strict",
  syntax: true,
  typecheck: false,
  stopOnFirstFailure: false,
};

/** How many files to probe (fetch + scan) for findings per run. */
const MAX_PROBES = 6;

export interface TargetRunResult {
  /** false = config/infrastructure failure (not a gate rejection). */
  ok: boolean;
  status: TargetRunStatus;
  repo?: string;
  file?: string;
  findings?: TargetFinding[];
  branch?: string;
  commitSha?: string;
  dryRun?: boolean;
  gates?: GateStepOutcome[];
  gateErrors?: string[];
  debate?: { consensus: string; coefficient: number };
  secretFindings?: number;
  error?: string;
  /** Short honest outcome reason for the audit trail / status line. */
  reason?: string;
  /** Human-readable trace — the console command prints these verbatim. */
  log: string[];
}

function kindSummary(findings: TargetFinding[], max = 3): string {
  const kinds = [...new Set(findings.map((f) => f.kind))].sort(
    (a, b) => TARGET_KIND_PRIORITY[a] - TARGET_KIND_PRIORITY[b]
  );
  const head = kinds.slice(0, max).join("+");
  return kinds.length > max ? `${head}+${kinds.length - max}more` : head;
}

/** Map a gate failure to the postmortem taxonomy the self-loop uses. */
function mapFailureType(
  failedGate: string | null,
  gateErrors: string[],
  secretCount: number,
  debateRejected: boolean
): PostmortemFailureType {
  if (secretCount > 0) return "OTHER"; // symptom carries the specifics
  if (debateRejected) return "REVIEW_REJECTED";
  if (failedGate === "ast-diff") {
    if (gateErrors.some((e) => e.includes("AST_SYMBOL_DROPPED"))) return "AST_SYMBOL_DROPPED";
    if (gateErrors.some((e) => e.includes("BRANDING_INJECTION"))) return "BRANDING_INJECTION";
    return "AST_STRUCTURAL_DRIFT";
  }
  if (failedGate === "syntax") return "COMPILE_ERROR";
  return "OTHER";
}

/**
 * Run ONE target-mode mutation attempt. Throws only on truly unexpected
 * internal errors — every foreseeable outcome (no config, safe mode,
 * no findings, gate rejection, push failure) is a structured result.
 */
export async function runTargetMutation(opts?: {
  dryRun?: boolean;
  /** Commit the survivor directly to the base ref (main) instead of an
   *  isolated loop-t-NN branch. Opt-in — the default stays the safe,
   *  reviewable, reversible isolated branch. Main may be protected →
 *  GitHub returns 403 and the error is surfaced honestly. */
  landOnMain?: boolean;
  clientToken?: string;
}): Promise<TargetRunResult> {
  const log: string[] = [];
  const say = (line: string) => {
    log.push(line);
    console.log(`[target] ${line}`);
  };
  const dryRun = opts?.dryRun === true;

  // 1. Config
  const cfg = await getTargetConfig();
  if (!cfg) {
    return {
      ok: false,
      status: "failed",
      error: "No target repository configured — set one first ('target owner/repo').",
      log,
    };
  }
  const { repo } = cfg;
  say(`target: ${repo}`);

  // 2. Safe mode (duress) — target runs obey the same halt flag.
  if (isSafeMode()) {
    return {
      ok: false,
      status: "failed",
      repo,
      error: "Safe mode is active — target runs are halted until the operator clears it.",
      log,
    };
  }

  // 3. Credential
  const token = await resolveTargetToken(opts?.clientToken);
  say(token ? "credential: stored/client token (server-side only)" : "credential: anonymous (public repo limits)");

  // 4. Base ref
  const baseRef = cfg.branch || (await getRepoDefaultBranch(repo, token));
  if (!baseRef) {
    await recordTargetRun({ at: new Date().toISOString(), repo, status: "failed", reason: "repo not reachable or not found" });
    return {
      ok: false,
      status: "failed",
      repo,
      error: `Could not resolve a base branch for ${repo} — check the repo name and access.`,
      log,
    };
  }
  say(`base ref: ${baseRef}`);

  // 5. Tree → candidates
  const treeRes = await listTargetTree(repo, baseRef, token);
  if (!treeRes.ok) {
    await recordTargetRun({ at: new Date().toISOString(), repo, status: "failed", reason: treeRes.error });
    return { ok: false, status: "failed", repo, error: treeRes.error, log };
  }
  const candidates = treeRes.tree.files.filter(
    (f) => f.size <= MAX_TARGET_FILE_BYTES && isMutableTargetPath(f.path)
  );
  say(`candidates: ${candidates.length} mutable files (tree ${treeRes.tree.truncated ? "TRUNCATED" : "complete"})`);
  if (candidates.length === 0) {
    await recordTargetRun({ at: new Date().toISOString(), repo, status: "no-work", reason: "no mutable files in scope" });
    return { ok: true, status: "no-work", repo, error: undefined, log };
  }

  // 6. Rotate past the last attempted file so successive runs spread work.
  const lastRun = await getTargetLastRun();
  if (lastRun?.file) {
    const idx = candidates.findIndex((f) => f.path === lastRun.file);
    if (idx >= 0) {
      const rotated = candidates.slice(idx + 1).concat(candidates.slice(0, idx + 1));
      candidates.length = 0;
      candidates.push(...rotated);
    }
  }

  // 7. Probe for findings (fetch + static scan, up to MAX_PROBES files).
  const probes: Array<{ path: string; content: string; blobSha: string; findings: TargetFinding[] }> = [];
  for (const cand of candidates.slice(0, MAX_PROBES)) {
    const res = await fetchTargetFile(repo, cand.path, baseRef, token);
    if (!res.ok) {
      say(`probe ${cand.path}: skipped (${res.error})`);
      continue;
    }
    const findings = scanTargetContent(cand.path, res.file.content);
    if (findings.length > 0) {
      say(`probe ${cand.path}: ${findings.length} finding(s) — chosen`);
      probes.push({ path: cand.path, content: res.file.content, blobSha: res.file.blobSha, findings });
      break;
    }
    say(`probe ${cand.path}: clean`);
  }
  const pick = pickTargetFinding(probes.map((p) => ({ file: p.path, findings: p.findings })));
  if (!pick) {
    await recordTargetRun({ at: new Date().toISOString(), repo, status: "no-work", reason: `first ${probes.length || 0} probed file(s) clean` });
    return { ok: true, status: "no-work", repo, log };
  }
  const chosen = probes.find((p) => p.path === pick.file)!;
  const file = chosen.path;
  const originalCode = chosen.content;
  say(`file: ${file} — ${kindSummary(chosen.findings)}`);

  // 8. Constraints from past failures (repo-scoped postmortems).
  let constraintsBlock = "(none)";
  try {
    const c = await postmortemStore.getConstraintsForFile(repo, baseRef, file);
    if (c.promptBlock && c.promptBlock.trim()) constraintsBlock = c.promptBlock;
  } catch {
    /* constraints are advisory — never block the run */
  }

  // 9. Generate the proposal.
  const systemPrompt = `You are a careful senior engineer improving ONE file of an external repository. The file has static-analysis findings. Make ONE focused improvement that addresses the highest-priority finding(s), keeping everything else byte-identical.

Rules:
- Output ONLY the complete new file content in a single fenced code block
- Preserve EVERY existing export (function, class, interface, type, const) — no renames, no removals
- Keep all unrelated code, comments, and formatting byte-identical
- No header comments, banners, or branding
- Do not weaken validation, error handling, or existing behavior
- If a fix is not clearly possible, return the file unchanged rather than guessing`;

  const findingLines = [...chosen.findings]
    .sort((a, b) => TARGET_KIND_PRIORITY[a.kind] - TARGET_KIND_PRIORITY[b.kind])
    .slice(0, 8)
    .map((f) => `- [${f.kind}] line ${f.line}: ${f.evidence}`)
    .join("\n");

  const userPrompt = `REPO: ${repo} (branch ${baseRef})
FILE: ${file}

FINDINGS (priority order):
${findingLines}

CONSTRAINTS FROM PAST FAILURES:
${constraintsBlock}

CURRENT CONTENT:
\`\`\`
${originalCode}
\`\`\`

Output the COMPLETE new content for this file with the improvement applied.`;

  say("generating proposal (LLM)...");
  const llm = await llmComplete({ systemPrompt, userPrompt, temperature: 0.2 });
  if (!llm.ok) {
    await recordTargetRun({ at: new Date().toISOString(), repo, status: "failed", file, reason: `LLM unavailable: ${llm.error ?? "unknown"}` });
    return { ok: false, status: "failed", repo, file, error: `LLM unavailable: ${llm.error ?? "unknown"}`, log };
  }
  const newCode = extractCodeBlock(llm.content);
  if (!newCode || newCode.trim().length === 0) {
    await recordTargetRun({ at: new Date().toISOString(), repo, status: "failed", file, reason: "LLM returned no code" });
    return { ok: false, status: "failed", repo, file, error: "LLM returned no code", log };
  }

  // 10. Truncation + zero-diff short-circuit.
  const truncation = detectTruncation(newCode, originalCode, file);
  if (truncation.truncated) {
    const reason = `LLM output truncated: ${truncation.reason ?? "unknown"}`;
    await recordTargetRun({ at: new Date().toISOString(), repo, status: "rejected", file, reason });
    return { ok: true, status: "rejected", repo, file, error: reason, log };
  }
  if (sha16(newCode) === sha16(originalCode)) {
    await recordTargetRun({ at: new Date().toISOString(), repo, status: "no-work", file, reason: "zero diff" });
    return { ok: true, status: "no-work", repo, file, reason: undefined, log: [...log, "proposal: zero diff — nothing to gate"] };
  }
  say(`proposal: ${Math.abs(newCode.length - originalCode.length)}b delta`);

  // 11. Deterministic gate chain (TARGET_PATH_POLICY — typecheck honestly skipped).
  const gateResult = await runGateChain({
    filePath: file,
    originalCode,
    evolvedCode: newCode,
    policy: TARGET_PATH_POLICY,
  });
  for (const step of gateResult.steps) {
    say(`gate ${step.gate}: ${step.status} (${step.durationMs}ms)`);
  }
  for (const e of gateResult.errors.slice(0, 3)) say(`gate error: ${e.slice(0, 180)}`);

  // 12. Secret scan — on the built unified diff AND the commit message.
  // The commit message is built once (landOnMain known from opts) and
  // reused at the land step so the scanned message is byte-identical to
  // the one that actually lands on GitHub.
  const landOnMain = opts?.landOnMain === true;
  const commitMessage = buildCommitMessage(repo, baseRef, file, chosen.findings, landOnMain);
  const diffText = unifiedDiff(file, originalCode, newCode);
  const secretFindings = [...scanDiff(diffText, file), ...scanCommitMessage(commitMessage)];
  say(`secret-scan: ${secretFindings.length} finding(s)`);
  for (const f of secretFindings.slice(0, 3)) say(`secret: ${f.patternName} (${f.severity}, ${f.redactedPreview})`);

  // 13. Debate tribunal (fail closed — same contract as the self loop).
  say("debate tribunal: convening (Security / Architecture / Lead)...");
  let debatePass = false;
  let debateSummary: { consensus: string; coefficient: number } | undefined;
  try {
    const verdict = await conductLlmDebate(
      `External-target enhancement of ${file} in ${repo} (${kindSummary(chosen.findings)})`,
      newCode,
      file
    );
    debateSummary = { consensus: verdict.verdict.consensus, coefficient: verdict.verdict.consensusCoefficient };
    debatePass =
      verdict.verdict.consensus === "APPROVED" || verdict.verdict.consensus === "CONDITIONAL_APPROVAL";
    say(`debate verdict: ${verdict.verdict.consensus} (coefficient ${verdict.verdict.consensusCoefficient})`);
  } catch (err) {
    say(`debate unavailable: ${(err as Error).message.slice(0, 120)} — fail closed`);
  }

  // 14. Aggregate verdict.
  const passed = gateResult.ok && secretFindings.length === 0 && debatePass;
  if (!passed) {
    const reason = !gateResult.ok
      ? `gate ${gateResult.failedGate ?? "chain"} failed`
      : secretFindings.length > 0
        ? "secret-scan rejected the diff"
        : "debate tribunal withheld approval";
    say(`RESULT: REJECTED — ${reason}`);
    // Postmortem under the TARGET repo's namespace (repo-scoped store).
    try {
      await postmortemStore.recordFailure({
        repo,
        branch: baseRef,
        filePath: file,
        failureType: mapFailureType(gateResult.failedGate, gateResult.errors, secretFindings.length, !debatePass),
        symptom: reason,
        evidence: [...gateResult.errors, ...secretFindings.map((s) => `${s.patternName} ${s.redactedPreview}`)]
          .join(" | ")
          .slice(0, 500),
        constraints:
          "target-mode: preserve every exported symbol; no destructive restructuring; no secrets in diffs; the tribunal requires a real improvement, not a cosmetic no-op.",
        observed: true,
      });
    } catch (err) {
      say(`postmortem write failed (non-fatal): ${(err as Error).message.slice(0, 120)}`);
    }
    await recordTargetRun({ at: new Date().toISOString(), repo, status: "rejected", file, reason });
    return {
      ok: true,
      status: "rejected",
      repo,
      file,
      findings: chosen.findings,
      gates: gateResult.steps,
      gateErrors: gateResult.errors.slice(0, 5),
      debate: debateSummary,
      secretFindings: secretFindings.length,
      error: reason,
      log,
    };
  }

  // 15. Decide the landing branch. landOnMain commits directly to the
  //     base ref (main) — no loop-t-NN. The default stays the isolated
  //     branch (reviewable, reversible, never touches main).
  let branchName: string;
  if (landOnMain) {
    branchName = baseRef;
    say(`land mode: committing directly to ${baseRef} (operator --main)`);
  } else {
    const branchNumber = nextTargetBranchNumber(await listTargetBranches(repo, token));
    branchName = `loop-t-${branchNumber}`;
  }
  if (dryRun) {
    say(`RESULT: DRY RUN PASS — would commit ${file} to ${branchName}${landOnMain ? " (main)" : ""}`);
    await recordTargetRun({ at: new Date().toISOString(), repo, status: "dry-run", file, branch: branchName });
    return {
      ok: true,
      status: "dry-run",
      repo,
      file,
      findings: chosen.findings,
      branch: branchName,
      dryRun: true,
      gates: gateResult.steps,
      debate: debateSummary,
      secretFindings: secretFindings.length,
      log,
    };
  }

  // 16. Land. Isolated-branch mode creates the branch first; land-on-main
  //     commits straight to baseRef (main may be protected → honest 403).
  if (!landOnMain) {
    say(`creating branch ${branchName} from ${baseRef}...`);
    const ensured = await ensureTargetBranch(repo, branchName, baseRef, token);
    if (!ensured.ok) {
      await recordTargetRun({ at: new Date().toISOString(), repo, status: "failed", file, branch: branchName, reason: ensured.error });
      return { ok: false, status: "failed", repo, file, branch: branchName, error: ensured.error, log };
    }
  }
  const commit = await commitTargetFile({
    repo,
    path: file,
    branch: branchName,
    content: newCode,
    message: commitMessage,
    token,
  });
  if (!commit.ok) {
    await recordTargetRun({ at: new Date().toISOString(), repo, status: "failed", file, branch: branchName, reason: commit.error });
    return { ok: false, status: "failed", repo, file, branch: branchName, error: commit.error, log };
  }
  say(`committed ${file} → ${branchName} (${commit.commitSha?.slice(0, 10) ?? "?"})`);
  say(`RESULT: PUSHED — https://github.com/${repo}/tree/${branchName}`);
  await recordTargetRun({
    at: new Date().toISOString(),
    repo,
    status: "pushed",
    file,
    branch: branchName,
    commitSha: commit.commitSha,
  });
  return {
    ok: true,
    status: "pushed",
    repo,
    file,
    findings: chosen.findings,
    branch: branchName,
    commitSha: commit.commitSha,
    gates: gateResult.steps,
    debate: debateSummary,
    secretFindings: secretFindings.length,
    log,
  };
}

/** First line ≤72 chars; body documents the gate reality honestly,
 *  including WHERE the mutation landed (main vs isolated branch). */
function buildCommitMessage(
  repo: string,
  baseRef: string,
  file: string,
  findings: TargetFinding[],
  landOnMain: boolean
): string {
  const landing = landOnMain
    ? `Landed directly on ${baseRef} (operator --main mode).`
    : `Landed on an isolated loop-t-NN branch (reviewable, reversible).`;
  return [
    `target-enhance: ${file} (${kindSummary(findings)})`.slice(0, 72),
    "",
    "One gated improvement derived from static analysis.",
    "Gates passed: mutation-guard, structural, ast-diff(strict), syntax,",
    "secret-scan, debate tribunal.",
    "Skipped honestly: typecheck + sandbox tests (external target has no",
    "local dependency tree — workspace-clone mode is the Level 2 upgrade).",
    landing,
    `Source: ${repo}@${baseRef}`,
  ].join("\n");
}
