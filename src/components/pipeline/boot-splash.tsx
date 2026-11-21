"use client";

/**
 * BOOT SPLASH — the cold/warm boot ceremony.
 *
 * Not a static logo screen: it is a BIOS-style POST that reports the
 * machine's LIVE vitals, fetched from its own APIs while the CRT warms up:
 *   - mutation ledger  (/api/branches)          → "63 ON REMOTE · NEXT loop-64"
 *   - postmortem chain (/api/postmortems/chain) → "32 VERIFIED · 0 BROKEN"
 *   - prophecy engine  (/api/oracle/status)     → "0 SEEDED · 0 PENDING"
 *   - LLM cortex       (/api/self-enhance/status) → READY or GATE mm:ss
 *   - hot-swap bay     (/api/hot-swap/status)   → swaps this boot
 *   - uplink           (repo from /api/branches)
 *   - boot scan        (/api/boot/scan)        → NEW (additive): GitHub
 *     auto-connect identity (the sealed PAT is opened server-side, zero
 *     operator input), token-vault status, total mutations + failures,
 *     hot-swap lifetime count, autonomy status
 *
 * Sequence (cold boot): CRT power-on flash → POST lines stamp in one by
 * one → the LOOP sigil scrambles out of noise → the machine addresses the
 * observer and offers [ ▶ ENTER THE LOOP ] → pressing ENTER loads the
 * terminal. Splash → system, nothing in between.
 *
 * ENTER works from ANY phase (2026-11-17 update): one press during the
 * flash/POST/sigil commits entry directly (the ceremony fast-forwards
 * through the exit animation). Previously Enter mid-animation only
 * SKIPPED to the invite — a single press left the observer staring at
 * a static splash demanding a second one. Any other key still just
 * skips the animation to the invite, where the button (or Enter, or a
 * click anywhere) enters.
 *
 * The rite fires on EVERY entry — warm boot or cold. Warm boots (already
 * entered this browser session) take the fast path — the SESSION RESUMED
 * line first, then the same nine boot/scan vitals lines appended after
 * it, so the live machine state is reported on EVERY entry, not just
 * the first. prefers-reduced-motion flattens
 * the fancy animation (the CRT effects go static) but does NOT cancel
 * the ceremony. Force the full cold POST with ?boot=force.
 *
 * Aesthetic: amber phosphor CRT (the terminal inside is white-on-black;
 * the amber screen is the machine's "face" before it lets you in).
 * Honors prefers-reduced-motion: everything renders instantly.
 *
 * HEIGHT-FIT SCALING (2026-11-18, the "ENTER button clipped on short
 * viewports" fix): the full cold-boot ceremony — logo + tagline + rule
 * + 17 POST lines + invite (2 dim lines) — is ~55em tall at the 13px design size
 * (~690px). The splash root is overflow:hidden, so on any viewport
 * shorter than that (a 1280×577 laptop window, phone landscape) the
 * fixed 13px type pushed the ENTER button below the fold and cut the
 * logo at the top — the machine asked, but half the button was
 * invisible. The CRT font-size now scales with viewport height
 * (clamp(8px, 100vh/56, 13px)) and every size inside is em-based, so
 * the entire ceremony scales as one block and the button always lands
 * in frame. Under 430px of height even that can't fit — the root then
 * switches to flex-start + overflow-y:auto so the button stays
 * reachable by scroll instead of being clipped out of existence.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ensureAudio, postBeep, powerOnThunk, stopAllAudio } from "@/lib/retro-boot-audio";

type Phase = "flash" | "post" | "title" | "invite" | "exit";

type Json = Record<string, unknown>;

const GLYPHS = "█▓▒░■<>/\\|=+*#%";

// ANSI-shadow sigil — the machine's self-portrait.
const ASCII_LOOP = [
  "██╗       ██████╗  ██████╗ ██████╗ ",
  "██║      ██╔═══██╗██╔═══██╗██╔══██╗",
  "██║      ██║   ██║██║   ██║██████╔╝",
  "██║      ██║   ██║██║   ██║██╔═══╝ ",
  "██║      ╚██████╔╝╚██████╔╝██║     ",
  "███████╗  ╚═════╝  ╚═════╝ ╚═╝     ",
].join("\n");

const TAGLINE = "A MACHINE THAT REWRITES ITS OWN CODE.";

/** POST line counts. Cold = 8 original + 9 boot/scan lines. Warm = the
 *  SESSION RESUMED line + the same 9 boot/scan lines. (Warm boots used
 *  to show ONE line only — after the first entry, every reload looked
 *  like the splash "never updated". The scan lines now append on both
 *  paths: one definition, two ceremonies, same bytes.)
 *  Keep this in sync with scanPostLines() below and the .bsp-post
 *  min-height interpolation — the count drives the POST cadence, the
 *  stamping total, and the layout reservation. */
const SCAN_LINE_COUNT = 9;
const COLD_POST_MS = (8 + SCAN_LINE_COUNT) * 130 + 260;
const WARM_POST_MS = (1 + SCAN_LINE_COUNT) * 130 + 260;

interface PostLine {
  label: string;
  value: string;
  stamp: string;
  warn?: boolean;
  link?: string;
}

