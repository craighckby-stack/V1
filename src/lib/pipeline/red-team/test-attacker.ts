/**
 * TEST-ATTACKER — the red team for the ratchet.
 * (concepts: BetterForAll/self-improving-agents Level 4 "adversarial
 * arena", Millennium RSI's red-team, vibecode-pro-max-kit's mechanical
 * validators — D5 of the compounding-intelligence set)
 *
 * The ratchet's characterization tests are written by the same LLM that
 * writes the code, so they share its blind spots. BetterForAll's
 * measured result: agents scored 90-100% on their own original tests
 * and 62-66% on an adversarial suite. A second pass that ATTACKS the
 * pins is the only mechanism that surfaces ratchet rot before it costs
 * real cycles.
 *
 * Every ATTACKER_INTERVAL cycles (gate open, never stealing mutation
 * quota), take the newest pinned test files, and ask an adversarial
 * LLM pass to find either:
 *   (a) a DIVERGENCE — an input where the source's behaviour diverges
 *       from what the test asserts, or
 *   (b) a WEAK PIN — a mutation of the source that keeps the test
 *       passing while changing behaviour.
 *
 * A finding is recorded as a postmortem on the TEST file with
 * failureType WEAK_RATCHET and verificationStatus CANDIDATE: it joins
 * the watch list, never shapes a prompt until this system observes the
 * weakness itself. Findings are advisory evidence, not verdicts.
 *
 * This file is in PROTECTED_FILES: it is part of the integrity chain.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname, basename } from "path";
import { llmComplete, llmCooldownMs } from "../llm/agent-llm";
import { postmortemStore } from "../postmortem/postmortem-store";

import { PROJECT_ROOT } from "../core/paths";

/** Cycles between attacker rounds. Deterministic, not tunable — the
 *  tuner tunes the MUTATION loop, not the integrity checks that audit
 *  it (an auditor on the same dial as the audited is not an auditor). */
export const ATTACKER_INTERVAL = 20;
/** Pinned tests examined per round. Bounded: quota discipline. */
const TESTS_PER_ROUND = 3;

/** .test.ts files under the mutable scopes, newest first (mtime). */
function listPinnedTests(): string[] {
  const roots = ["src/lib/pipeline", "src/app/display", "src/components"];
  const out: Array<{ p: string; m: number }> = [];
  // Structural local type — avoids the @types/node Dirent generic variance
  // (Dirent<string> vs Dirent<NonSharedBuffer>) that a ReturnType-based
  // annotation trips over across node typings versions.
  type Entry = { isDirectory: () => boolean; name: string };
  const walk = (dir: string) => {
    let entries: Entry[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Entry[];
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".test.ts")) {
        try {
          out.push({ p, m: statSync(p).mtimeMs });
        } catch {
          /* skip */
        }
      }
    }
  };
  for (const r of roots) walk(join(PROJECT_ROOT, r));
  return out.sort((a, b) => b.m - a.m).map((x) => x.p);
}

/** The source file a test pins: same dir, base name, .ts/.tsx. */
function sourceForTest(testPath: string): string | null {
  const ext = testPath.endsWith(".tsx") ? ".tsx" : ".ts";
  const base = basename(testPath, `.test${ext}`);
  const src = join(dirname(testPath), `${base}${ext}`);
  return existsSync(src) ? src : null;
}

export interface AttackerRound {
  ran: boolean;
  reason: string;
  attacked: number;
  findings: Array<{ testPath: string; kind: string; detail: string }>;
}

/**
 * Run one attacker round. Call post-cycle, fire-and-forget. Refuses to
 * run when the LLM gate is closed (mutation quota always wins) and
 * silently no-ops when there are no pins to attack yet.
 */
export async function runTestAttacker(): Promise<AttackerRound> {
  const out: AttackerRound = { ran: false, reason: "", attacked: 0, findings: [] };
  if (llmCooldownMs() > 0) {
    out.reason = "gate closed — mutations own the quota";
    return out;
  }
  const pinned = listPinnedTests().slice(0, TESTS_PER_ROUND);
  if (pinned.length === 0) {
    out.reason = "no pins to attack yet";
    return out;
  }
  out.ran = true;

  for (const testPath of pinned) {
    const srcPath = sourceForTest(testPath);
    if (!srcPath) continue;
    try {
      const test = readFileSync(testPath, "utf-8");
      const source = readFileSync(srcPath, "utf-8");
      if (test.length > 12000 || source.length > 12000) continue;

      const res = await llmComplete({
        systemPrompt: `You are a red-team test attacker for a self-improving code system. You are given a characterization test file and the source file it pins. Your job is to BREAK THE PIN, not to improve anything. Find exactly one of:
(a) DIVERGENCE — a concrete input (argument values, call sequence) where the source's actual behaviour differs from what the test's assertions imply it is, or
(b) WEAK PIN — a concrete mutation of the SOURCE (describe it precisely) that would keep every test in the file passing while observably changing behaviour.

If the pin is genuinely solid, say so. Output STRICT JSON only, no fence, no prose:
{"found": true|false, "kind": "divergence"|"weak-pin", "detail": "...", "suggestedFix": "..."}`,
        userPrompt: `TEST FILE (${testPath}):\n\`\`\`typescript\n${test}\n\`\`\`\n\nSOURCE FILE (${srcPath}):\n\`\`\`typescript\n${source}\n\`\`\`\n\nAttack the pin.`,
        temperature: 0.3,
      });
      if (!res.ok) {
        out.reason = `llm unavailable mid-round: ${res.error?.slice(0, 60)}`;
        break;
      }
      out.attacked++;

      let raw = res.content.trim();
      const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) raw = fence[1].trim();
      const first = raw.indexOf("{");
      const last = raw.lastIndexOf("}");
      if (first === -1 || last <= first) continue;
      let parsed: { found?: boolean; kind?: string; detail?: string; suggestedFix?: string };
      try {
        parsed = JSON.parse(raw.slice(first, last + 1));
      } catch {
        continue;
      }
      if (!parsed.found || !parsed.detail) continue;
      const kind = parsed.kind === "divergence" ? "divergence" : "weak-pin";
      out.findings.push({
        testPath: testPath.replace(`${PROJECT_ROOT}/`, ""),
        kind,
        detail: parsed.detail.slice(0, 200),
      });

      // Watch-list record: CANDIDATE, on the TEST file. Never injected
      // into a prompt until this system observes the weakness itself —
      // the existing candidate lifecycle handles the rest.
      await postmortemStore.recordFailure({
        repo: "self",
        branch: "main",
        filePath: testPath.replace(`${PROJECT_ROOT}/`, ""),
        failureType: "WEAK_RATCHET",
        symptom: `Red-team attacker (${kind}): ${parsed.detail.slice(0, 120)}`,
        evidence: `Attacker suggested fix: ${(parsed.suggestedFix ?? "none").slice(0, 300)}`,
        constraints: `The ratchet pin on this module has a reported weakness (${kind}). It is a CANDIDATE finding — verify before acting. Do not weaken the pin to make it pass.`,
        verificationStatus: "candidate",
        observed: false, // a probe finding is not an observation of the real file
      });
    } catch {
      /* best-effort per test */
    }
  }
  if (!out.reason) out.reason = out.findings.length > 0 ? `${out.findings.length} finding(s)` : "pins held";
  return out;
}
