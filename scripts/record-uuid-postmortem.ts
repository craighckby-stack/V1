import { postmortemStore } from "@/lib/pipeline/postmortem/postmortem-store";

async function main() {
  const finding = `The bare-UUID commit e5d2b7a (message dc951e0f-8247-4972-be3f-17ca5c301b75) was NOT created by any LOOP-internal committer. git reflog --date=iso shows a 3-hour gap (01:39:53 to 04:49:57) with no reflog entries — the commit bypassed the normal code path. The machine restarted at 04:47:34 (per .zscripts/dev.log); the UUID commit landed 2 minutes later at 04:49:57. The commit was created by the platform-level restore orchestrator that rehydrated the project directory from a snapshot on machine restart, using a bare UUID as a placeholder message. This is OUTSIDE LOOP's commit path — LOOP cannot prevent it directly, only defend internally (push-target validateCommitMessage guard) + detect on startup (self-enhance-loop constructor warn).`;

  const blastRadius = `UUID commits are unsearchable (no message-prefix to grep), break the message-prefix convention the rest of the loop relies on (commit-archaeology.ts expects 'Self-enhancement:', 'memory:', etc.), and make commit-archaeology.ts return a UUID where intent was expected — archaeology on that SHA is a dead-end.`;

  const internalCommitterInvariants = [
    "pushCurrentState fallback path (push-target.ts ~L698): opts?.message ?? 'Self-enhancement: current live state' — never empty, never a UUID",
    "pushCurrentState main path (push-target.ts ~L778): same fallback default — never empty, never a UUID",
    "self-enhance-loop gitPush (self-enhance-loop.ts ~L1535): 'Self-enhancement: ' + relPath + ... — never empty, never a UUID",
    "lessons-markdown export (lessons-markdown.ts ~L147): 'memory: lessons.md export (...)' — never empty, never a UUID",
    "all LOOP commit sites route through pushCurrentState, which now also runs validateCommitMessage as a defense-in-depth check (rejects empty/whitespace-only and bare-UUID first lines before git add -A)",
  ];

  const evidence = {
    commitSha: "e5d2b7a",
    parentSha: "3332392",
    message: "dc951e0f-8247-4972-be3f-17ca5c301b75",
    committedAt: "2026-11-04T04:49:57Z",
    parentCommittedAt: "2026-11-04T01:39:53Z",
    gapSeconds: 10804,
    machineRestartAt: "2026-11-04T04:47:34Z",
    finding,
    blastRadius,
    internalCommitterInvariants,
  };

  // Validate evidence object before stringifying
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error("Invalid evidence object: must be a non-array object");
  }

  const requiredEvidenceFields = [
    'commitSha', 'parentSha', 'message', 'committedAt', 
    'parentCommittedAt', 'gapSeconds', 'machineRestartAt', 
    'finding', 'blastRadius', 'internalCommitterInvariants'
  ];
  
  for (const field of requiredEvidenceFields) {
    if (!(field in evidence)) {
      throw new Error(`Missing required evidence field: ${field}`);
    }
  }

  const record = await postmortemStore.recordFailure({
    repo: "self",
    branch: "main",
    filePath: "system:commit-message-guard",
    observed: false,
    failureType: "OTHER",
    symptom: "Bare-UUID commit message landed on main (commit e5d2b7a)",
    evidence: JSON.stringify(evidence),
    constraints: `Two-layer defense against host-injected bare-UUID commits. (1) Internal guard: push-target.ts validateCommitMessage is called before every \`git add -A\` in pushCurrentState (both the fallback path ~L698 and the main path ~L778) and aborts with pushed:false + a clear reason if the message is empty/whitespace-only or matches the bare-UUID regex /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i on its first line. On the main path the reason is also recorded into lastPushError (matching how the secret-scan gate failure is handled) so an operator sees a clear cause in the push-target UI. This guarantees LOOP itself never produces a UUID-named commit. (2) Startup detector: self-enhance-loop.ts constructor runs validateCommitMessage against \`git log -1 --format=%B\` once at boot and console.warn's (does NOT block boot — the commit is already on disk by the time LOOP runs; blocking would brick the loop on a restore) if HEAD's message is empty or a bare UUID. The host restore orchestrator that injected commit e5d2b7a is OUTSIDE LOOP's reach: it runs before LOOP boots (machine restart at 04:47:34), so LOOP cannot prevent it directly — only defend (layer 1) + detect (layer 2). Operationally related to external audit finding 1 (test-gate crash recovery in push-target.ts): both findings are about commits landing on main through paths LOOP doesn't control (a crashed test gate leaving an unverified candidate live; a host restore orchestrator using a UUID placeholder), and both are addressed by running a check BEFORE git add -A so the bad commit never lands in the first place.`,
  });

  if (!record) {
    throw new Error("Failed to create postmortem record");
  }

  console.log("POSTMORTEM RECORDED");
  console.log("  id        :", record.id);
  console.log("  filePath  :", record.filePath);
  console.log("  repo      :", record.targetRepo);
  console.log("  branch    :", record.branch);
  console.log("  attempts  :", record.attempts);
  console.log("  status    :", record.status);
  console.log("  verified? :", record.verificationStatus);
  console.log("  hash      :", record.hash);
  console.log("  disk mirror: postmortems/self/main/system:commit-message-guard.json");
}

main().catch((err) => {
  const errorMessage = err instanceof Error ? err.message : String(err);
  console.error(`ERROR: Failed to record postmortem for 'system:commit-message-guard'. 
    Check postmortemStore connection, permissions, or required dependencies. 
    Underlying error: ${errorMessage}`);
  process.exit(1);
});