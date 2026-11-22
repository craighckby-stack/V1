/**
 * Operator utility — seal a fresh GitHub PAT into the push-target vault
 * WITHOUT the token ever touching a tracked file, argv, or a log.
 *
 * Usage:
 *   LOOP_PUSH_TOKEN=ghp_... LOOP_PUSH_REPO=owner/name bun run scripts/seal-push-token.ts
 *
 * The token is read from the environment, verified against GitHub /user,
 * and stored via setPushTarget (AES-256-GCM sealed in .git/info/ + DB tiers).
 * It is never echoed — only the public outcome is printed.
 */
import { setPushTarget, getPushTargetPublic } from "@/lib/pipeline/autonomous/push-target";

async function main() {
  const token = process.env.LOOP_PUSH_TOKEN?.trim();
  const repo = (process.env.LOOP_PUSH_REPO ?? "craighckby-stack/V1").trim();
  if (!token) {
    console.error("LOOP_PUSH_TOKEN env var is required (never pass the token as argv)");
    process.exit(2);
  }
  const before = await getPushTargetPublic();
  console.log("BEFORE:", JSON.stringify(before));
  const result = await setPushTarget({ repo, token, createIfMissing: false });
  console.log("SEALED:", JSON.stringify(result)); // { repo, login, created } — no token
  const after = await getPushTargetPublic();
  console.log("AFTER:", JSON.stringify(after));
  process.exit(0);
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : String(e));
  process.exit(3);
});
