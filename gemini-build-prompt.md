# GEMINI STUDIO BUILD PROMPT — "LOOP" Self-Improvement System (LLM layer → Gemini)

> **How to use:** Paste everything below the cut line into Google AI Studio as a
> single prompt (system + user combined). It tells Gemini to rebuild the entire
> system faithfully, with **one** intentional delta: the LLM provider layer is
> Gemini (`@google/genai`) instead of the original `z-ai-web-dev-sdk`. Everything
> else — pipeline stages, rate-limit gate, saturation locking, persistence,
> display hot-swap, API surface, UI — is specified exactly as it must ship.

---

## ROLE

You are a senior staff engineer. You will build a complete, production-grade
Next.js application called **LOOP** — an autonomous self-improvement system
that scans its own source files, asks an LLM to refactor them, runs an AST
diff gate + ratchet tests to reject bad mutations, and pushes each accepted
mutation to its own `loop-NN` branch on GitHub. Output the full project as a
set of file paths with their complete contents. Do not abbreviate, do not use
"…existing code…", do not omit tests. Every file must be complete and runnable.

## NON-NEGOTIABLE STACK

- **Next.js 16**, App Router, TypeScript 5 (strict).
- **Tailwind CSS 4** + **shadcn/ui** (New York style) + **lucide-react** icons.
- **Prisma ORM** with **SQLite** (`prisma/dev.db`).
- **Zustand** for client state, **TanStack Query** for server state.
- **`@google/genai`** (Google GenAI SDK) as the **only** LLM provider — this
  replaces the original project's `z-ai-web-dev-sdk`. No other LLM SDK.
- All API routes that touch the LLM, the filesystem, or `child_process` MUST
  declare `export const runtime = "nodejs";` and `export const dynamic =
  "force-dynamic";`.
- Only one user-visible route: `/` (in `src/app/page.tsx`). No other pages.

## THE SYSTEM IN ONE PARAGRAPH

A single-page dashboard (`/`) shows a live console of an autonomous loop that
runs in the server process. Each **cycle**: (1) scan an allowlist of target
files; (2) for one file, pin a ratchet test snapshot; (3) ask the LLM to enhance
it under a strict output contract; (4) parse the LLM's code, run an **AST diff
gate** that rejects any mutation dropping exported symbols; (5) run a debate
(Security + Architecture reviewers) that can REJECT or DEFER; (6) if both
reviewers endorse, write the file, commit, and push to a new `loop-NN` branch
on GitHub. A **rate-limit gate** pauses the whole loop when the LLM returns 429,
with an escalating cooldown (2→5→15→30 min) and a live countdown chip in the UI.
A **saturation tracker** locks a file after 3 consecutive no-growth cycles so
the loop doesn't spin on a file that can't be improved further. The user can
unlock a saturated file from the UI.

## DIRECTORY STRUCTURE (build exactly this)

