// One-shot operator push of main via the loop's own sealed-vault push.
// DELETED after use — never committed.
import { pushCurrentState } from "@/lib/pipeline/autonomous/push-target";
const r = await pushCurrentState({ branchOverride: "main" });
console.log("push result:", JSON.stringify({ pushed: r.pushed, repo: r.repo, sha: r.sha, error: r.error ?? null }));
process.exit(r.pushed ? 0 : 1);