interface Vitals {
  branchesTotal: string;
  nextBranch: string;
  repo: string;
  chainTotal: string;
  chainBreaks: string;
  prophecies: string;
  propheciesPending: string;
  llm: string;
  cycles: string;
  swaps: string;
  // ── boot/scan additions (cold-boot POST lines 9-13) ──
  /** GitHub login from GET /user, "REFUSED" on auth failure, "" when no PAT is on file, "??" unreadable. */
  authLogin: string;
  /** "SEALED" | "PLAINTEXT" | "??" — is the PAT resting in an enc:v1: envelope. */
  vaultSealed: string;
  /** Postmortem JSON files on disk — the wipe-proof failure record. */
  scars: string;
  /** DB mutation-corpus counts (the OTHER failure record): lifetime
   *  attempts / failed / enhanced from the mutationCorpus table. Unlike
   *  `scars` (disk, survives DB wipes), this is the live database's own
   *  tally — after a DB reset it restarts from zero, which is exactly
   *  the honest divergence the two lines are supposed to show side by
   *  side ("203 FAILED" on disk vs a fresh corpus after a wipe). */
  corpusAttempts: string;
  corpusFailed: string;
  corpusEnhanced: string;
  /** Persistent (restart-surviving) successful hot-swap count. */
  swapsLifetime: string;
  /** The live loop's raw status word (idle/running/paused/error),
   *  uppercased. Kept for back-compat with the old splash logic — the
   *  rendered AUTONOMY line now uses `livePhase` (see below) instead. */
  autonomy: string;
  /** The derived LIVE phase from /api/boot/scan's autonomy.livePhase:
   *  "DISARMED" | "ARMED-RUNNING" | "ARMED-THROTTLED" |
   *  "ARMED-RECOVERING" | "ARMED-PAUSED" | "??". This is what the
   *  AUTONOMY POST line renders — the operator's actionable view of
   *  what the loop is doing (not the scheduler's internal word). */
  livePhase: string;
  /** Client-epoch ms when the ARMED-RECOVERING window ends (0 when not
   *  recovering). Anchored to the client clock at fetch time:
   *  `Date.now() + recoveryRemainingMs` (the server's recoveryRemainingMs
   *  is a relative duration, accurate at response time). The splash
   *  ticks against it locally every second, immune to server/client
   *  clock skew (same pattern as quotaEndsAtMs). */
  recoveryEndsAtMs: number;
  // ── Z.ai cortex (auto-injected at server boot, before this splash) ──
  /** "ready" | "warming" | "error" | "cold" | "??" — the provider
   *  connection state from /api/boot/scan's zai field. */
  zaiState: string;
  /** Measured ping latency in ms ("??" unknown). */
  zaiPing: string;
  /** Truncated failure reason ("" when none). */
  zaiError: string;
  /** Ready-state note — e.g. "PROVIDER REACHED — 429 QUOTA COOLING"
   *  when the connection is verified but the quota is cooling. */
  zaiNote: string;
  // ── LLM quota gate (the 429 escalation gate, shared process-wide) ──
  /** "open" | "cooling" | "??" — the provider quota gate. "??" when the
   *  status endpoint itself was unreadable (honesty rule: absent data is
   *  never reported as "open"). */
  quotaState: string;
  /** Client-epoch ms when the gate opens (0 when open/unknown) — the
   *  countdown anchor. Set to `Date.now() + remainingMs` at fetch time
   *  (the server's `remainingMs` is a relative duration, accurate at
   *  response time). The splash ticks against it locally every second,
   *  so the clock stays accurate between the one-shot fetch and ENTER
   *  AND is immune to server/client clock skew (both the anchor and
   *  the tick's `Date.now()` are client-epoch). */
  quotaEndsAtMs: number;
  /** Escalation level of the ACTIVE cooldown (1=2min..4=30min; 0 open). */
  quotaLevel: number;
  // ── pass-rate trend (the "is compounding compounding?" vital) ──
  /** Last-≤20-resolvable-attempts pass rate, percent ("??" unreadable,
   *  "—" when no resolvable attempts exist yet). */
  passRatePct: string;
  /** How many resolvable attempts the headline rate covers. */
  passRateAttempts: string;
  /** IMPROVING | DECLINING | FLAT | INSUFFICIENT | ?? — second half vs
   *  first half over the resolvable attempts, ±10pp significance bar. */
  passRateTrend: string;
  /** Lifetime pass rate over the whole lookback window, percent. */
  passRateOverall: string;
}

const UNKNOWN_VITALS: Vitals = {
  branchesTotal: "??",
  nextBranch: "loop-??",
  repo: "unlinked",
  chainTotal: "??",
  chainBreaks: "??",
  prophecies: "??",
  propheciesPending: "??",
  llm: "UNKNOWN",
  cycles: "??",
  swaps: "??",
  authLogin: "??",
  vaultSealed: "??",
  scars: "??",
  corpusAttempts: "??",
  corpusFailed: "??",
  corpusEnhanced: "??",
  swapsLifetime: "??",
  autonomy: "??",
  livePhase: "??",
  recoveryEndsAtMs: 0,
  zaiState: "??",
  zaiPing: "??",
  zaiError: "",
  zaiNote: "",
  quotaState: "??",
  quotaEndsAtMs: 0,
  quotaLevel: 0,
  passRatePct: "??",
  passRateAttempts: "??",
  passRateTrend: "??",
  passRateOverall: "??",
};

const asObj = (v: unknown): Json | null => (v && typeof v === "object" ? (v as Json) : null);
const pick = (o: Json | null | undefined, k: string): unknown => (o ? o[k] : undefined);
const txt = (v: unknown, fallback = "??"): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;

