import { pushCurrentState } from "@/lib/pipeline/autonomous/push-target";
const r = await pushCurrentState({ branchOverride: "main" });
console.log("push:", r.pushed, r.sha ?? "", r.error ?? "");
process.exit(r.pushed ? 0 : 1);
