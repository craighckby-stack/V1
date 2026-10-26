import { pushCurrentState, getPushTargetPublic } from "@/lib/pipeline/autonomous/push-target";

async function main() {
  const before = await getPushTargetPublic();
  console.log("BEFORE:", JSON.stringify(before));
  const out = await pushCurrentState({ message: "Manual push: current live state" });
  console.log("OUTCOME:", JSON.stringify(out));
  const after = await getPushTargetPublic();
  console.log("AFTER:", JSON.stringify(after));
  process.exit(out.pushed ? 0 : 1);
}
main().catch(e => { console.error("ERR", e.message); process.exit(3); });
