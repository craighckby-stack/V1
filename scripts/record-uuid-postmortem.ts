/**
 * One-off: record the postmortem for the bare-UUID commit that landed on
 * `main` (commit e5d2b7a, message "dc951e0f-8247-4972-be3f-17ca5c301b75").
 *
 * Investigation (parent session) concluded the commit was created by the
 * host restore orchestrator on machine restart — OUTSIDE LOOP's commit
 * path. This script runs ONCE to write the failure memory so the
 * autonomous loop's RAG surfaces it on future related failures (e.g. an
 * operator looking at commit-archaeology.ts output and wondering why a
 * SHA returned a UUID).
 *
 * Uses the security verification helper pattern to record the system event.
 * See @/lib/security/verification-helper for documentation on this pattern.
 *
 * Idempotent — running it twice INCREMENTS attempts on the same row (the
 * (targetRepo, branch, filePath) tuple is the unique key in
 * postmortem-store). Safe to re-run after a DB wipe; the disk mirror at
 * postmortems/self/main/system:commit-message-guard.json is the source
 * of truth and survives the wipe (postmortem-repo.ts writes it
 * atomically alongside the DB row, same pattern as system:duress.json).
 *
 * Usage: bun run scripts/record-uuid-postmortem.ts
 */

import { postmortemStore } from "@/lib/pipeline/postmortem/postmortem-store";
import { recordSecurityVerificationEvent } from "@/lib/security/verification-helper";

interface UUIDCommitEvidence {
  commitSha: string;
  parentSha: string;
  message: string;
  committedAt: string;
  parentCommittedAt: string;
  gapSeconds: number;
  machineRestartAt: string;
  finding: string;
  blastRadius: string;
  internalCommitterInvariants: string[];
}

async function main() {
  // The investigation's full conclusion — preserved verbatim in the
  // postmortem so a future RAG retrieval surfaces the cause, not just
  // the symptom.
  const finding =
    "The bare-UUID commit e5d2b7a (message dc951e0f-8247-4972-be3f-17ca5c301b75) " +
    "was NOT created by any LOOP-internal committer. git reflog --date=iso shows a " +
    "3-hour gap (01:39:53 to 04:49:57) with no reflog entries — the commit bypassed " +
    "the normal code path. The machine restarted at 04:47:34 (per .zscripts/dev.log); " +
    "the UUID commit landed 2 minutes later at 04:49:57. The commit was created by " +
    "the platform-level restore orchestrator that rehydrated the project directory " +
    "from a snapshot on machine restart, using a bare UUID as a placeholder message. " +
    "This is OUTSIDE LOOP's commit path — LOOP cannot prevent it directly, only " +
    "defend internally (push-target validateCommitMessage guard) + detect on startup " +
    "(self-enhance-loop constructor warn).";

  // What this kind of commit breaks downstream — the cost of NOT
  // defending against it. Preserved so future readers (LLM or human)
  // understand why the guard exists, not just that it does.
  const blastRadius =
    "UUID commits are unsearchable (no message-prefix to grep), break the " +
    "message-prefix convention the rest of the loop relies on (commit-archaeology.ts " +
    "expects 'Self-enhancement:', 'memory:', etc.), and make commit-archaeology.ts " +
    "return a UUID where intent was expected — archaeology on that SHA is a dead-end.";

  // The 5 internal-committer invariants from the investigation. Each
  // LOOP-internal commit site passes an explicit human-readable message
  // — none can produce a bare UUID without a code change. This list is
  // the proof that the UUID commit didn't come from inside LOOP.
  const internalCommitterInvariants = [
    "pushCurrentState fallback path (push-target.ts ~L698): opts?.message ?? 'Self-enhancement: current live state' — never empty, never a UUID",
    "pushCurrentState main path (push-target.ts ~L778): same fallback default — never empty, never a UUID",
    "self-enhance-loop gitPush (self-enhance-loop.ts ~L1535): 'Self-enhancement: ' + relPath + ... — never empty, never a UUID",
    "lessons-markdown export (lessons-markdown.ts ~L147): 'memory: lessons.md export (...)' — never empty, never a UUID",
    "all LOOP commit sites route through pushCurrentState, which now also runs validateCommitMessage as a defense-in-depth check (rejects empty/whitespace-only and bare-UUID first lines before git add -A)",
  ];

  // Record the security verification event using the standardized helper
  await recordSecurityVerificationEvent({
    eventType: "COMMIT_MESSAGE_GUARD_FAILURE",
    repo: "self",
    branch: "main",
    filePath: "system:commit-message-guard",
    observed: false, // system event, not an observation of a real file — matches duress/hot-swap convention
    symptom: "Bare-UUID commit message landed on main (commit e5d2b7a)",
    evidence: {
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
    } as UUIDCommitEvidence,
    constraints:
      "Two-layer defense against host-injected bare-UUID commits. " +
      "(1) Internal guard: push-target.ts validateCommitMessage is called before every `git add -A` " +
      "in pushCurrentState (both the fallback path ~L698 and the main path ~L778) and aborts with " +
      "pushed:false + a clear reason if the message is empty/whitespace-only or matches the bare-UUID " +
      "regex /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i on its first line. " +
      "On the main path the reason is also recorded into lastPushError (matching how the secret-scan " +
      "gate failure is handled) so an operator sees a clear cause in the push-target UI. " +
      "This guarantees LOOP itself never produces a UUID-named commit. " +
      "(2) Startup detector: self-enhance-loop.ts constructor runs validateCommitMessage against " +
      "`git log -1 --format=%B` once at boot and console.warn's if a UUID is detected, " +
      "alerting operators to investigate.",
    remediation:
      "No direct action required — this is a detection-only postmortem. " +
      "The internal guard (1) prevents LOOP from creating UUID commits, " +
      "and the startup detector (2) alerts operators if host-level " +
      "restore ever injects one. The UUID commit e5d2b7a was reverted " +
      "in the parent session; the fix is operational.",
  });
}

main();