```
src/
  app/
    page.tsx                      # the ONLY route — the dashboard
    api/
      self-enhance/
        start/route.ts            stop/route.ts
        status/route.ts           rescan/route.ts
        trigger/route.ts          files/route.ts
        tasks/route.ts            skip/route.ts
        push/route.ts             push-target/route.ts
        llm-config/route.ts       unlock/route.ts
        chat-task/propose/route.ts   chat-task/apply/route.ts
      autonomous/
        start/route.ts   stop/route.ts   status/route.ts
        config/route.ts  trigger/route.ts  recent-cycles/route.ts
      github/
        validate-token/route.ts   fetch-file/route.ts
        commit-file/route.ts      batch-commit/route.ts   repo-tree/route.ts
      emg/sanitize/route.ts
      evolution/debate/route.ts   evolution/coherence-gate/route.ts
      engines/catalog/route.ts
      memory/entries/route.ts     memory/query/route.ts
      pipeline/run/route.ts       pipeline/history/route.ts
      postmortems/route.ts        postmortems/seed/route.ts
      health/route.ts
    display/
      console-stream.tsx          # HOT-SWAP display target (the only one)
  lib/
    db.ts                          # exports Prisma `db` client
    pipeline/
      llm/
        agent-llm.ts               # llmComplete + rate-limit gate + serialization queue
        gemini.ts                  # ★ THE DELTA: Gemini adapter (was z-ai)
        debate-llm.ts               # conducts Security+Architecture debate
        mock-llm.ts                 # default no-op provider (cosmetic-safe)
      autonomous/
        self-enhance-loop.ts        # the main loop class + runCycle
        saturation.ts              # ★ TARGET_FILES allowlist + 3-strike lock
        push-target.ts             # GitPushTarget persistence (file-first)
        self-task-generator.ts      # generates the work queue
        task-executor.ts            code-analysis.ts
        structural-validator.ts     protected-files.ts
        in-memory-typecheck.ts      loop-event-bus.ts  loop-runtime.ts
        chat-task.ts                verify-refactor.ts
      core/
        unified-pipeline.ts         ast-diff-gate.ts
        binaryShield.ts             siphon.ts
      emg/
        debate.ts   emg-rag.ts   halt.ts   sanitizer.ts
      engines/clean-room-runtime.ts
      postmortem/
        postmortem-repo.ts   postmortem-store.ts
      api/github-helpers.ts
prisma/
  schema.prisma
  dev.db
```

## PRISMA SCHEMA (exact models)

```
model GitPushTarget {
  id              String   @id @default("singleton")
  repo            String                     // "owner/name"
  token           String                     // classic PAT ghp_… or fine-grained github_pat_…
  branch          String   @default("main")  // seed branch; each enhancement forks a loop-NN off it
  createdRepo     Boolean  @default(false)
  lastPushAt      DateTime?
  lastPushSha     String?
  lastPushError   String?
  lastBranchNumber Int     @default(0)        // Nth successful enhancement → next is loop-{N+1}
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model LlmConfig {
  id            String    @id @default("singleton")
  geminiApiKey  String                     // AIza… (39 chars). Stored server-side only.
  geminiModel   String    @default("gemini-2.5-flash")
  lastUsedAt    DateTime?
  lastError     String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
}

model RatchetSnapshot {
  id        String   @id @default(cuid())
  filePath  String                       // repo-relative
  hash      String                       // sha256 of the file at pin time
  exportedSymbols String  // JSON array of exported symbol names (the ratchet floor)
  pinnedAt  DateTime @default(now())
}

model SelfEnhanceTask {
  id          String  @id @default(cuid())
  filePath    String
  instruction String
  status      String  @default("pending")  // pending|done|skipped
  createdAt   DateTime @default(now())
}

model Postmortem {
  id        String  @id @default(cuid())
  cycle     Int
  filePath  String
  reason    String
  payload   String  // JSON
  createdAt DateTime @default(now())
}
```

Datasource: `provider = "sqlite"`, `url = env("DATABASE_URL")` where
`DATABASE_URL = "file:./prisma/dev.db"`.

## THE LLM LAYER — THIS IS THE ONLY DELTA FROM THE ORIGINAL

The original project used `z-ai-web-dev-sdk`. **You replace that single
dependency with `@google/genai`** (the official Google GenAI TypeScript SDK).
Everything else about the contract below is identical.

### `src/lib/pipeline/llm/agent-llm.ts` — the public contract (preserve EXACTLY)

Export these names and shapes; every other module imports from here:

