/**
 * scripts/push-main.ts — operator utility: push local main to origin/main
 * using the loop's stored push target (sealed PAT in the vault/DB).
 *
 * The loop pushes per-branch (loop-NN) but never advances main. This
 * script closes the gap after operator merges. Uses the same env-injected
 * auth as push-target.ts (token never on the command line).
 */
import { getStoredTarget } from "../src/lib/pipeline/autonomous/push-target";
import { execSync } from "node:child_process";
import { PROJECT_ROOT } from "../src/lib/pipeline/core/paths";

async function main() {
  const target = await getStoredTarget();
  if (!target?.token) {
    console.error("[push-main] No stored push target with token — configure one first (dashboard target config).");
    process.exit(1);
  }
  console.log(`[push-main] pushing main → ${target.repo}`);
  const auth = `Authorization: Basic ${Buffer.from(`x-access-token:${target.token}`).toString("base64")}`;
  const pushEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: auth,
  };
  try {
    const out = execSync("git push origin main", {
      cwd: PROJECT_ROOT,
      timeout: 120_000,
      stdio: "pipe",
      env: pushEnv,
    });
    console.log("[push-main] PUSH OK:", String(out).slice(0, 300));
    process.exit(0);
  } catch (err) {
    let stderr = "";
    if (err instanceof Error) {
      // execSync errors often contain stdout/stderr in the message or as properties if piped
      // We check for stderr property first, then fall back to message.
      const execError = err as { stderr?: string };
      stderr = execError.stderr || err.message;
    }
    
    console.error(`[push-main] PUSH FAILED: git push origin main failed. Check git output for details.`);
    console.error("--- Error Details (First 500 chars) ---");
    console.error(String(stderr).slice(0, 500));
    
    if (err instanceof Error) {
        console.error("--- Full Error Stack ---");
        console.error(err.stack);
    }
    process.exit(1);
  }
}

main();