function gateClock(remainingMs: number): string {
  const s = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Fetch the machine's live vitals. Each endpoint gets its own timeout —
 *  the GitHub-backed ledger is slower and must not be killed by the fast
 *  local endpoints' budget. Any failure degrades to "??" — the POST still
 *  stamps, honestly marking what it could not read. */
async function fetchVitals(): Promise<Vitals> {
  const get = async (url: string, ms: number): Promise<unknown> => {
    const ac = new AbortController();
    const kill = window.setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(url, { signal: ac.signal, cache: "no-store" });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    } finally {
      window.clearTimeout(kill);
    }
  };
  try {
    const [br, chain, oracle, status, hotswap, scan] = await Promise.all([
      get("/api/branches", 3000),
      get("/api/postmortems/chain", 1800),
      get("/api/oracle/status", 1800),
      get("/api/self-enhance/status", 1800),
      get("/api/hot-swap/status", 1800),
      // boot/scan — auto-connect + vault + totals. Its own (longer) budget:
      // the GitHub /user round trip must not be killed by the fast local
      // endpoints' budget (same reasoning as the ledger fetch above).
      get("/api/boot/scan", 4000),
    ]);
    const gate = asObj(pick(asObj(status), "llmGate"));
    const gateActive = gate?.active === true;
    const gateMs = typeof gate?.remainingMs === "number" ? gate.remainingMs : 0;
    const gateLevel = typeof gate?.level === "number" ? gate.level : 0;
    const stats = asObj(pick(asObj(status), "stats"));
    const mapped: Vitals = {
      branchesTotal: txt(pick(asObj(br), "total")),
      nextBranch: txt(pick(asObj(br), "nextMutationBranch"), "loop-??"),
      repo: txt(pick(asObj(br), "repo"), "unlinked"),
      chainTotal: txt(pick(asObj(chain), "total")),
      chainBreaks: txt(pick(asObj(chain), "linkBreaks")),
      prophecies: txt(pick(asObj(pick(asObj(oracle), "counts")), "total")),
      propheciesPending: txt(pick(asObj(pick(asObj(oracle), "counts")), "pending")),
      // The original 8 POST lines include an "LLM CORTEX" line. It used
      // to show a frozen `GATE mm:ss — COOLING` snapshot of the gate's
      // remaining time at fetch — but the splash only fetches vitals
      // ONCE, so that countdown was frozen at the fetch-time value
      // (a 30-min cooldown would show "GATE 29:50" for the whole
      // splash). The live countdown lives on the API QUOTA line below
      // (it ticks every second against an anchored client-epoch end).
      // The LLM CORTEX line now just reports the gate STATE — no
      // number — so the two lines can't disagree.
      llm: gateActive ? "THROTTLED — SEE API QUOTA LINE" : "READY",
      cycles: txt(pick(stats, "cyclesCompleted")),
      swaps: txt(pick(asObj(hotswap), "swapCount")),
      // ── boot/scan mapping ──
      authLogin: (() => {
        if (scan === null) return "??"; // endpoint unreadable
        const a = asObj(pick(asObj(scan), "auth"));
        if (a === null) return ""; // auth:null — no PAT on file
        if (a.ok === true) return txt(pick(a, "login"), "??");
        return "REFUSED"; // GitHub rejected the sealed PAT
      })(),
      vaultSealed: (() => {
        const v = asObj(pick(asObj(scan), "vault"));
        if (!v) return "??";
        return v.sealed === true ? "SEALED" : "PLAINTEXT";
      })(),
      scars: txt(pick(asObj(scan), "scars")),
      // ── mutation corpus mapping (the DB tally — see Vitals.corpus*) ──
      // Honesty rules: "??" when the corpus block is unreadable; the
      // counts themselves are plain numbers (0 is a legitimate value —
      // e.g. right after a DB wipe, the exact moment this line earns its
      // keep next to the disk-based MUTATION TOTALS line).
      corpusAttempts: (() => {
        const c = asObj(pick(asObj(scan), "corpus"));
        return c ? txt(pick(c, "attempts")) : "??";
      })(),
      corpusFailed: (() => {
        const c = asObj(pick(asObj(scan), "corpus"));
        return c ? txt(pick(c, "failed")) : "??";
      })(),
      corpusEnhanced: (() => {
        const c = asObj(pick(asObj(scan), "corpus"));
        return c ? txt(pick(c, "enhanced")) : "??";
      })(),
      // ── pass-rate trend mapping (from boot/scan's passRate vital) ──
      passRatePct: (() => {
        const pr = asObj(pick(asObj(scan), "passRate"));
        if (!pr) return "??"; // endpoint or corpus unreadable
        if (pr.lastWindowPct === null) return "—"; // no resolvable attempts yet
        return txt(pr.lastWindowPct);
      })(),
      passRateAttempts: (() => {
        const pr = asObj(pick(asObj(scan), "passRate"));
        return pr ? txt(pick(pr, "lastWindowAttempts")) : "??";
      })(),
      passRateTrend: (() => {
        const pr = asObj(pick(asObj(scan), "passRate"));
        const t = pick(pr, "trend");
        return typeof t === "string" ? t.toUpperCase() : "??";
      })(),
      passRateOverall: (() => {
        const pr = asObj(pick(asObj(scan), "passRate"));
        if (!pr) return "??";
        if (pr.overallPct === null) return "—";
        return txt(pr.overallPct);
      })(),
      swapsLifetime: txt(pick(asObj(pick(asObj(scan), "hotSwap")), "lifetime")),
      // Raw scheduler status (kept for back-compat / debug). The
      // AUTONOMY POST line renders `livePhase` instead — this raw word
      // is the scheduler's internal idle/running/paused/error, which
      // is dishonest when the loop is armed but throttled (it says
      // "IDLE" when the loop is actually waiting out a 429 gate).
      autonomy: txt(pick(asObj(pick(asObj(scan), "autonomy")), "status"), "??").toUpperCase(),
      // ── livePhase + recovery countdown ──
      // The derived LIVE phase (DISARMED / ARMED-RUNNING /
      // ARMED-THROTTLED / ARMED-RECOVERING / ARMED-PAUSED). This is the
      // operator's actionable view — the AUTONOMY POST line renders it.
      livePhase: (() => {
        const a = asObj(pick(asObj(scan), "autonomy"));
        const lp = pick(a, "livePhase");
        return typeof lp === "string" ? lp : "??";
      })(),
      // Clock-skew fix: anchor the recovery deadline to the CLIENT
      // clock. `recoveryRemainingMs` is the server's relative duration,
      // accurate at response time. Adding it to the client's Date.now()
      // at fetch-receipt yields a CLIENT-epoch end time, so the splash's
      // tick (`recoveryEndsAtMs - nowMs`, both client-epoch) is skew-free
      // (same pattern as quotaEndsAtMs).
      recoveryEndsAtMs: (() => {
        const a = asObj(pick(asObj(scan), "autonomy"));
        const r = pick(a, "recoveryRemainingMs");
        return typeof r === "number" && r > 0 ? Date.now() + r : 0;
      })(),
      // ── Z.ai cortex mapping ──
      zaiState: (() => {
        const z = asObj(pick(asObj(scan), "zai"));
        if (z === null) return "??"; // endpoint unreadable
        const s = pick(z, "state");
        return typeof s === "string" ? s : "??";
      })(),
      zaiPing: (() => {
        const z = asObj(pick(asObj(scan), "zai"));
        return typeof pick(z, "pingMs") === "number" ? String(pick(z, "pingMs")) : "??";
      })(),
      zaiError: (() => {
        const z = asObj(pick(asObj(scan), "zai"));
        const e = pick(z, "error");
        return typeof e === "string" ? e.slice(0, 48) : "";
      })(),
      zaiNote: (() => {
        const z = asObj(pick(asObj(scan), "zai"));
        const n = pick(z, "note");
        return typeof n === "string" ? n : "";
      })(),
      // ── quota gate mapping ──
      // Honest three-state: "??" when the endpoint was unreadable (an
      // absent gate must never be reported as "open"), "cooling" when the
      // shared 429 gate is active, "open" when it verifiably is not.
      quotaState: status === null ? "??" : gateActive ? "cooling" : "open",
      // Clock-skew fix: anchor to the CLIENT clock. `gateMs` is the
      // server's `remainingMs` — a relative duration, accurate at the
      // moment the response was generated. Adding it to the client's
      // `Date.now()` at fetch-receipt yields a CLIENT-epoch end time, so
      // the splash's tick (`quotaEndsAtMs - nowMs`, both client-epoch)
      // is skew-free. The splash only fetches vitals once, so this
      // anchor is set once and ticks down locally — no chance to drift
      // further. (The server's own `endsAtMs` epoch is intentionally
      // NOT used here: diffing it against the client's `Date.now()`
      // turns server/client clock skew directly into countdown drift.)
      quotaEndsAtMs: gateActive ? Date.now() + gateMs : 0,
      quotaLevel: gateLevel,
    };
    return mapped;
  } finally {
    /* per-request timers are cleared in get() */
  }
}

/** Text that resolves out of CRT noise, left to right. Initial state is
 *  the final text — the scramble begins (and first repaints into noise)
 *  only once `start` flips true, inside the rAF callback. */