```ts
export interface LlmCallOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  onRetry?: (info: {
    attempt: number; maxAttempts: number;
    isRateLimit: boolean; delayMs: number; error: string;
  }) => void;
}

export interface LlmCallResult {
  ok: boolean;
  content: string;
  error?: string;
  attempts: number;
  latencyMs: number;
  rateLimited?: boolean;   // true ⇒ caller DEFERS, does not burn the file
  modelUsed?: string;       // honest provenance from the API response
}

export interface LlmGateInfo {
  active: boolean;
  remainingMs: number;
  endsAtMs: number;         // UI ticks against this epoch ms
  level: number;            // 1=2min, 2=5min, 3=15min, 4=30min
}

export function llmComplete(opts: LlmCallOptions): Promise<LlmCallResult>;
export function llmCooldownMs(): number;
export function llmIsCoolingDown(): boolean;
export function llmClearGate(): void;
export function llmGateInfo(): LlmGateInfo;
export function extractSummaryAndCode(raw: string): { summary: string; code: string };
```

### Rate-limit gate + serialization queue (build EXACTLY this behavior)

- Module-level state: `let blockedUntil = 0; let strikes = 0;`
- `COOLDOWNS_MS = [2,5,15,30].map(m => m*60_000)` → 2/5/15/30 minutes.
- On a 429 (or any error matching `/\b429\b|too many requests|rate.?limit/i`):
  set `blockedUntil = now + COOLDOWNS_MS[Math.min(strikes,3)]`, then
  `strikes = Math.min(strikes + 1, 3)`. Return `rateLimited: true`.
- On any **success**: `strikes = 0` (one good call de-escalates).
- **Serialization queue** (critical): a module-level `llmCallQueue: Promise<unknown>`
  chains EVERY `llmComplete` call so the gate check sees the previous call's
  outcome. Parallel callers (the debate tribunal uses `Promise.all` for
  Security + Architecture) MUST NOT both pass the gate check before either
  finishes. Implement: `const run = llmCallQueue.then(() => performLlmComplete(opts));`
  `llmCallQueue = run.then(()=>{}, ()=>{}); return run;`
- `llmComplete` enters the body, checks `llmCooldownMs() > 0` → if so, returns
  immediately `{ ok:false, content:"", rateLimited:true, attempts:0, ... }`.
  No in-call retries during an active gate.
- In-call retries: `maxAttempts = 2`. On attempt 1 failure with a 429, short
  backoff 2s ±20% jitter (NOT 10s — the gate handles the long wait). On a
  non-429 error: 400ms, 800ms. Honour a `retry-after` header if present and ≤10s.
  Fire `opts.onRetry` before sleeping.

### `src/lib/pipeline/llm/gemini.ts` — the Gemini adapter (THE NEW FILE)

```ts
import { GoogleGenAI } from "@google/genai";
import { db } from "@/lib/db";

const SINGLETON_ID = "singleton";

interface GeminiCfg { apiKey: string; model: string; }

export async function getGeminiConfig(): Promise<GeminiCfg | null> {
  const row = await db.llmConfig.findUnique({ where: { id: SINGLETON_ID } }).catch(() => null);
  if (!row || !row.geminiApiKey) return null;
  return { apiKey: row.geminiApiKey, model: row.geminiModel || "gemini-2.5-flash" };
}

// Geo fast-fail: if Google returns FAILED_PRECONDITION "location is not
// supported", set a 10-min in-memory cooldown so the loop short-circuits
// instead of burning a request per file per cycle while geo-blocked.
let LOCATION_BLOCKED_UNTIL = 0;
const LOCATION_COOLDOWN_MS = 10 * 60_000;

export function geminiLocationBlocked(): boolean {
  return LOCATION_BLOCKED_UNTIL > Date.now();
}

/** Single-shot Gemini call. Returns the raw text. Throws on 429/geo/network. */
export async function geminiGenerate(opts: {
  systemPrompt: string; userPrompt: string;
  maxTokens?: number; temperature?: number;
}): Promise<{ content: string; modelUsed: string }> {
  if (LOCATION_BLOCKED_UNTIL > Date.now()) {
    throw new Error("Gemini location-blocked cooldown active");
  }
  const cfg = await getGeminiConfig();
  if (!cfg) throw new Error("Gemini not configured");

  const ai = new GoogleGenAI({ apiKey: cfg.apiKey });
  const resp = await ai.models.generateContent({
    model: cfg.model,
    contents: opts.userPrompt,
    config: {
      systemInstruction: opts.systemPrompt,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { maxOutputTokens: opts.maxTokens } : {}),
    },
  });
  const content = resp.text ?? "";
  if (!content.trim()) throw new Error("Empty Gemini response");
  return { content, modelUsed: cfg.model };
}

/** Called by agent-llm's catch path to record a geo block. */
export function noteLocationBlocked(): void {
  LOCATION_BLOCKED_UNTIL = Date.now() + LOCATION_COOLDOWN_MS;
}
```

