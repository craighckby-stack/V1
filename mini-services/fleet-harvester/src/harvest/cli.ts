/**
 * harvest/cli.ts — `bun run harvest` entry.
 *
 * Runs one harvest with sensible defaults + env overrides. This is
 * the manual validation gate (step 3) before the autonomous scheduler
 * (step 4) wires it to fire on its own.
 *
 * USAGE (from mini-services/fleet-harvester/):
 *   bun run src/harvest/cli.ts                                  # full fleet (needs GITHUB_TOKEN)
 *   bun run src/harvest/cli.ts --repos=torvalds/linux           # 1-repo smoke test
 *   bun run src/harvest/cli.ts --repos=vercel/next.js,torvalds/linux --no-push  # 2-repo, local only
 *   bun run src/harvest/cli.ts --dry-run                        # no LLM, no push (heuristic only)
 *
 * ENV:
 *   GITHUB_TOKEN   — required for real runs (fleet discovery + V1 push)
 *   V1_DEST_REPO   — optional; "owner/repo" for the V1 archive push
 *   V1_DEST_BRANCH — defaults to "main"
 *   LOOP_MEMORY_DIR — optional; defaults to ../../memory (the consumer dir)
 *   MAX_LLM_COMMITS_PER_HARVEST — defaults to 500
 *
 * The CLI logs to stdout and writes a JSON summary to harvester.log
 * alongside the service log.
 */

import { runHarvest, loopMemoryDirExists, DEFAULT_LOOP_MEMORY_DIR, type HarvestResult } from "./runner";
import type { ExtractionSettings, ArchiveFormat } from "../types/git";
import { resolve } from "node:path";

interface CliArgs {
  repos?: string;
  noPush: boolean;
  dryRun: boolean;
  format: ArchiveFormat;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { noPush: false, dryRun: false, format: "json" };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--repos=")) out.repos = arg.slice("--repos=".length);
    else if (arg === "--no-push") out.noPush = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--format=")) {
      const f = arg.slice("--format=".length) as ArchiveFormat;
      if (f === "json" || f === "markdown" || f === "csv") out.format = f;
    }
  }
  return out;
}

function log(msg: string): void {
  console.log(`[harvest-cli] ${msg}`);
}

async function main() {
  const args = parseArgs(process.argv);

  const githubToken = process.env.GITHUB_TOKEN ?? "";
  const v1DestRepo = process.env.V1_DEST_REPO ?? "";
  const v1DestBranch = process.env.V1_DEST_BRANCH ?? "main";
  // SAFETY: the CLI defaults to a scratch dir (memory/scratch/) UNLESS the
  // operator explicitly points LOOP_MEMORY_DIR at the live consumer dir.
  // A manual smoke run that overwrote the live fleet corpus (2192
  // successful + 4165 failed commits) would silently break the LOOP
  // distiller's history substrate until the next real fleet harvest. The
  // autonomous scheduler (step 4) sets LOOP_MEMORY_DIR explicitly to the
  // live dir only after validating the harvest output.
  const defaultScratchDir = resolve(DEFAULT_LOOP_MEMORY_DIR, "scratch");
  const loopMemoryDir = process.env.LOOP_MEMORY_DIR ?? defaultScratchDir;
  const maxLlm = Number(process.env.MAX_LLM_COMMITS_PER_HARVEST ?? "500");

  if (!githubToken) {
    log("ERROR: GITHUB_TOKEN is not set. Set it in the environment or .env.");
    log("  For a --dry-run (no GitHub access), the runner needs no token but cannot discover or push.");
    process.exit(2);
  }

  // Sensible default extraction settings (mirrors App.tsx's defaults,
  // adapted for headless operation: authorFilter empty = all authors,
  // includeMine off unless sources empty + token present).
  const extraction: ExtractionSettings = {
    authorFilter: "",
    sources: process.env.HARVEST_SOURCES ?? "craighckby-stack",
    extAuthor: "",
    repoFilter: "",
    sinceDate: "",
    untilDate: "",
    branchScope: "default",
    siphonEngines: true,
    includePrivate: true,
    includeForks: false,
    skipOwn: true,
    includeEmails: false,
    includeMine: false,
    ciLookup: !args.dryRun,
    failRx: "\\b(wip|broken|breaks?|failed|failing|rejected|rolled back|rollback|regression|does not work)\\b",
    okRx: "\\b(accepted|passed|improved|verified)\\b",
    aiStrategy: "consensus",
    useGemini: !args.dryRun,
    useGeminiBackup: false,
    useLlm: !args.dryRun,
    nvKey: "",
    nvModel: "",
    nvEndpoint: "",
    nvPrivate: false,
  };

  const destination = {
    targetRepo: v1DestRepo,
    targetBranch: v1DestBranch,
    targetPath: "commit-history",
    fileFormat: args.format,
    autoCreateRepo: false,
  };

  const pushToV1 = !args.noPush && !args.dryRun && v1DestRepo.trim().length > 0;

  log(`Loop memory dir: ${loopMemoryDir} (exists: ${loopMemoryDirExists(loopMemoryDir)})`);
  log(`Push to V1: ${pushToV1 ? v1DestRepo + "@" + v1DestBranch : "(disabled)"}`);
  log(`LLM: ${args.dryRun ? "disabled (--dry-run)" : "z-ai-web-dev-sdk"}`);
  log(`Format: ${args.format}`);
  if (args.repos) {
    const repos = args.repos.split(",").map((s) => s.trim()).filter(Boolean);
    log(`Smoke-test repos: ${repos.length} (${repos.join(", ")})`);
  }

  const result: HarvestResult = await runHarvest({
    githubToken,
    extraction,
    destination,
    loopMemoryDir,
    pushToV1,
    maxLlmCommitsPerHarvest: maxLlm,
    reposOverride: args.repos
      ? { repos: args.repos.split(",").map((s) => s.trim()).filter(Boolean) }
      : undefined,
    onLog: (msg, level) => console.log(`[${level ?? "info"}] ${msg}`),
  });

  log("\n=== HARVEST SUMMARY ===");
  log(JSON.stringify(result, null, 2));

  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[harvest-cli] FATAL: ${msg}`);
  process.exit(1);
});
