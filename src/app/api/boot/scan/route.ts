import { NextResponse } from "next/server";
import { readdir, stat } from "fs/promises";
import { join } from "path";
import { getStoredTarget } from "@/lib/pipeline/autonomous/push-target";
import { vaultStatus } from "@/lib/pipeline/crypto/token-vault";
import {
  getSwapCount,
  getHotSwapSuccessCount,
} from "@/lib/pipeline/core/hot-swap";
import {
  warmZaiCortex,
  zaiCortexStatus,
  llmGateInfo,
} from "@/lib/pipeline/llm/agent-llm";
import { autonomousLoopRuntime } from "@/lib/pipeline/autonomous/loop-runtime";
import { getPassRateTrend } from "@/lib/pipeline/autonomous/mutation-corpus";
import { db } from "@/lib/db";
import { PROJECT_ROOT } from "@/lib/pipeline/core/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/boot/scan — the extra vitals for the boot splash's POST lines.
 *
 * Called by boot-splash.tsx on every COLD boot, in parallel with the
 * existing five vital endpoints (which are untouched — this is additive).
 * One round trip returns everything the new POST lines need:
 *
 *   GITHUB AUTH     — auto-connect check: the server opens the SEALED PAT
 *                     from the vault (zero operator input) and asks GitHub
 *                     GET /user who it authenticates as. Budget 3.5s so it
 *                     fits inside the splash's 4s fetch window.
 *   TOKEN VAULT     — is the key present / what cipher rests on disk.
 *   MUTATION CORPUS — attempts / failed / enhanced from the DB table.
 *   SCARS           — postmortem JSON files on DISK — the wipe-proof
 *                     failure record. (The DB layer can be rolled back by
 *                     the sandbox; the postmortems/ tree survives, same as
 *                     .git/. A scar on disk is a failure that really
 *                     happened, regardless of what the DB currently says.)
 *   HOT-SWAP        — lifetime (persistent SystemFlag counter) + this boot.
 *   AUTONOMY        — the live loop's status word.
 *   Z.AI CORTEX     — the auto-injected provider connection: SDK
 *                     handshake + one-shot ping, warmed at SERVER BOOT
 *                     (instrumentation.ts) BEFORE the splash fetches
 *                     this endpoint. The lazy kick below covers a
 *                     process that booted before the injection existed.
 *   API QUOTA       — the shared 429 gate snapshot (llmGateInfo: the
 *                     escalation level + the epoch the gate opens).
 *                     Same source the terminal polls every 2s; one
 *                     definition of the quota, every consumer.
 *
 * Honesty rules (same as the rest of the splash): any unreadable vital is
 * returned as null/0, never faked — the POST line stamps ?? for it.
 */

/** Count *.json scar files under postmortems/ (recursive, async). */
async function diskScarCount(): Promise<number> {
  if (typeof PROJECT_ROOT !== 'string' || !PROJECT_ROOT) {
    return 0; // Honesty rule: return 0 if path is invalid, do not throw.
  }
  const root = join(PROJECT_ROOT, "postmortems");

  try {
    const entries = await readdir(root);
    let scarCount = 0;
    // Use a stack for iterative DFS traversal to avoid stack overflow on deep directories
    const stack: { path: string; entries: string[] }[] = [{ path: root, entries: entries }];

    while (stack.length > 0) {
      const { path: currentDir, entries: currentEntries } = stack.pop()!;

      for (const entryName of currentEntries) {
        const fullPath = join(currentDir, entryName);
        try {
          const st = await stat(fullPath);
          if (st.isDirectory()) {
            // If directory, read entries and push onto the stack for later processing
            const subEntries = await readdir(fullPath);
            stack.push({ path: fullPath, entries: subEntries });
          } else if (entryName.endsWith(".json")) {
            // If file and ends with .json, count it
            scarCount++;
          }
        } catch (e) {
          // Log specific errors for individual file/dir access failures but continue traversal
          if (e instanceof Error) {
            console.warn(`Could not stat or access path ${fullPath}: ${e.message}`);
          } else {
            console.warn(`Unknown error accessing path ${fullPath}:`, e);
          }
        }
      }
    }
    return scarCount;

  } catch (e) {
    // Catch errors during initial directory read (e.g., directory doesn't exist or permissions denied)
    if (e instanceof Error) {
      console.error(`Fatal error during scar file traversal starting at ${root}: ${e.message}`);
    } else {
      console.error(`Unknown fatal error during scar file traversal starting at ${root}:`, e);
    }
    return 0; // Return 0 on fatal traversal error
  }
}