Wire `agent-llm.ts`'s `performLlmComplete` to call `geminiGenerate` instead of
the z-ai SDK. On a catch: if the error matches `/FAILED_PRECONDITION|location/i`,
call `noteLocationBlocked()` and return `{ ok:false, rateLimited:true, ... }`
(so the loop defers cleanly). Otherwise run the normal 429-detection regex.

### `src/lib/pipeline/llm/mock-llm.ts` — the default no-op provider

When no Gemini key is configured, `agent-llm.ts` returns a deterministic,
**cosmetic-only** result that the AST diff gate will reject:
`{ ok:true, content:"// No changes needed\nexport {}; // mock", modelUsed:"mock" }`.
This keeps the loop alive and honest (it shows "Rejected by gate: no symbol
changes") instead of crashing on a missing key. **The mock must never produce a
plausible mutation** — it must obey the output contract format but yield zero
semantic growth, so the saturation tracker classifies it as no-growth.

### Output contract (every LLM prompt must require this envelope)

The system prompt sent to Gemini must demand:
```
Return EXACTLY this envelope (no prose before/after):

SUMMARY: <one line, ≤80 chars>
REASON: growth|no-growth|neutral   (one of these three tokens)
<<<CODE>>>
<the complete new file contents, nothing omitted>
<<<END>>>
```
`extractSummaryAndCode(raw)` parses the `SUMMARY:` line and the text between
`<<<CODE>>>` and `<<<END>>>`. If either is missing, return `{ summary:"parse
failed", code:"" }` — the caller treats empty code as a non-mutation.

### `src/app/api/self-enhance/llm-config/route.ts` — key verification (preserve this logic)

`runtime = "nodejs"`, `dynamic = "force-dynamic"`.
- **POST** `{ geminiApiKey, model? }` (default model `gemini-2.5-flash`):
  - Reject keys <20 chars or containing whitespace.
  - Verify with one minimal `generateContent` call to
    `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}`
    body `{ contents:[{role:"user",parts:[{text:"say OK"}]}], generationConfig:{maxOutputTokens:5,temperature:0} }`.
  - Map Google's error envelope `{ error:{ code, message, status } }`:
    - 200 → save, return `{ ok:true, verified:true }`.
    - 429 → save anyway (quota is temporary), return `{ ok:true, verified:false, warning:"quota temporarily exhausted" }`.
    - 400/403 with `status==="FAILED_PRECONDITION"` and `/location/i.test(message)` → **save anyway** (the key is valid; the egress region is geo-blocked). Return `{ ok:true, verified:false, locationBlocked:true, warning:"Key valid but region not supported; will work from a supported region" }`.
    - 400/403/401 with `INVALID_ARGUMENT` / `PERMISSION_DENIED` mentioning "api key" → reject `{ ok:false, error:"Key rejected by Google: …" }` status 400.
  - Persist via `db.llmConfig.upsert({ where:{id:"singleton"}, ... })`.
- **GET** → `{ configured:bool, model?, lastUsedAt?, lastError? }` (NEVER the key).
- **DELETE** → `db.llmConfig.deleteMany({ where:{ id:"singleton" } })`.

## THE AUTONOMOUS LOOP — `self-enhance-loop.ts`

A class `SelfEnhanceLoop` with a single `runCycle()` method, driven by a
setInterval or a manual trigger. State stored in the module singleton.

### `runCycle()` (exact control flow)

1. **Gate pause**: if `llmIsCoolingDown()`, log `"⏳ LLM COOLDOWN {level} {MM:SS}"`
   and return WITHOUT scanning files (a blocked cycle burns zero requests —
   the whole cycle is skipped, not just one file).
2. **Scan**: `scanFiles()` walks `src/` but **filters to `TARGET_FILES`**
   (see saturation.ts). If `TARGET_FILES` is empty, the loop is disabled
   (log and return).
3. **Per file** (in priority order from the task queue):
   - If the file is **locked** (saturated), skip it.
   - If the gate went active mid-cycle, `break` the for-loop (one cooldown
     window burns ONE 429, not one-per-file).
   - Call `enhanceFile(path)`.
4. After all files: classify each result for saturation, update the
   `SaturationMap`, log a cycle summary.

### `enhanceFile(relPath)` (6 stages)

1. **Ratchet pin**: hash the file, record its exported symbol names in
   `RatchetSnapshot`. This is the floor — the gate will reject any mutation
   that drops a pinned symbol.
2. **LLM enhance**: build a system prompt enforcing the output envelope (above)
   + "preserve every exported symbol, change behaviour not surface, no
   cosmetic-only edits". Call `llmComplete`. If `rateLimited` → return a
   `Deferred (rate-limit)` result (counts as neutral for saturation, NOT
   no-growth). If `ok:false` → `Deferred (LLM unavailable)` (neutral).
3. **Parse + AST diff gate**: `extractSummaryAndCode`, then `astDiffGate(old,
   newCode)` rejects if any pinned exported symbol is missing OR the AST is
   unchanged (cosmetic-only). Reject → `Rejected by gate` (no-growth).
4. **Debate**: `conductLlmDebate(newCode)` runs Security + Architecture
   reviewers via `Promise.all` (both go through the serialization queue).
   Each returns `ENDORSE` / `APPROVED` / `REJECTED` / `DEFER`. Outcomes:
   - Any `REJECTED` → `Rejected (debate)` (no-growth).
   - Any `DEFER` (quota/debate) → `Deferred (debate)` (neutral).
   - Both `ENDORSE`/`APPROVED` → proceed.
5. **Write + commit + push**: write the file, `git add`, commit with message
   `Self-enhancement: {relPath}`, then push to a new branch computed as
   `loop-{(getLastBranchNumber()+1).padStart(2,"0")}`. On push success,
   `setLastBranchNumber(n+1)`. If push fails with a non-fast-forward, run the
   self-heal fetch-then-merge (see persistence).
6. **Result classification** feeds `saturation.ts.classifyGrowth(reason)`:
   - **growth**: reason starts with `Enhanced`
   - **no-growth**: `No issues found`, `Skipped (only cosmetic`, `Rejected*`,
     `LLM returned no code`, `Deferred (debate`, `Error`
   - **neutral**: `Deferred (quota`, `LLM unavailable`, `Stopped`, `Skipped
     (file too large`

## RATE-LIMIT PAUSE + COUNTDOWN UI (the audit-2 fixes — build exactly)

- The loop's `runCycle` checks `llmCooldownMs()` BEFORE scanning. If >0, the
  whole cycle is skipped (zero requests burned during a cooldown window).
- If the gate activates MID-cycle (a file's LLM call returns `rateLimited`),
  the for-loop `break`s immediately so the remaining files in that cycle
  don't each burn a 429.
- `waitForCooldown()` (between cycles) logs progress every 60s.
- "Consecutive cooldown" exit condition = "zero enhancements AND at least one
  defer this cycle" (not "all files deferred").
- The **status API** exposes `llmGate` = `llmGateInfo()` and the UI renders a
  chip: `⏳ LLM COOLDOWN MM:SS` anchored to `endsAtMs` (client ticks every
  second). When inactive, the chip is hidden. Escalation level is shown as a
  small badge (L1/L2/L3/L4).

## SATURATION / SINGLE-FILE LOCKING — `saturation.ts`

```ts
export const TARGET_FILES: string[] = ["src/app/display/console-stream.tsx"];
// Allowlist. Empty array ⇒ loop disabled (no scanning). Add a file here to
// focus the loop on it. This is the "single-file saturation" model: the loop
// works one module at a time until it stops growing, then locks it.

export const SATURATION_THRESHOLD = 3;

export interface FileSaturation {
  path: string;
  consecutiveNoGrowth: number;
  locked: boolean;
  lastReason: string;
}
export type SaturationMap = Record<string, FileSaturation>;

export function classifyGrowth(reason: string): "growth" | "no-growth" | "neutral";
// growth     ⇒ reason startsWith "Enhanced"
// no-growth  ⇒ startsWith any of: "No issues found","Skipped (only cosmetic",
//             "Rejected","LLM returned no code","Deferred (debate","Error"
// neutral    ⇒ everything else (quota defers, unavailable, stopped, file-too-large)

export function scanFiles(): string[];
// Walks src/ but filters to TARGET_FILES only. Returns the allowlist
// intersection (so an empty allowlist ⇒ [], and the loop's runCycle returns
// early with "no target files").

export function getSaturation(): SaturationMap;
export function unlockFile(path: string): void;  // resets consecutiveNoGrowth=0, locked=false
```

- `runCycle`: skip locked files; classify each result; 3 consecutive
  no-growth ⇒ `locked = true` and log `🔒 SATURATED {path}`.
- Detect the literal string `PASS COMPLETE` in the LLM's `REASON:` line as an
  immediate permanent-lock signal (the model declares the file is done).
- **Status API** exposes `saturation: SaturationMap`.
- **New route** `POST /api/self-enhance/unlock { filePath }` calls
  `unlockFile()` and returns `{ ok:true }`.
- **UI panel**: `SATURATION ▪ {filename} (N/3)` per file with an `[unlock]`
  button; a `🎯 PASS COMPLETE` badge when a file self-declared done.

## PERSISTENCE — `push-target.ts` (file-first, bidirectional self-heal)

- **State file** `.loop-push-state.json` (chmod 0600, gitignored) with fields
  `repo, token, branch, createdRepo, lastBranchNumber, savedAt`.
- **DB** `GitPushTarget` singleton row mirrors the same fields + audit cols.
- **Write order (file-first)**: when configuring a target, write the JSON
  file FIRST, THEN upsert the DB row. If the DB write fails, the file is
  still authoritative and the next read rehydrates the DB.
- **Delete order (file-first)**: when clearing, delete the JSON file FIRST,
  then delete the DB row, THEN `git remote remove origin`. If the DB is
  already gone (rollback), file-first prevents a zombie PAT staying in git
  config.
- **Bidirectional self-heal on read**: `getPushTarget()` reads the DB row; if
  the row exists but the JSON file is missing, rewrite the JSON from the DB;
  if the JSON exists but the DB row is missing, rehydrate the DB from the
  JSON. Either side can survive a rollback of the other.
- **Auth**: never put the token in `git remote` URL or `git config` visible
  fields. Set `http.https://github.com/.extraheader = "Authorization: Basic
  base64(x-access-token:<PAT>)"` for push operations only, and strip it after.
- **Branch numbering**: `formatLoopBranch(n) = "loop-" + n.padStart(2,"0")`
  (loop-01..loop-99, then loop-100). `getLastBranchNumber()` reads from DB
  (falling back to the state file). Bump ONLY after a push succeeds.
- **Push self-heal**: if a push is rejected as non-fast-forward, `git fetch
  origin {branch}`, merge the remote tip into the local branch (preserving
  remote commits as ancestors — no force, nothing orphaned), then retry the
  push. At most one retry.

## DISPLAY HOT-SWAP vs ENGINE FREEZE

- **Engine files** (`src/lib/pipeline/**/*.ts`) are **frozen at runtime** —
  the loop reads them as text for analysis but a mutation only takes effect
  after a server restart. The loop does NOT hot-reload its own pipeline.
- **Display files** (`src/app/display/*.tsx`) ARE hot-swapped: Turbopack HMR
  makes a committed mutation visible in the browser within ~100ms. This is
  why `TARGET_FILES` defaults to `src/app/display/console-stream.tsx` — the
  user can SEE the loop improve the live console component in real time.
- `console-stream.tsx` renders the live event stream (a Zustand store fed by
  the SSE/polling status endpoint) with monospace lines, colour by log level,
  auto-scroll, and a max-height scroll region with a custom scrollbar.

## RATCHET TESTS

- Before an enhancement, record the file's exported symbol names + a sha256
  of its AST (not its text — whitespace shouldn't matter).
- After the LLM produces new code, parse it and assert: every pinned symbol
  is still exported, AND the AST actually changed (reject cosmetic-only).
- A rejected mutation is logged and counted toward saturation (no-growth);
  the file is NOT written.

## SUBSYSTEMS (build faithful, minimal versions)

- **`binaryShield.ts`**: rejects any file content containing NUL bytes or
  invalid UTF-8 before it's written; also rejects binary file extensions.
- **`siphon.ts`**: extracts code blocks from LLM output (markdown fences,
  the `<<<CODE>>>` envelope) and strips prose.
- **`structural-validator.ts`**: a fast in-memory TypeScript structural check
  (no `tsc` spawn) using a lightweight parser — rejects code that won't parse.
- **`emg/`**: emergency subsystem — `halt.ts` (graceful stop), `sanitizer.ts`
  (strips secrets from logs/output), `emg-rag.ts` (retrieval for the debate),
  `debate.ts` (the tribunal runner). `POST /api/emg/sanitize` triggers a
  manual log scrub.
- **`postmortem/`**: every failed/rejected cycle writes a JSON postmortem to
  a `postmortems/` repo folder AND a `Postmortem` DB row. `GET
  /api/postmortems` lists them; `POST /api/postmortems/seed` backfills from
  the folder.
- **`self-task-generator.ts`**: maintains a queue of `SelfEnhanceTask` rows
  (file + instruction). The loop pulls the highest-priority pending task per
  cycle. `POST /api/self-enhance/tasks` adds; `POST /api/self-enhance/skip`
  marks one skipped.

## API ROUTES (exact behaviour)

- `GET /api/self-enhance/status` → `{ running, cycle, currentFile, logs[],
  llmGate: LlmGateInfo, saturation: SaturationMap, pushTarget:{repo,branch,
  configured, lastBranchNumber}, llm:{configured, model, lastError} }`
  (runtime nodejs, dynamic force-dynamic).
- `POST /api/self-enhance/start` / `stop` / `trigger` → control the loop.
- `POST /api/self-enhance/unlock { filePath }` → unlock a saturated file.
- `POST /api/self-enhance/llm-config { geminiApiKey, model? }` → verify+save
  (geo-aware, per above).
- `POST /api/self-enhance/push-target { repo, token, branch? }` → configure
  GitHub push target (validates the PAT with `GET /user`, sets the
  extraheader, writes state file + DB row).
- `POST /api/self-enhance/push` → manual push of current HEAD to the seed
  branch.
- `GET /api/self-enhance/files` → the TARGET_FILES + saturation state.
- `GET /api/health` → `{ ok:true }`.

## THE DASHBOARD — `src/app/page.tsx`

A single `'use client'` page with `next-themes` light/dark, a sticky footer,
and these panels (use shadcn/ui `Card`, `Button`, `Badge`, `Input`,
`Tabs`/`TabsList`, `ScrollArea`):

1. **Header**: `LOOP` title, a `RUNNING`/`IDLE` badge, the live cycle counter.
2. **LLM cooldown chip**: `⏳ LLM COOLDOWN MM:SS` + `L{level}` badge, anchored
   to `endsAtMs`, ticking client-side, hidden when inactive.
3. **Config tab**: Gemini key input + model + `[Verify & Save]` (calls
   `/api/self-enhance/llm-config`), shows `locationBlocked` / `verified`
   / `lastError`. Below it: GitHub push target (repo, PAT, branch, `[Save]`,
   calls `/api/self-enhance/push-target`).
4. **Saturation panel**: one row per `TARGET_FILES` — `filename (N/3)` + an
   `[unlock]` button + `🎯 PASS COMPLETE` badge when self-declared done.
5. **Console** (the live stream — `console-stream.tsx`): max-h-96
   overflow-y-auto, custom scrollbar, monospace, colour-coded by level, auto-
   scroll-to-bottom with a "jump to latest" button.
6. **Controls**: `[START]` `[STOP]` `[TRIGGER CYCLE]` `[RESCAN]` buttons.
7. **Footer**: sticky to bottom (`min-h-screen flex flex-col` + `mt-auto`),
  shows `repo · branch · loop-{lastBranchNumber}` and a tiny "for research"
  disclaimer.

State: TanStack Query polling `/api/self-enhance/status` every 1s while
running. Actions via `useMutation`. A Zustand store holds the log buffer
(capped at 500 lines) so HMR of `console-stream.tsx` preserves history.

## ACCEPTANCE CRITERIA (the build is done when…)

1. `bun install && bun run db:push` succeeds with no schema errors.
2. `bun run dev` starts on port 3000 with no fatal errors; `/` renders the
   dashboard (not a blank screen).
3. With NO Gemini key configured, clicking START runs the loop and every
   cycle logs `Rejected by gate: no symbol changes` (mock provider → no
   growth → saturation increments). After 3 such cycles the file locks and
   the UI shows `SATURATED ▪ console-stream.tsx (3/3)` with an `[unlock]`
   button that works.
4. Configuring a **mock-invalid** Gemini key returns the proper Google error
   (400/403 INVALID_ARGUMENT), NOT a generic 500.
5. Configuring a valid key (even if geo-blocked) saves it and the loop
   reports `locationBlocked` cleanly without crashing.
6. The cooldown chip appears within 1 poll after a 429, counts down
   accurately against `endsAtMs`, and the loop skips whole cycles while it's
   active.
7. The branch counter `lastBranchNumber` survives a `db:push` reset via the
   state-file self-heal (delete the DB row, restart, the row is rehydrated).
8. Push target config (repo + PAT) is saved to both the JSON file (0600) and
   the DB; `git remote -v` shows NO token in the URL.
9. A successful enhancement (with a working key, from a supported region)
   creates a new `loop-NN` branch on GitHub and increments the counter.
10. `bun run lint` passes with zero errors.

## DELIVERABLE

Output every file with its full path and complete contents, in this order:
`package.json` (deps: next, react, react-dom, @google/genai, @prisma/client,
prisma, tailwindcss, @tailwindcss/postcss, zustand, @tanstack/react-query,
next-themes, lucide-react, shadcn/ui deps) → `tsconfig.json` →
`next.config.ts` → `tailwind config` → `prisma/schema.prisma` →
`src/lib/db.ts` → every `src/lib/pipeline/**/*.ts` (llm/ first) → every API
route → `src/app/page.tsx` → `src/app/display/console-stream.tsx` →
`src/app/globals.css`. Then a one-paragraph "how to run" note.

Remember: **the ONLY intentional difference from the original system is that
the LLM provider is Gemini (`@google/genai`) instead of `z-ai-web-dev-sdk`.**
Every behaviour — the gate, the serialization queue, the saturation locks, the
file-first persistence, the display hot-swap, the ratchet floor — is identical.
Build it complete and runnable.
