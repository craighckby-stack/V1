# Security Audit — F-1 through F-9, H8/H9/H10

This document is the audit trail for a whole-system security + correctness
review of the LOOP self-enhancement pipeline. The work was landed across two
batches plus a follow-up; this file is the labeled record so the security
work is visible on GitHub's main log (the fixes themselves are folded into
the loop's `Self-enhancement: src/...` commits and one `fix(ws):` commit).

Every item below is verified present in the committed tree on `main`.

## Summary

| ID  | Category     | One-liner                                                              |
|-----|--------------|------------------------------------------------------------------------|
| F-1 | auth         | API auth gate fail-closed in prod, constant-time compare              |
| F-2 | auth         | Removed hardcoded default worker-ingest token                          |
| F-3 | shell-injection | `execSync(\`git …${ref}\`)` → `execFileSync("git", [argv])`          |
| F-4 | lint policy  | Re-enabled ~28 disabled ESLint rules (4 documented exceptions)         |
| F-5 | SSRF         | Caddy `XTransformPort` named-matcher allowlist `{3003, 3004}`         |
| F-6 | input validation | zod `.strict()` schemas on every route that reads a body (28)     |
| F-7 | resource leak | Worker spawn closes the parent's inherited stdout fd                   |
| F-8 | fail-closed  | Sanitizer returns a sentinel, never the unredacted code, on error     |
| F-9 | CORS         | WS service origin allowlist (comma-separated, prod fail-closed)       |
| H8a | state        | NVIDIA circuit-breaker map in a `globalThis` slot (Turbopack graph)   |
| H8b | state        | EMG-RAG prune counter in a `globalThis` slot                          |
| H8c | state        | Hot-swap journal append counter in a `globalThis` slot                |
| H9  | correctness  | Gemini generic-error retry counter now matches its 3 sibling paths    |
| H10 | path traversal | `sanitizePath` rewritten as a segment-walk (defeats `..%2f`, `..\`)   |

## Detail

### F-1 — API auth gate, fail-closed in production
`src/middleware.ts`
- `process.env.LOOP_API_KEY` must equal the request header `x-loop-key`.
- Constant-time compare via a local `safeEqual` helper (no early-exit
  string compare → no timing oracle).
- **Production fail-closed**: if `LOOP_API_KEY` is unset/empty in
  `NODE_ENV === "production"`, all mutating API requests are refused with
  503 and a one-time console warning. The operator must set the env var.
- **Dev fail-open**: in development an unset key logs a warning and allows
  the request through, so a fresh clone runs without ceremony.

### F-2 — No hardcoded default worker-ingest token
`src/app/api/oracle/events/ingest/route.ts`
- The previous default token `"loop-worker-ingest-v1"` was readable in
  source and let anyone forge worker events. Removed.
- An unset token now fails CLOSED (401) — a misconfigured worker can't
  write to the Oracle event stream.

### F-3 — Shell-injection → argv arrays
`src/lib/pipeline/autonomous/merge-back.ts`,
`src/lib/pipeline/autonomous/self-enhance-loop.ts`,
`src/lib/pipeline/oracle/prophecy-evaluator.ts`,
`src/lib/pipeline/oracle/prophecy-generator.ts`
- Every `execSync(\`git …${ref}\`)` (template-string shell command with an
  interpolated ref) became `execFileSync("git", [argv, ...])`.
- `execFileSync` never invokes a shell, so a malicious ref string
  (`"; rm -rf . #`) is passed as a literal argv element and rejected by
  git, not executed by `/bin/sh`.
- The remaining `execSync` uses in the codebase are for fixed, non-ref
  commands (e.g. `bunx tsc --noEmit`) and are documented as such.

### F-4 — ESLint policy un-neutered
`eslint.config.mjs`
- The previous config disabled ~28 rules wholesale, hiding every defect
  category the audit found (unused vars, `any`, non-null assertions, dead
  code, hook misuse).
- All rules are now **ENABLED** with exactly four documented exceptions,
  each with its justification inline:
  - `no-console` off — the system narrates itself via console output (the
    operator's primary interface is a terminal stream; 260+ intentional
    log calls are the product).
  - `no-undef` off — TypeScript owns undefined-symbol checking; eslint's
    `no-undef` doesn't understand TS types/UMD globals and only produces
    false positives (standard typescript-eslint recommendation for TS).
  - `react/prop-types` off — redundant in a fully-typed TS codebase.
  - `react-compiler/react-compiler` off — the React Compiler is not
    enabled for this project.
- `@typescript-eslint/no-unused-vars` is tuned: `argsIgnorePattern:
  "^_"`, `ignoreRestSiblings: true` (canonical prop-stripping pattern).
- `bun run lint` exits 0.

### F-5 — Caddy SSRF allowlist
`Caddyfile`
- The gateway exposes one external port and routes to the mini-services
  via a `?XTransformPort=` query param. Without an allowlist, ANY user
  could request `?XTransformPort=22` (or any internal service) and tunnel
  through the gateway to localhost — an SSRF pivot.
- Replaced the catch-all `?XTransformPort={Port}` with two named Caddy
  matchers: `@transform_port_3003` and `@transform_port_3004`, pinning the
  allowed ports to the two mini-services. Anything else falls through to
  the default Next.js handler (which 404s the unknown port).

### F-6 — zod input validation on every body-reading route
`src/lib/api/validate.ts` (new) + 28 API routes
- A shared helper gives every mutating route one shape:
  ```ts
  const parsed = await parseBody(req, schema);
  if (!parsed.ok) return parsed.response;
  // parsed.data is typed as the schema's inferred type
  ```
- Standardized error envelope: `{ ok: false, error: string, code: string }`
  where `code` is a short machine-readable token (`BAD_BODY`,
  `VALIDATION`) so the UI can branch without regex.
- All schemas use `.strict()` to reject unknown keys (no
  mass-assignment / forward-confusion).
- `isRepoRelativePath()` rejects absolute paths, Windows drive letters,
  UNC paths, `~`, and any `..` segment — used by every route that writes
  a file path to disk (`chat-task/apply`, `pipeline/run`,
  `github/commit-file`, `github/batch-commit`, `github/fetch-file`,
  `postmortems/seed`, `self-enhance/unlock`).
- Numeric fields are bounded (`intervalMinutes` 1–1440 to prevent a
  busy-loop, `maxFilesPerCycle` 1–100, `code` max 500KB, etc.).
- `parseOptionalBody()` is the dual: for routes like `duress/clear` /
  `hot-swap/trigger` where the body is a convenience and the action must
  never be blocked by a malformed payload. Validation still rejects
  wrong-typed fields; absent fields take the default.
- The remaining 35 routes without the helper are all parameterless POSTs
  (`autonomous/start|stop|trigger`, `oracle/evaluate`, etc.),
  query-param-only POST/DELETE, or GET-only — none read a body.

### F-7 — Worker spawn fd leak
`src/lib/pipeline/autonomous/loop-worker-client.ts`
- The worker is spawned as a detached child with its stdout wired to a
  log file. The parent inherited a duplicate fd that was never closed
  → the parent held the log file open and a hot-reload respawn piled up
  fds.
- After spawn, the parent now `fs.closeSync(parentOutFd)` (best-effort,
  never throws). Also removed dead `wasSpawning` code.

### F-8 — Sanitizer fail-closed sentinel
`src/lib/pipeline/emg/sanitizer.ts`
- On an internal error the sanitizer used to return the original
  (unredacted) code as a fallback — "trust the LLM output as-is".
- Now returns the sentinel `"// SANITIZER_FAILED — original code redacted
  as a precaution; see violations[] for the cause"`. The gate-runner's
  existing violation flag catches it; the sentinel makes the failure
  visible at the code level too.

### F-9 — WS service CORS origin allowlist
`mini-services/loop-ws-service/index.ts`, `examples/websocket/server.ts`
- The old `origin: "*` let ANY website open a socket to the live
  loop-state stream — a cross-origin state-exfil vector.
- `LOOP_WS_ALLOWED_ORIGIN` is now a comma-separated list of allowed
  origins. The CORS origin callback allows no-Origin requests
  (same-origin / curl / gateway health check) and rejects unknown
  origins with no `Access-Control-Allow-Origin` header.
- **Dev defaults**: `["http://localhost:3000", "http://localhost:81"]`
  — the two origins a local browser actually uses (the Next.js dev
  server and the Caddy gateway). The browser loads the page from the
  gateway and sends `Origin: http://localhost:81` on the socket
  handshake; a single-origin default of `:3000` rejected that, which is
  why the dashboard always fell back to polling with a `[LoopSocket] WS
  unavailable` warning. This follow-up fixed the live real-time path.
- **Production fail-closed**: if `LOOP_WS_ALLOWED_ORIGIN` is unset in
  production, no origin matches → the socket never connects → the
  polling fallback in `use-loop-socket.ts` keeps the dashboard live.
  Mirrors the F-1 middleware fail-closed policy.

### H8a/b/c — Turbopack cross-route module-state slots
`src/lib/pipeline/llm/nvidia-direct.ts`,
`src/lib/pipeline/emg/emg-rag.ts`,
`src/lib/pipeline/core/hot-swap.ts`
- Three module-level mutable singletons (the NVIDIA per-model circuit
  breaker map, the EMG-RAG prune counter, the hot-swap journal append
  counter) were plain `let` bindings at module scope.
- Under Turbopack's multi-route module graph, the same module can be
  evaluated in multiple contexts, so a module-level `let` is NOT shared
  across routes the way a long-running process expects. State silently
  reset per route, defeating the breaker / counter / journal.
- Moved each into a named `globalThis` slot (`__nvidiaBreakers`,
  `__emgRagPruneCount`, `__hotSwapAppendCounter`) — the standard Next.js
  pattern for cross-route module state in dev.

### H9 — Gemini generic-error retry counter
`src/lib/pipeline/llm/gemini-direct.ts`
- The model-fallback loop has four error-return paths. Three correctly
  reported `retries: totalAttemptsUsed - 1`; the generic http-error path
  reported `retries: attempt` (the per-model attempt counter, not the
  total). A fall-through to the 3rd model after 4 total attempts would
  report `retries: 0` instead of the honest `retries: 3`.
- Aligned the generic path with its three siblings.

### H10 — `sanitizePath` segment-walk
`src/lib/pipeline/engines/clean-room-runtime.ts`
- The previous path-sanitizer did a single regex pass and missed encoded
  traversal variants (`..%2f`, `foo/..`, `..\`, over-decoded segments).
- Rewritten as a segment-walk:
  1. Normalize backslashes to forward slashes.
  2. `decodeURIComponent` exactly once (catches `%2f`-encoded traversal).
  3. Walk each path segment: drop `.` and empty segments, pop the stack
     on `..`, and if the stack would underflow (escape the repo root)
     throw a `SECURITY ALERT: Path traversal barrier breached`.
- Defeats `..%2f`, `foo/..`, `..\`, and double-encoded variants.

## Verification

- `bun run lint` exits 0.
- `dev.log` clean — no compile/runtime/hydration errors.
- Curl rejection paths return `400 { ok: false, code: "VALIDATION" }`
  for unknown keys, out-of-range numerics, bad repo shapes, traversal
  paths; happy paths return `200`.
- WS service: `Origin: http://localhost:81` → matching
  `Access-Control-Allow-Origin`; `Origin: http://evil.com` → no ACAO
  header (rejected). Browser console shows
  `[LoopSocket] connected` with no fallback warning.
- agent-browser smoke test: page renders, boot splash dismisses, the
  merge-back panel renders the full 59-row `loop-NN` branch table
  (proving the `execFileSync` git ops work end-to-end through the UI).

## Deferred

- God-function splits (e.g. `runPipeline`) — pure refactor, no live bug.