function Scramble({ text, start, ms, className }: { text: string; start: boolean; ms: number; className?: string }) {
  const [out, setOut] = useState(text);
  useEffect(() => {
    if (!start) return;
    const total = text.length;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const solved = Math.floor(p * total);
      let s = text.slice(0, solved);
      for (let i = solved; i < total; i++) {
        const ch = text[i];
        s += ch === "\n" || ch === " " ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      setOut(s);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [start, text, ms]);
  return <span className={className}>{out}</span>;
}

/** The nine boot/scan vitals lines — ONE definition, used by both
 *  ceremonies: cold appends them after the original 8 (which stay
 *  byte-for-byte untouched), warm appends them after the SESSION
 *  RESUMED line. Same bytes on every entry — the live machine state
 *  is never a cold-boot-only show. The Z.AI CORTEX line leads the
 *  group: its injection happens at SERVER BOOT, before this splash
 *  reads it — first in fact, first in report. The API QUOTA line
 *  follows it (the provider's connection, then the provider's meter):
 *  when the shared 429 gate is active it renders a LIVE countdown to
 *  the gate opening, ticking every second against `quotaEndsAtMs`
 *  (a CLIENT-epoch value — see fetchVitals — immune to server/client
 *  clock skew); when the gate is open it stamps OK, and an unreadable
 *  gate is never reported as open. */
function scanPostLines(v: Vitals, nowMs: number): PostLine[] {
  return [
    {
      label: "Z.AI CORTEX",
      value:
        v.zaiState === "ready"
        ? v.zaiNote
          ? `AUTO-INJECTED · VERIFIED (${v.zaiPing}ms · 429 COOLING)`
          : `AUTO-INJECTED · VERIFIED (${v.zaiPing}ms PING)`
        : v.zaiState === "warming" ? "AUTO-INJECTING — HANDSHAKE IN FLIGHT"
        : v.zaiState === "error" ? `OFFLINE — ${v.zaiError || "PROVIDER UNREACHABLE"}`
        : v.zaiState === "cold" ? "NOT INJECTED — AWAITING BOOT KICK"
        : "UNREADABLE",
      stamp: v.zaiState === "ready" ? "OK" : v.zaiState === "warming" ? "WAIT" : "??",
      warn: v.zaiState !== "ready",
    },
    {
      label: "API QUOTA",
      value:
        v.quotaState === "??" ? "UNREADABLE"
        : v.quotaState === "open" ? "AVAILABLE — NO 429 GATE ON FILE"
        : v.quotaEndsAtMs > nowMs
        ? `THROTTLED L${v.quotaLevel || 1} — QUOTA READY IN ${gateClock(v.quotaEndsAtMs - nowMs)}`
        : "GATE EXPIRED — NEXT CALL RECHECKS",
      stamp: v.quotaState === "open" ? "OK" : v.quotaState === "??" ? "??" : "WAIT",
      warn: v.quotaState !== "open",
    },
    {
      label: "GITHUB AUTH",
      value:
        v.authLogin === "" ? "NO PAT ON FILE — ENTER VIA [CONFIG]"
        : v.authLogin === "??" ? "AUTO-CONNECT UNREADABLE"
        : v.authLogin === "REFUSED" ? "TOKEN REJECTED — RE-ENTER VIA [CONFIG]"
        : `AUTHENTICATED AS ${v.authLogin}`,
      stamp: v.authLogin === "REFUSED" ? "!!" : v.authLogin !== "" && v.authLogin !== "??" ? "OK" : "??",
      warn: v.authLogin === "" || v.authLogin === "??" || v.authLogin === "REFUSED",
    },
    {
      label: "TOKEN VAULT",
      value:
        v.vaultSealed === "SEALED" ? "AES-256-GCM · SEALED AT REST"
        : v.vaultSealed === "PLAINTEXT" ? "PLAINTEXT — KEY MISSING"
        : "UNREADABLE",
      stamp: v.vaultSealed === "SEALED" ? "OK" : "??",
      warn: v.vaultSealed !== "SEALED",
    },
    {
      label: "MUTATION TOTALS",
      // RECLAIM: branchesTotal is the LIVE count (bounded ~50 by retention),
      // not the lifetime tally (~1012+). Label says "LIVE" to avoid the
      // misread "1012 branches exist" that prompted the reclaim overhaul.
      value: `${v.branchesTotal} LIVE · ${v.scars} FAILED`,
      stamp: "OK",
      warn: v.branchesTotal === "??" || v.scars === "??",
    },
    {
      // The DB-side tally — the other half of the failure record. MUTATION
      // TOTALS above reads the DISK (live branches + postmortem scars, the
      // wipe-proof layer); this line reads the mutationCorpus TABLE (the
      // layer a DB rollback/reset CAN erase). The two are meant to be read
      // together: "203 FAILED" on disk next to a near-zero corpus is the
      // honest signature of a DB wipe, not a contradiction — the route's
      // docstring documents this exact duality. Enhanced = gate verdict
      // "enhanced" (a mutation that actually landed); the delta between
      // attempts and enhanced is the gate-rejection/deferred share.
      label: "MUTATION CORPUS",
      value:
        v.corpusAttempts === "??" ? "UNREADABLE"
        : `${v.corpusAttempts} ATTEMPTS · ${v.corpusFailed} FAILED · ${v.corpusEnhanced} ENHANCED`,
      stamp: v.corpusAttempts === "??" ? "??" : "OK",
      warn: v.corpusAttempts === "??",
    },
    {
      // The "is compounding compounding?" line. Headline = last ≤20
      // resolvable attempts (enhanced vs gate-rejections only — deferred /
      // no-change / llm-unavailable rows are non-attempts and excluded,
      // so a quota drought can't read as a quality decline). Trend =
      // second half vs first half, ±10pp bar; INSUFFICIENT is honest
      // (too few attempts to call). DECLINING stamps !! — that's the
      // line's whole reason to exist.
      label: "PASS RATE",
      value:
        v.passRatePct === "??" ? "UNREADABLE"
        : v.passRatePct === "—" ? "NO RESOLVABLE ATTEMPTS RECORDED YET"
        : `${v.passRatePct}% OF LAST ${v.passRateAttempts} · ${v.passRateTrend}`,
      stamp:
        v.passRatePct === "??" ? "??"
        : v.passRateTrend === "DECLINING" ? "!!"
        : "OK",
      warn: v.passRatePct === "??" || v.passRateTrend === "DECLINING",
    },
    {
      label: "HOT-SWAP LOG",
      value: `${v.swapsLifetime} LIFETIME · ${v.swaps} THIS BOOT`,
      stamp: "OK",
      warn: v.swapsLifetime === "??" || v.swaps === "??",
    },
    {
      label: "AUTONOMY",
      // The derived LIVE phase — see Vitals.livePhase. This is the
      // operator's actionable view of what the loop is doing, not the
      // scheduler's internal word. Each phase maps to a concrete
      // operator action:
      //   ARMED-RUNNING     → "LIVE — SELF-DRIVEN" (no action needed)
      //   ARMED-THROTTLED   → countdown to the 429 gate clearing (auto-
      //                       resumes; STOP still works within 1s)
      //   ARMED-RECOVERING  → 30s settle countdown before the next cycle
      //                       (auto-resumes; no action needed)
      //   ARMED-PAUSED      → "MANUAL [START] REQUIRED" — the loop is
      //                       stopped (operator [STOP]) OR the crash-wall
      //                       tripped (3 consecutive same-class crashes).
      //                       Only [START] releases this state.
      //   DISARMED          → "PRESS [START]" — the loop is off.
      value:
        v.livePhase === "ARMED-RUNNING" ? "LIVE — SELF-DRIVEN"
        : v.livePhase === "ARMED-THROTTLED" ? `ARMED — THROTTLED — QUOTA READY IN ${gateClock(v.quotaEndsAtMs - nowMs)}`
        : v.livePhase === "ARMED-RECOVERING" && v.recoveryEndsAtMs > nowMs ? `ARMED — RECOVERING — RESUME IN ${gateClock(v.recoveryEndsAtMs - nowMs)}`
        : v.livePhase === "ARMED-RECOVERING" ? "ARMED — RECOVERING — RESUMING"
        : v.livePhase === "ARMED-PAUSED" ? "ARMED — PAUSED — MANUAL [START] REQUIRED"
        : v.livePhase === "DISARMED" ? "DISARMED — PRESS [START]"
        : v.livePhase === "??" ? "UNREADABLE"
        : `ARMED — ${v.livePhase}`,
      stamp:
        v.livePhase === "ARMED-RUNNING" ? "LIVE"
        : v.livePhase === "ARMED-PAUSED" || v.livePhase === "??" ? "WAIT"
        : v.livePhase === "DISARMED" ? "OK"
        : "WAIT",
      warn:
        v.livePhase === "ARMED-PAUSED" ||
        v.livePhase === "??" ||
        v.livePhase === "ARMED-THROTTLED",
    },
  ];
}

export function BootSplash({ onEnter }: { onEnter: () => void }) {
  const [phase, setPhase] = useState<Phase>("flash");
  const [shown, setShown] = useState(0);
  const [vitals, setVitals] = useState<Vitals>(UNKNOWN_VITALS);
  const [warm, setWarm] = useState(false);

  const timers = useRef<number[]>([]);
  const enteredRef = useRef(false);
  const reducedRef = useRef(false);
  const phaseRef = useRef<Phase>("flash");
  const btnRef = useRef<HTMLButtonElement>(null);
  const onEnterRef = useRef(onEnter);

  // Ref mirrors are written in effects (never during render) so callbacks
  // always read fresh values without re-binding listeners.
  useEffect(() => {
    onEnterRef.current = onEnter;
  }, [onEnter]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);
  const clearTimers = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  }, []);

  const commitEnter = useCallback(() => {
    if (enteredRef.current) return;
    enteredRef.current = true;
    clearTimers();
    try {
      sessionStorage.setItem("loop-booted", "1");
    } catch {
      /* private mode — ceremony just replays next load */
    }
    // Create the AudioContext inside this user gesture — that is what
    // legitimizes the soundtrack under autoplay policy.
    ensureAudio();
    // Splash → system. The CRT collapse runs (bsp-crt--exit animation),
    // then the terminal loads. No prank, no crawl, no audio gag — the
    // machine asks, you press ENTER, you're in. A short happy POST beep
    // marks the handoff (the one piece of the old rite worth keeping —
    // it's the audio equivalent of the POST stamping OK).
    setPhase("exit");
    // AUDIO HANDOFF (fix for the "system fixed the sound" observation):
    //   The splash's unmount cleanup (useEffect(() => () => stopAllAudio(), []))
    //   calls s.stop() with NO `when` argument on every tracked oscillator —
    //   which per the WebAudio spec stops them IMMEDIATELY (time 0). If
    //   onEnterRef.current() runs in the same JS tick as powerOnThunk() /
    //   postBeep(), React unmounts the splash in that same tick and the
    //   cleanup cuts off the very tones we just scheduled (start at
    //   currentTime + 0.02; cleanup fires in the same microtask). The user
    //   heard nothing — or a 20ms click — and the "boot sound" was
    //   intermittently silent. (You could sometimes hear it because the
    //   audio thread rendered a block before the stop arrived; the result
    //   was inconsistent across reloads.)
    //
    //   Fix: schedule the audio, then defer the unmount by enough time for
    //   the longest tone to actually render. powerOnThunk's tail runs to
    //   ~0.92s; postBeep to ~0.34s. Reduced-motion users get a shorter
    //   handoff (no CRT animation to wait for). The unmount fires AFTER
    //   the audio is in flight, so stopAllAudio() (when it finally runs
    //   on real unmount) only reaps already-finished nodes — exactly the
    //   mercy-escape role it was always meant for.
    later(() => {
      powerOnThunk();
      postBeep();
    }, reducedRef.current ? 120 : 720);
    later(() => {
      onEnterRef.current();
    }, reducedRef.current ? 240 : 1400);
  }, [clearTimers, later]);

  const skip = useCallback(() => {
    if (enteredRef.current) return;
    const p = phaseRef.current;
    if (p === "exit") return;
    if (p === "invite") {
      commitEnter();
      return;
    }
    clearTimers();
    setPhase("invite");
  }, [clearTimers, commitEnter]);

  // Boot machine — runs once on mount. Decides cold vs warm from the
  // session flag, fetches vitals in parallel with the CRT warm-up, and
  // chains the phase transitions. All timers cleaned up on unmount.
  useEffect(() => {
    let alreadyBooted = false;
    let forceBoot = false;
    let disposed = false; // guards async continuations against post-unmount timers
    try {
      alreadyBooted = sessionStorage.getItem("loop-booted") === "1";
      forceBoot = new URLSearchParams(window.location.search).get("boot") === "force";
    } catch {
      /* storage unavailable → treat as cold */
    }
    const isWarm = alreadyBooted && !forceBoot;
    // Async (not synchronously in the effect body) to avoid a cascading
    // render — the value is only needed once "post" shows its lines.
    later(() => setWarm(isWarm), 0);

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedRef.current = mq.matches;

    // Warm boots fetch vitals too now: their POST appends the same nine
    // boot/scan lines after the SESSION RESUMED line. The fetch races
    // the (fast) warm timeline and never blocks it — the first stamp
    // still lands at 650ms; late-arriving values fill their lines in
    // retroactively (POST lines re-render from live state).
    const vitalsP = fetchVitals()
      .then((v) => setVitals(v))
      .catch(() => setVitals(UNKNOWN_VITALS));

    if (isWarm) {
      // Warm boot: quick phosphor flash + the SESSION RESUMED line,
      // then the nine scan lines stamp in — the machine reports its
      // live vitals on EVERY entry — but it still asks. There is no
      // auto-enter: ENTER always runs the full rite (owner's "each
      // time" decree), so the invite is the stop.
      const warmPostAt = reducedRef.current ? 100 : 650;
      later(() => setPhase("post"), warmPostAt);
      // The invite flips in after the last (7th) line stamps + settle.
      later(
        () => setPhase((p) => (p === "post" ? "invite" : p)),
        warmPostAt + (reducedRef.current ? 150 : WARM_POST_MS)
      );
    } else {
      // Cold boot: wait for CRT warm-up AND vitals (≤1.8s), then POST.
      // Same race as before (vitals OR 1850ms, whichever first — proceed
      // once), but BOTH arms are now unmount-safe: the timeout is
      // registered in timers.current so clearTimers cancels it, and the
      // vitals continuation is guarded by `disposed` + a proceed-once
      // flag so a late fetch can't re-arm phase timers after unmount
      // (the old unregistered race timer defeated the cleanup contract).
      let proceeded = false;
      const proceed = () => {
        if (disposed || proceeded) return;
        proceeded = true;
        later(
          () => {
            setPhase("post");
            const postMs = reducedRef.current ? 120 : COLD_POST_MS;
            later(() => setPhase((p) => (p === "post" ? "title" : p)), postMs);
            // Invite flips 120ms AFTER the longest scramble (tagline
            // 1150ms) completes, so the rAF never gets canceled at the
            // boundary and glyphs never freeze mid-noise.
            later(
              () => setPhase((p) => (p === "title" ? "invite" : p)),
              postMs + (reducedRef.current ? 80 : 1270)
            );
          },
          reducedRef.current ? 120 : 700
        );
      };
      const raceTimer = window.setTimeout(proceed, 1850);
      timers.current.push(raceTimer);
      void vitalsP.then(() => {
        window.clearTimeout(raceTimer);
        proceed();
      });
    }
    return () => {
      disposed = true;
      clearTimers();
    };
  }, [clearTimers, later]);

  // POST line stamping — reveal one line per tick while in "post".
  // `warm` is settled (set at mount via a 0ms tick) long before "post"
  // can flip (≥100ms), so reading it here just picks the line count:
  // 17 cold / 10 warm.
  useEffect(() => {
    if (phase !== "post") return;
    const total = warm ? 1 + SCAN_LINE_COUNT : 8 + SCAN_LINE_COUNT;
    // Reset/complete the counter asynchronously (async setState keeps the
    // effect from triggering a cascading render on the same commit).
    const reset = window.setTimeout(() => setShown(reducedRef.current ? 99 : 0), 0);
    let iv = 0;
    if (!reducedRef.current) {
      iv = window.setInterval(() => {
        setShown((s) => {
          if (s >= total) {
            window.clearInterval(iv);
            return s;
          }
          return s + 1;
        });
      }, 130);
    }
    return () => {
      window.clearTimeout(reset);
      if (iv) window.clearInterval(iv);
    };
  }, [phase, warm]);

  // Kill any still-sounding audio when the splash unmounts.
  useEffect(() => () => stopAllAudio(), []);

  // Keyboard: ENTER enters — from ANY phase (2026-11-17 update). The
  // old two-step rite (any key skips → invite → Enter enters) trapped
  // observers who pressed Enter ONCE mid-animation: it only skipped to
  // the invite, leaving a static splash that demanded a second press.
  // One Enter now commits entry directly; every other key still just
  // skips the animation to the invite. No prank phase — every key works
  // everywhere.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const p = phaseRef.current;
      if (p === "exit") {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      if (e.key === "Enter") {
        commitEnter();
        return;
      }
      skip();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [skip, commitEnter]);

  // Focus the invitation button when it appears (keyboard entry point).
  useEffect(() => {
    if (phase === "invite") btnRef.current?.focus({ preventScroll: true });
  }, [phase]);

  const v = vitals;
  // Live clock: ticks once per second ONLY while a countdown is active
  // (the 429 quota gate OR the ARMED-RECOVERING settle window), so the
  // API QUOTA and AUTONOMY lines count down in real time. Anchored on
  // CLIENT-epoch endsAtMs values (set in fetchVitals) — the tick fills
  // the gap between the one-shot vitals fetch and ENTER; no idle
  // re-renders when neither countdown is active (same pattern as the
  // terminal's header chip).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const needsTick =
      vitals.quotaState === "cooling" ||
      (v.livePhase === "ARMED-RECOVERING" && v.recoveryEndsAtMs > 0);
    if (!needsTick) return;
    // Resync the clock to "now" the moment a countdown activates. Deferred
    // to a microtask so it is not a synchronous setState in the effect
    // body (react-hooks/set-state-in-effect); microtasks (and React's
    // follow-up re-render) still drain before the browser paints, so the
    // first countdown frame stays exact.
    queueMicrotask(() => setNowMs(Date.now()));
    const iv = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(iv);
  }, [vitals.quotaState, v.livePhase, v.recoveryEndsAtMs]);
  // One definition of the scan lines feeds both ceremonies.
  const scan = scanPostLines(v, nowMs);
  const postLines: PostLine[] = warm
    ? [
        { label: "WARM BOOT", value: "SESSION RESUMED", stamp: "OK" },
        // The same nine scan lines as cold — the live vitals report on
        // every entry, so a reload never reads as "not updated".
        ...scan,
      ]
    : [
        { label: "CHECKING OBSERVER", value: "HUMAN AT TERMINAL 0", stamp: "OK" },
        {
          label: "MUTATION LEDGER",
          value: `${v.branchesTotal} ON REMOTE · NEXT ${v.nextBranch}`,
          stamp: "OK",
          warn: v.branchesTotal === "??",
        },
        {
          label: "POSTMORTEM CHAIN",
          value: `${v.chainTotal} VERIFIED · ${v.chainBreaks} BROKEN`,
          stamp: "OK",
          warn: v.chainBreaks !== "??" && v.chainBreaks !== "0",
        },
        {
          label: "PROPHECY ENGINE",
          value: `${v.prophecies} SEEDED · ${v.propheciesPending} PENDING`,
          stamp: "OK",
          warn: v.prophecies === "??",
        },
        { label: "LLM CORTEX", value: v.llm, stamp: v.llm === "READY" ? "OK" : "WAIT", warn: v.llm !== "READY" },
        { label: "HOT-SWAP BAY", value: `${v.swaps} SWAP(S) THIS BOOT`, stamp: "OK", warn: v.swaps === "??" },
        { label: "UPLINK", value: v.repo, stamp: "LINK", link: v.repo && v.repo !== "unlinked" && v.repo !== "??" ? `https://github.com/${v.repo}` : undefined },
        { label: "CYCLE COUNTER", value: `${v.cycles} COMPLETED`, stamp: "OK", warn: v.cycles === "??" },
        // ── boot/scan additions — appended AFTER the original 8, which are
        // byte-for-byte untouched above (operator: "enhance without changing
        // what's there"). Lines 9-15: auto-connect identity, provider
        // quota gate (live countdown), sealed-token
        // vault, total mutations + failures, live hot-swap success, autonomy.
        ...scan,
      ];

  const pad = (label: string, value: string) => {
    const dots = ".".repeat(Math.max(3, 24 - label.length));
    return `${label} ${dots} ${value}`;
  };

  const showTitle = phase === "title" || phase === "invite" || phase === "exit";
  const showInvite = phase === "invite" || phase === "exit";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="LOOP boot sequence — press Enter to enter the Loop (any other key skips the boot animation)"
      className={`bsp-root${phase === "exit" ? " bsp-root--exiting" : ""}`}
      onClick={skip}
    >
      <h2 className="sr-only">
        LOOP — a machine that rewrites its own code. Boot diagnostics: {postLines.length} checks.
        Press Enter to enter the Loop — any other key skips the boot animation.
      </h2>

      <div
        className={[
          "bsp-crt bsp-text",
          phase === "flash" ? "bsp-crt--flash" : "",
          phase === "exit" ? "bsp-crt--exit" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {showTitle && (
          <>
            <pre className={`bsp-logo${showInvite ? " bsp-jitter" : ""}`} aria-hidden>
              <Scramble text={ASCII_LOOP} start={phase === "title"} ms={1000} />
            </pre>
            <div className="bsp-tagline">
              <Scramble text={TAGLINE} start={phase === "title"} ms={1150} />
            </div>
            <div className="bsp-rule">{"─".repeat(64)}</div>
          </>
        )}

        <div className="bsp-post" aria-hidden>
          {(phase === "flash" ? [] : phase === "post" ? postLines.slice(0, shown) : postLines).map((l, i) => {
            // Honesty rule: an unreadable vital never stamps OK.
            const unknown = l.value.includes("??") || l.value === "unlinked";
            return (
              <div key={`${l.label}-${i}`} className={i === 0 && warm ? "bsp-dim" : undefined}>
                {i === 0 && !warm ? (
                  <span className="bsp-dim">LOOP SYSTEMS BIOS v4.2 — COLD BOOT</span>
                ) : (
                  <>
                    {l.link ? (
                      <>
                        {l.label} {".".repeat(Math.max(3, 24 - l.label.length))}{" "}
                        <a
                          href={l.link}
                          target="_blank"
                          rel="noreferrer"
                          className="bsp-link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {l.value}
                        </a>
                      </>
                    ) : (
                      pad(l.label, l.value)
                    )}{" "}
                    <span className={unknown || l.warn ? "bsp-wait" : "bsp-ok"}>
                      [{` ${unknown ? "??" : l.stamp} `}]
                    </span>
                  </>
                )}
              </div>
            );
          })}
          {phase === "post" && !warm && shown === 0 && (
            <div className="bsp-dim">LOOP SYSTEMS BIOS v4.2 — COLD BOOT</div>
          )}
          {/* Heartbeat while the machine reads its own vitals (the ledger
              check reaches out to GitHub and can take ~2s). The POST is
              not dead air — it is the machine feeling for a pulse. */}
          {phase === "flash" && (
            <div className="bsp-dim bsp-selfscan">
              SELF-SCAN <span className="bsp-cursor">▮</span>
            </div>
          )}
        </div>

        {showInvite && (
          <div className="bsp-invite">
            <div className="bsp-rule">{"─".repeat(64)}</div>
            <div>YOU ARE THE OBSERVER.</div>
            <div className="bsp-dim">IT JOURNALS. IT PREDICTS. IT DEFENDS. IT DOES NOT SLEEP.</div>
            <div className="bsp-dim">IT HARVESTS. IT GAUNTLETS. IT GETS CURIOUS. IT ASKS.</div>
            <div className="bsp-invite-actions">
              <button
                ref={btnRef}
                type="button"
                className="bsp-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  commitEnter();
                }}
              >
                [ ▶ ENTER THE LOOP ]
              </button>
            </div>
          </div>
        )}
      </div>

      {phase !== "exit" && (
        <div className="bsp-hint bsp-dim" aria-hidden>
          {phase === "invite"
            ? "ENTER ⏎"
            : "▌ ENTER ⏎ TO ENTER · ANY OTHER KEY SKIPS"}
        </div>
      )}

      {/* CRT dressing — scanlines, phosphor band, flicker, vignette */}
      <div className="bsp-scan" aria-hidden />
      <div className="bsp-band" aria-hidden />
      <div className="bsp-flicker" aria-hidden />
      <div className="bsp-vignette" aria-hidden />

      <style>{`
        .bsp-root {
          position: fixed; inset: 0; z-index: 1000;
          background: #000; color: #ffb000;
          font-family: 'Courier New', 'Lucida Console', monospace;
          font-size: 13px; line-height: 1.55;
          display: flex; align-items: center; justify-content: center;
          overflow: hidden; cursor: pointer; user-select: none;
          -webkit-tap-highlight-color: transparent;
        }
        /* Once the user has committed to enter (phase === "exit"), the splash
           is already leaving — stop it from intercepting clicks meant for the
           terminal underneath during the ~1.4s CRT-collapse animation. Without
           this, a second click on a UI control (e.g. the saturation panel's
           [unlock] button) lands on the still-visible exiting splash and is
           swallowed — the user perceives the underlying button as dead. */
        .bsp-root--exiting { pointer-events: none !important; }
        /* Fluid height fit: font-size is capped by viewport height (the
           full ceremony measures ~53em top-to-bottom), and every inner
           size below is expressed in em so the whole CRT scales as one
           block. At ≥~700px of height this is byte-for-byte the old
           13px layout; below it the ceremony shrinks instead of
           clipping the ENTER button out of frame. */
        .bsp-crt {
          width: 100%; max-width: 980px; padding: 1.85em 2.15em;
          font-size: clamp(8px, calc(100vh / 56), 13px);
          transform-origin: 50% 50%;
        }
        .bsp-crt--flash { animation: bsp-on 700ms cubic-bezier(.2,.7,.3,1) both; }
        .bsp-crt--exit  { animation: bsp-off 650ms ease-in both; }
        .bsp-text { text-shadow: 0 0 8px rgba(255,176,0,.35), 0 0 2px rgba(255,176,0,.8); }
        .bsp-post { min-height: ${(warm ? 1 + SCAN_LINE_COUNT : 8 + SCAN_LINE_COUNT) * 1.55}em; white-space: pre; overflow-x: auto; }
        .bsp-link { color: #ffd875; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
        .bsp-link:hover { color: #fff; text-shadow: 0 0 8px rgba(255,255,255,.4); }
        .bsp-post::-webkit-scrollbar { height: 6px; }
        .bsp-post::-webkit-scrollbar-thumb { background: rgba(255,176,0,.4); }
        .bsp-post::-webkit-scrollbar-track { background: transparent; }
        .bsp-dim { color: rgba(255,176,0,.55); }
        .bsp-ok { color: #ffd875; }
        .bsp-wait { color: #ff6a3d; }
        .bsp-rule { color: rgba(255,176,0,.3); white-space: nowrap; overflow: hidden; margin: 0.46em 0; }
        .bsp-logo {
          margin: 0 auto 0.67em; font-family: inherit; font-size: clamp(0.46em, 2.4vw, 1.15em);
          line-height: 1.06; white-space: pre; overflow: hidden;
          text-shadow: -2px 0 rgba(255,70,0,.5), 2px 0 rgba(255,230,150,.35), 0 0 16px rgba(255,176,0,.45);
        }
        .bsp-jitter { animation: bsp-jitter 3.2s steps(2) infinite; }
        .bsp-tagline { font-size: clamp(0.77em, 1.6vw, 1.08em); letter-spacing: 2px; margin-bottom: 0.29em; }
        .bsp-invite { margin-top: 0.62em; }
        .bsp-invite-actions { margin-top: 1.23em; display: flex; justify-content: center; }
        .bsp-btn {
          font-family: inherit; font-size: 1.15em; letter-spacing: 1px;
          background: #000; color: #ffb000; border: 1px solid #ffb000;
          padding: 0.8em 1.73em; cursor: pointer;
          text-shadow: 0 0 10px rgba(255,176,0,.6);
          animation: bsp-pulse 1.4s ease-in-out infinite;
        }
        .bsp-btn:hover, .bsp-btn:focus-visible {
          background: #ffb000; color: #000; text-shadow: none;
          box-shadow: 0 0 24px rgba(255,176,0,.55); outline: none;
        }
        .bsp-hint {
          position: absolute; bottom: 18px; left: 0; right: 0;
          text-align: center; font-size: 11px; letter-spacing: 1px;
          animation: bsp-blink 1.2s steps(1) infinite;
        }
        .bsp-selfscan { letter-spacing: 2px; }
        .bsp-cursor { animation: bsp-blink .9s steps(1) infinite; }
        @keyframes bsp-on {
          0%   { transform: scaleY(.003) scaleX(.7); filter: brightness(24); }
          30%  { transform: scaleY(.003) scaleX(1);  filter: brightness(18); }
          55%  { transform: scaleY(1);               filter: brightness(3.2); }
          75%  { filter: brightness(1.6); }
          100% { transform: none; filter: none; }
        }
        @keyframes bsp-off {
          0%   { transform: none; filter: none; opacity: 1; }
          55%  { transform: scaleY(.004); filter: brightness(14); opacity: 1; }
          78%  { transform: scaleY(.004) scaleX(.002); filter: brightness(30); opacity: 1; }
          100% { transform: scaleY(.001) scaleX(.001); filter: brightness(40); opacity: 0; }
        }
        @keyframes bsp-pulse {
          0%, 100% { box-shadow: 0 0 8px rgba(255,176,0,.15); }
          50%      { box-shadow: 0 0 22px rgba(255,176,0,.45); }
        }
        @keyframes bsp-blink { 0%, 60% { opacity: 1; } 61%, 100% { opacity: .25; } }
        @keyframes bsp-jitter {
          0%, 92%, 100% { transform: none; }
          93% { transform: translate(1px,-1px) skewX(.4deg); }
          96% { transform: translate(-1px,1px); }
        }
        .bsp-scan {
          position: absolute; inset: 0; pointer-events: none;
          background: repeating-linear-gradient(0deg, rgba(0,0,0,.28) 0 1px, transparent 1px 3px);
        }
        .bsp-band {
          position: absolute; left: 0; right: 0; top: -140px; height: 120px; pointer-events: none;
          background: linear-gradient(180deg, transparent, rgba(255,176,0,.05), transparent);
          animation: bsp-band 7s linear infinite;
        }
        .bsp-flicker {
          position: absolute; inset: 0; pointer-events: none;
          background: #ffb000; mix-blend-mode: overlay; opacity: 0;
          animation: bsp-flicker 4s steps(1) infinite;
        }
        .bsp-vignette {
          position: absolute; inset: 0; pointer-events: none;
          background: radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,.55) 100%);
        }
        @keyframes bsp-band { from { top: -140px; } to { top: 110%; } }
        @keyframes bsp-flicker {
          0%, 96%, 100% { opacity: 0; }
          97% { opacity: .02; } 98% { opacity: .04; } 99% { opacity: .02; }
        }

        /* Width tiers keep their old pixel sizes but now also yield to
           the height budget (phone LANDSCAPE used to clip the ceremony
           top AND bottom — width fit alone was never enough). */
        @media (max-width: 640px) {
          .bsp-crt { padding: 1.25em 1em; font-size: min(8px, calc(100vh / 56)); }
        }
        @media (max-width: 360px) {
          .bsp-crt { padding: 1.14em 0.86em; font-size: min(7px, calc(100vh / 56)); }
        }
        /* Tight frame: the bottom-corner ENTER hint sits where the
           (now near-full-height) invite button renders — drop it, the
           button is its own affordance. The sr-only heading keeps the
           keyboard instruction for screen readers. */
        @media (max-height: 560px) {
          .bsp-hint { display: none; }
        }
        /* Last resort below the 8px font floor's fit (~430px): stop
           centering (a centered flex child that overflows its container
           is unreachable by scroll) and let the root scroll instead, so
           the ENTER button can never be clipped out of existence. */
        @media (max-height: 430px) {
          .bsp-root { align-items: flex-start; overflow-y: auto; }
        }
        @media (prefers-reduced-motion: reduce) {
          .bsp-crt--flash, .bsp-crt--exit, .bsp-band, .bsp-flicker,
          .bsp-btn, .bsp-jitter, .bsp-hint { animation: none !important; }
        }
      `}</style>
    </div>
  );
}
