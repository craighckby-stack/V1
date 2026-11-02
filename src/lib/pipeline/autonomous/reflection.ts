/**
 * REFLEXION — the verbal self-diagnosis after a failure.
 * (concept: noahshinn/reflexion, NeurIPS 2023 — language agents with
 * verbal reinforcement learning; D7 of the compounding-intelligence set)
 *
 * The postmortem records WHAT failed (failureType, symptom, evidence,
 * constraints). It never asks WHY the LLM's reasoning produced the
 * failure. Reflexion's core result: storing a self-reflection across
 * trials materially outperforms no-reflection and last-attempt-only
 * context. The reflection is the LLM's OWN words about its OWN
 * reasoning — which lands differently from an externally imposed
 * constraint, and generalizes beyond the file that failed.
 *
 * Flow (one cheap call per failure, conditions all local):
 *   - the mutation actually failed at a gate (a postmortem exists)
 *   - the file has failed at least once before (attempts >= 2 — first
 *     failures need the constraint, not the diagnosis)
 *   - the LLM gate is OPEN (never burn mutation quota on reflection
 *     during a 429 window; the next failure retries)
 *
 * The output is stored on the postmortem row (reflection field) and
 * injected with the next attempt's constraint block by
 * postmortem-store.formatPromptBlock. One per file — newest replaces
 * older, keeping the prompt bounded.
 *
 * This module is advisory (body, not brain): its output passes through
 * no gate because it is a PROMPT, and prompts are bounded by every gate
 * that reads them. A bad reflection costs one prompt slot, never a
 * commit.
 */

import { llmComplete, llmCooldownMs } from "../llm/agent-llm";
import { postmortemStore } from "../postmortem/postmortem-store";

export interface ReflectParams {
  filePath: string;
  failureType: string;
  symptom: string;
  constraints: string;
  attempts: number;
}

export interface ReflectResult {
  reflected: boolean;
  reason: string;
}

/**
 * Maybe produce and store a reflection. Call from runCycle right after
 * a FAILED gate verdict, with the postmortem that failure just wrote.
 * Returns { reflected, reason } — never throws.
 */
export async function maybeReflectAfterFailure(params: ReflectParams): Promise<ReflectResult> {
  const { filePath, failureType, symptom, constraints, attempts } = params;
  if (attempts < 2) {
    return { reflected: false, reason: "first failure — constraint first, diagnosis later" };
  }
  if (llmCooldownMs() > 0) {
    return { reflected: false, reason: "llm gate closed — reflection would steal mutation quota" };
  }

  try {
    const system = `You are the reflection stage of a self-improving code system. Your previous attempt at improving a file was rejected by one of the system's verification gates. You are being asked to diagnose YOUR OWN REASONING — not the file, not the gate.

Rules:
- Be specific about the reasoning error you made when proposing the change (overconfidence, wrong assumption about the gate, missed an edge case, "simplification" that wasn't, etc.)
- 2 sentences maximum.
- No hedging, no "I will try better". Name the actual error.
- Write it as first person ("I assumed...", "I dropped...").`;

    const user = `File: ${filePath}
Failure type: ${failureType}
Symptom: ${symptom.slice(0, 300)}
Constraints that were given to you (and apparently ignored or misapplied):
${constraints.slice(0, 400)}

This was attempt #${attempts} for this file. In 2 sentences: what about your reasoning produced this failure?`;

    const res = await llmComplete({ systemPrompt: system, userPrompt: user, temperature: 0.4 });
    if (!res.ok) {
      return { reflected: false, reason: `llm unavailable: ${res.error?.slice(0, 80)}` };
    }

    let text = res.content.trim();
    // Strip a markdown fence if present, then take the first 2 sentences
    // worth of content (cap 400 chars — the store also caps).
    const fence = text.match(/```(?:\w*)\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();
    if (text.length < 20) {
      return { reflected: false, reason: "reflection too short to be useful" };
    }

    const stored = await postmortemStore.storeReflection("self", "main", filePath, text);
    return stored
      ? { reflected: true, reason: "stored" }
      : { reflected: false, reason: "store failed (db)" };
  } catch (e) {
    return { reflected: false, reason: `error: ${(e as Error).message.slice(0, 80)}` };
  }
}
