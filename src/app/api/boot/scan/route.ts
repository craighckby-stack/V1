import { NextResponse } from "next/server";
import { readdirSync, statSync } from "fs";
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
  type ZaiCortexInfo,
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

/** Count *.json scar files under postmortems/ (recursive, sync — small tree). */
function diskScarCount(): number {
  if (typeof PROJECT_ROOT !== 'string' || !PROJECT_ROOT) {
    return 0; // Honesty rule: return 0 if path is invalid, do not throw.
  }
  const root = join(PROJECT_ROOT, "postmortems");
  let n = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (e) {
      if (e instanceof Error) {
        console.error(`Error reading directory ${dir}: ${e.message}`);
      } else {
        console.error(`Unknown error reading directory ${dir}:`, e);
      }
      return; // Stop walking this branch on read error
    }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch (e) {
        if (e instanceof Error) {
          console.warn(`Could not stat path ${p}: ${e.message}`);
        } else {
          console.warn(`Unknown error statting path ${p}:`, e);
        }
        continue; // Skip this entry if stat fails
      }
      if (st.isDirectory()) walk(p);
      else if (e.endsWith(".json")) n++;
    }
  };
  try {
    walk(root);
  } catch (e) {
    // Catch any unexpected errors during the initial walk call
    if (e instanceof Error) {
      console.error(`Fatal error during scar file traversal starting at ${root}: ${e.message}`);
    } else {
      console.error(`Unknown fatal error during scar file traversal starting at ${root}:`, e);
    }
    return 0; // Return 0 on fatal traversal error
  }
  return n;
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
      const user = (await res.json()) as { login?: string };
      if (!user?.login) {
        return { ok: false, error: "No login found in /user response body" };
      }
      return { ok: true, login: user.login };
    } catch {
      return { ok: false, error: "Failed to parse JSON response from GitHub API" };
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

  // 2. Corpus counts (DB) — 0 rows reads as 0, honestly.
  let corpus: { attempts: number; failed: number; enhanced: number } | null = null;
  try {
    const [attempts, failed, enhanced] = await Promise.all([
      db.mutationCorpus.count(),
      db.mutationCorpus.count({ where: { failureType: { not: null } } }),
      db.mutationCorpus.count({ where: { gateOutcome: "enhanced" } }),
    ]);
    corpus = { attempts, failed, enhanced };
  } catch (e) {
    if (e instanceof Error) {
      console.error("Error querying mutation corpus from DB:", e.message);
    } else {
      console.error("Unknown error querying mutation corpus from DB:", e);
    }
    corpus = null;
  }

  // 2b. Pass-rate trend (DB) — the "is compounding compounding?" vital.
  // Same corpus, derived view: headline = last ≤20 resolvable attempts;
  // trend = improving/declining/flat/insufficient (halves ±10pp). Null
  // when the corpus is unreadable — the splash stamps ?? honestly.
  let passRate: {
    lastWindowPct: number | null;
    overallPct: number | null;
    lastWindowAttempts: number;
    trend: string;
  } | null = null;
  try {
    const t = await getPassRateTrend();
    if (t) {
      passRate = {
        lastWindowPct: t.lastWindow.passRate === null ? null : Math.round(t.lastWindow.passRate * 100),
        overallPct: t.overallPassRate === null ? null : Math.round(t.overallPassRate * 100),
        lastWindowAttempts: t.lastWindow.attempts,
        trend: t.trend,
      };
    }
  } catch (e) {
    if (e instanceof Error) {
      console.error("Error fetching pass rate trend:", e.message);
    } else {
      console.error("Unknown error fetching pass rate trend:", e);
    }
    passRate = null;
  }

  // 3. Disk scars — wipe-proof failure record.
  let scars: number | null = null;
  try {
    scars = diskScarCount();
  } catch (e) {
    if (e instanceof Error) {
      console.error("Error counting disk scars:", e.message);
    } else {
      console.error("Unknown error counting disk scars:", e);
    }
    scars = null;
  }

  // 4. Hot-swap: lifetime (persistent) + this boot (in-memory).
  let hotSwap: { lifetime: number; thisBoot: number } | null = null;
  try {
    hotSwap = { lifetime: await getHotSwapSuccessCount(), thisBoot: getSwapCount() };
  } catch (e) {
    if (e instanceof Error) {
      console.error("Error retrieving hot-swap counts:", e.message);
    } else {
      console.error("Unknown error retrieving hot-swap counts:", e);
    }
    hotSwap = null;
  }

  // 5. Autonomy — the live status word from the same source
  // /api/autonomous/status serves. Now carries the derived `livePhase`
  // (DISARMED / ARMED-RUNNING / ARMED-THROTTLED / ARMED-RECOVERING /
  // ARMED-PAUSED) — the splash renders this instead of the raw
  // `status`, so the operator sees what the loop is actually DOING
  // (throttled vs. running vs. paused) instead of the scheduler's
  // internal word. `recoveryRemainingMs` is the ARMED-RECOVERING
  // countdown (a RELATIVE duration, accurate at response time — the
  // splash re-anchors to its own clock, same skew-free pattern as the
  // quota gate's remainingMs).
  let autonomy:
    | { status: string; livePhase: string; recoveryRemainingMs: number }
    | null = null;
  try {
    const state = autonomousLoopRuntime.getState();
    autonomy = {
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
    autonomy = null;
  }

  // 6. Z.ai cortex — the auto-injected provider connection. Normally
  // already warming/ready (instrumentation injected it at server boot,
  // BEFORE this request); the kick is the belt-and-suspenders path for
  // processes that started before the hook existed. Idempotent +
  // throttled inside warmZaiCortex — a dead provider is not hammered.
  // The status read is instant (no await on the ping) — this endpoint
  // never blocks on the provider.
  let zai: ZaiCortexInfo | null = null;
  try {
    warmZaiCortex();
    zai = zaiCortexStatus();
  } catch (e) {
    if (e instanceof Error) {
      console.error("Error warming or checking Zai Cortex status:", e.message);
    } else {
      console.error("Unknown error warming or checking Zai Cortex status:", e);
    }
    zai = null;
  }

  return NextResponse.json({
    ok: true,
    vault: vaultStatus(),
    auth,
    corpus,
    passRate,
    scars,
    hotSwap,
    autonomy,
    zai,
    // The provider quota gate — live snapshot, zero I/O (the gate state
    // lives on globalThis). `endsAtMs` is the countdown anchor: consumers
    // tick against it locally instead of re-polling.
    quota: llmGateInfo(),
  });
}