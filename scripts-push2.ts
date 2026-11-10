import { pushCurrentState } from "./src/lib/pipeline/autonomous/push-target";
(async () => {
  const r = await pushCurrentState({
    message: "audit 7 fix: self-predictions are never LLM-judged\n\noracle-auto.ts documented that domain=self-prediction prophecies are owned by the deterministic auto-adjudicator, but the skip was never implemented — the 5-min scheduler would have LLM-judged every self-prophecy (quota waste + verdicts conflicting with the deterministic judge). Both evaluator paths now short-circuit self-predictions: due-past-deadline orphans get a deterministic FAILED (no re-attempt within the horizon), not-due ones stay pending for the adjudicator. No LLM, no quota.",
  });
  console.log("pushed:", r.pushed, "| commitSha:", r.commitSha, r.error ? "| error: " + r.error : "");
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
