/**
 * One-off: TEST the target-repo pipeline against an external repo with a
 * DRY RUN — full gate chain (scan → LLM → mutation-guard → structural →
 * ast-diff strict → syntax → secret-scan → debate tribunal) but stops
 * BEFORE any branch/commit, so ZERO writes land on the target repo.
 *
 * Usage:  bun run scripts/test-target-dry.ts <owner/repo>
 */
import {
  setTargetConfig,
  clearTargetConfig,
  resolveTargetToken,
} from "@/lib/pipeline/target/target-store";
import { getRepoDefaultBranch } from "@/lib/pipeline/target/target-github";
import { runTargetMutation } from "@/lib/pipeline/target/target-runner";

const DEFAULT_REPO = "craighckby-stack/Wonder-Craig-Game-Demo";
const providedRepo = process.argv[2];
// Input validation: Ensure REPO is not empty/whitespace if provided, otherwise use default.
const REPO = providedRepo ? providedRepo.trim() : DEFAULT_REPO;

function line(s: string) {
  console.log(s);
}

async function main() {
  // Input validation: Check if providedRepo was present but resulted in an empty string after trimming.
  if (providedRepo !== undefined && REPO === DEFAULT_REPO && providedRepo.trim() === "") {
    line(`Error: Repository argument provided is empty or whitespace. Please provide a valid owner/repo string.`);
    process.exitCode = 1;
    return;
  }

  if (REPO === DEFAULT_REPO && !providedRepo) {
    line(`Warning: No repository owner/repo provided. Using default: ${DEFAULT_REPO}`);
  }

  line(`\n================ TARGET DRY-RUN TEST ================`);
  line(`repo: ${REPO}`);
  line(`mode: DRY RUN (zero writes to target repo)`);
  line(`====================================================\n`);

  let configSetSuccessfully = false;

  // STEP 1 — verify reachability using the operator's stored PAT (sealed),
  // which resolveTargetToken reuses server-side. Roll back if not reachable.
  line("[1/3] verifying reachability with stored token...");
  
  try {
    // Fetch token and attempt initial branch fetch in parallel for latency reduction
    const [token, branchWithoutToken] = await Promise.all([
      resolveTargetToken(),
      getRepoDefaultBranch(REPO, null),
    ]);
    
    line(`      token resolved: ${token ? `yes (len ${token.length})` : "no — anonymous"}`);
    
    let finalBranch = branchWithoutToken;
    
    if (!finalBranch && token) {
      // If branch fetch failed without token, try again with token if available
      line("      retrying branch fetch with token...");
      const branchWithToken = await getRepoDefaultBranch(REPO, token);
      finalBranch = branchWithToken;
      line(`      default branch (with token): ${finalBranch ?? "(unreachable)"}`);
    }

    if (!finalBranch) {
      line(`\n[!] REPO NOT REACHABLE — rolling back config. The repo may be`);
      line(`    private and no usable token is stored, or GitHub rate-limited.`);
      await clearTargetConfig();
      process.exitCode = 1;
      return;
    }
    
    // STEP 2: Set config only after successful reachability check.
    line("[2/3] setting target config (validate + persist)...");
    const saved = await setTargetConfig(REPO, finalBranch);
    line(`      persisted repo: ${saved.repo}`);
    line(`      persisted branch: ${saved.branch}`);
    configSetSuccessfully = true;

    // STEP 3 — DRY-RUN the full gated pipeline. No branch, no commit, no push.
    line("[3/3] running DRY-RUN mutation (full gate chain, no write-back)...\n");
    const result = await runTargetMutation({ dryRun: true });

    line(`\n================ RESULT ================`);
    line(`ok:             ${result.ok}`);
    line(`status:         ${result.status}`);
    line(`repo:           ${result.repo ?? "(none)"}`);
    line(`file:           ${result.file ?? "(none)"}`);
    line(`would-branch:   ${result.branch ?? "(none)"}`);
    line(`commitSha:      ${result.commitSha ?? "(none)"}`);
    line(`secretFindings: ${result.secretFindings ?? 0}`);
    line(`debate:         ${JSON.stringify(result.debate) ?? "(none)"}`);
    
    const errorMsg = result.error || result.reason || "(none)";
    line(`error/reason:   ${errorMsg}`);

    if (result.findings && result.findings.length) {
      line(`\nfindings on ${result.file}:`);
      for (const f of result.findings) {
        line(`  - [${f.kind}] line ${f.line}: ${f.evidence}`);
      }
    }

    if (result.gates && result.gates.length) {
      line(`\ngate chain:`);
      for (const g of result.gates) {
        line(`  - ${g.gate}: ${g.status} (${g.durationMs}ms)`);
      }
      if (result.gateErrors && result.gateErrors.length) {
        line(`gate errors (first 5):`);
        for (const e of result.gateErrors) line(`  ! ${e.slice(0, 200)}`);
      }
    }

    line(`\n================ PIPELINE TRACE ================`);
    for (const l of result.log) line(`  ${l}`);

    line(`\n================ DONE ================`);
    line(`Dry-run complete. ZERO writes were made to ${REPO}.`);
    line(`Target config is left SET so a real run is one command away:`);
    line(`  • console: 'target run'   (creates branch loop-t-NN + 1 commit)`);
    line(`  • console: 'target off'    (disconnect the target)`);
    line(`  • API:     POST /api/target/run   (with x-loop-key if LOOP_API_KEY set)`);
    line(`=======================================\n`);
  } catch (error) {
    line(`\n[!] FATAL: An unhandled error occurred during the dry-run test.`);
    const errorMessage = error instanceof Error ? error.message : String(error);
    line(`    Error: ${errorMessage}`);
    
    // Ensure config is cleared if it was successfully set before the error occurred in Step 3
    if (configSetSuccessfully) {
        await clearTargetConfig().catch(e => line(`Warning: Failed to clear target config after error: ${String(e)}`));
    }
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error("\nFATAL: An unhandled error occurred during the dry-run test.");
  console.error(e);
  process.exitCode = 2;
});