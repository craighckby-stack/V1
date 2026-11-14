/**
 * Boot vitals — the data layer of the boot splash (audit H2 refactor:
 * types, the live-vitals fetch, and the POST-line mapping lived inside
 * the 990-line BootSplash component file; they are pure data logic with
 * no JSX and now live here. The component imports them.
 */

export type Json = Record<string, unknown>;

/** One POST line: label … value … [stamp]. warn=true renders the value
 *  in the alarm color. */
export interface PostLine {
  label: string;
  value: string;
  stamp: string;
  warn?: boolean;
  link?: string;
}

export interface Vitals {
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

export const UNKNOWN_VITALS: Vitals = {
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

export function gateClock(remainingMs: number): string {
  const s = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Fetch the machine's live vitals. Each endpoint gets its own timeout —
 *  the GitHub-backed ledger is slower and must not be killed by the fast
 *  local endpoints' budget. Any failure degrades to "??" — the POST still
 *  stamps, honestly marking what it could not read. */
export async function fetchVitals(): Promise<Vitals> {
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

/** The seven boot/scan vitals lines — ONE definition, used by both
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
export function scanPostLines(v: Vitals, nowMs: number): PostLine[] {
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
      value: `${v.branchesTotal} SUCCEEDED · ${v.scars} FAILED`,
      stamp: "OK",
      warn: v.branchesTotal === "??" || v.scars === "??",
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