/** GET /user with the vault-opened PAT. The auto-connect moment. */
async function checkGitHubAuth(
  token: string
): Promise<{ ok: true; login: string } | { ok: false; error: string }> {
  // Input validation
  if (typeof token !== 'string' || token.trim().length === 0) {
    return { ok: false, error: "Invalid token: must be a non-empty string" };
  }

  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), 3500);
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Architecture-Helper-Pipeline",
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${res.statusText || 'Unknown Error'}` };
    }
    try {
      const user = await res.json();
      if (typeof user !== 'object' || user === null || !('login' in user) || !user.login) {
        return { ok: false, error: "No login found or invalid response structure in /user response body" };
      }
      return { ok: true, login: user.login as string };
    } catch {
      return { ok: false, error: "Failed to parse JSON response from GitHub API (response body might be empty or malformed)" };
    }
  } catch (e) {
    if (e instanceof Error) {
      if (e.name === "AbortError") {
        return { ok: false, error: "Request timed out after 3.5s" };
      }
      return { ok: false, error: `Network or parsing error: ${e.message}` };
    }
    return { ok: false, error: "Unknown error during GitHub auth check" };
  } finally {
    clearTimeout(kill);
  }
}

export async function GET() {
  // 1. AUTO-CONNECT: open the sealed token (this call also triggers the
  // one-shot plaintext→vault migration on the very first boot after the
  // change — getStoredTarget is the migration entry point).
  let auth: { ok: true; login: string } | { ok: false; error: string } | null = null;
  try {
    const target = await getStoredTarget();
    if (target?.token) {
      auth = await checkGitHubAuth(target.token);
    } else {
      auth = null; // not configured — the splash shows ?? honestly
    }
  } catch (e) {
    // Catching errors from getStoredTarget (e.g., vault read failure)
    if (e instanceof Error) {
      console.error("Error retrieving stored target for GitHub auth:", e.message);
    } else {
      console.error("Unknown error retrieving stored target for GitHub auth:", e);
    }
    auth = null;
  }

  // Prepare independent async tasks for parallel execution
  const corpusPromise = (async () => {
    try {
      const [attempts, failed, enhanced] = await Promise.all([
        db.mutationCorpus.count(),
        db.mutationCorpus.count({ where: { failureType: { not: null } } }),
        db.mutationCorpus.count({ where: { gateOutcome: "enhanced" } }),
      ]);
      return { attempts, failed, enhanced };
    } catch (e) {
      if (e instanceof Error) {
        console.error("Error querying mutation corpus from DB:", e.message);
      } else {
        console.error("Unknown error querying mutation corpus from DB:", e);
      }
      return null;
    }
  })();

  const passRatePromise = (async () => {
    try {
      const t = await getPassRateTrend();
      if (t) {
        return {
          lastWindowPct: t.lastWindow.passRate === null ? null : Math.round(t.lastWindow.passRate * 100),
          overallPct: t.overallPassRate === null ? null : Math.round(t.overallPassRate * 100),
          lastWindowAttempts: t.lastWindow.attempts,
          trend: t.trend,
        };
      }
      return null;
    } catch (e) {
      if (e instanceof Error) {
        console.error("Error fetching pass rate trend:", e.message);
      } else {
        console.error("Unknown error fetching pass rate trend:", e);
      }
      return null;
    }
  })();

  const scars = diskScarCount(); // Start scar count without awaiting immediately

  const hotSwapPromise = (async () => {
    try {
      return { lifetime: await getHotSwapSuccessCount(), thisBoot: getSwapCount() };
    } catch (e) {
      if (e instanceof Error) {
        console.error("Error retrieving hot-swap counts:", e.message);
      } else {
        console.error("Unknown error retrieving hot-swap counts:", e);
      }
      return null;
    }
  })();

  const autonomyPromise = (async () => {
    try {
      const state = autonomousLoopRuntime.getState();
      return {
        status: state.status,
        livePhase: state.livePhase,
        recoveryRemainingMs: state.recoveryRemainingMs,
      };
    } catch (e) {
      if (e instanceof Error) {
        console.error("Error getting autonomous loop state:", e.message);
      } else {
        console.error("Unknown error getting autonomous loop state:", e);
      }
      return null;
    }
  })();

  const zaiPromise = (async () => {
    try {
      warmZaiCortex();
      return zaiCortexStatus();
    } catch (e) {
      if (e instanceof Error) {
        console.error("Error warming or checking Zai Cortex status:", e.message);
      } else {
        console.error("Unknown error warming or checking Zai Cortex status:", e);
      }
      return null;
    }
  })();

  // Await all independent tasks in parallel, including diskScarCount
  const [corpus, passRate, scarsResult, hotSwap, autonomy, zai] = await Promise.all([
    corpusPromise,
    passRatePromise,
    scars,
    hotSwapPromise,
    autonomyPromise,
    zaiPromise,
  ]);

  return NextResponse.json({
    ok: true,
    vault: vaultStatus(),
    auth,
    corpus,
    passRate,
    scars: scarsResult,
    hotSwap,
    autonomy,
    zai,
    // The provider quota gate — live snapshot, zero I/O (the gate state
    // lives on globalThis). `endsAtMs` is the countdown anchor: consumers
    // tick against it locally instead of re-polling.
    quota: llmGateInfo(),
  });
}