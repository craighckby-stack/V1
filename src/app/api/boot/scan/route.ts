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
  type ZaiCortexInfo,
} from "@/lib/pipeline/llm/agent-llm";
import { autonomousLoopRuntime } from "@/lib/pipeline/autonomous/loop-runtime";
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
 *
 * Honesty rules (same as the rest of the splash): any unreadable vital is
 * returned as null/0, never faked — the POST line stamps ?? for it.
 */

/** Count *.json scar files under postmortems/ (recursive, sync — small tree). */
function diskScarCount(): number {
  const root = join(PROJECT_ROOT, "postmortems");
  let n = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (e.endsWith(".json")) n++;
    }
  };
  walk(root);
  return n;
}

/** GET /user with the vault-opened PAT. The auto-connect moment. */
async function checkGitHubAuth(
  token: string
): Promise<{ ok: true; login: string } | { ok: false; error: string }> {
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
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const user = (await res.json()) as { login?: string };
    if (!user?.login) return { ok: false, error: "no login in /user response" };
    return { ok: true, login: user.login };
  } catch (e) {
    return { ok: false, error: (e as Error).name === "AbortError" ? "timeout" : "network" };
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
  } catch {
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
  } catch {
    corpus = null;
  }

  // 3. Disk scars — wipe-proof failure record.
  let scars: number | null = null;
  try {
    scars = diskScarCount();
  } catch {
    scars = null;
  }

  // 4. Hot-swap: lifetime (persistent) + this boot (in-memory).
  let hotSwap: { lifetime: number; thisBoot: number } | null = null;
  try {
    hotSwap = { lifetime: await getHotSwapSuccessCount(), thisBoot: getSwapCount() };
  } catch {
    hotSwap = null;
  }

  // 5. Autonomy — the live status word from the same source
  // /api/autonomous/status serves.
  let autonomy: { status: string } | null = null;
  try {
    autonomy = { status: autonomousLoopRuntime.getState().status };
  } catch {
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
  } catch {
    zai = null;
  }

  return NextResponse.json({
    ok: true,
    vault: vaultStatus(),
    auth,
    corpus,
    scars,
    hotSwap,
    autonomy,
    zai,
  });
}
