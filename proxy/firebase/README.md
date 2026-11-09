# Gemini Geo-Bypass Proxy — Firebase Edition (FREE)

Firebase Cloud Functions run inside Google Cloud. A function deployed to
`us-central1` (Iowa) egresses from a **US Google IP** — and Google does
not geo-block its own network. The HK geo-block is bypassed
**deterministically on the first request** (no warm-up, unlike the
Cloudflare Worker's Smart Placement).

```
LOOP (HK sandbox) ──?key=SHARED_SECRET──► Firebase Hosting ──► geminiProxy (us-central1) ──?key=GEMINI_KEY──► Gemini
                                                            │
                                                  GEMINI_API_KEY lives only here
                                                  (functions config, encrypted at rest by Firebase)
```

## Plan requirements — read this first

| Path | Card | Cost |
|---|---|---|
| **Gen 1 functions on the free Spark plan** (what this code is) | **No card** | $0 — 125K invocations/mo (LOOP uses ~6K) |
| Gen 2 functions | Card on file (Blaze) | $0 in practice — 2M invocations/mo free within Blaze |

This code is written **Gen 1** for the strictly-free, no-card path. If
your project/CLI forces Gen 2 (Google has been migrating), either accept
the card-on-file (still $0/month at LOOP's volume) or use the
**Cloudflare Worker** in `/proxy/` (always free, always no-card).

The other trade-off: **cold starts**. Gen 1 on the free plan scales to
zero, so the first call after idle takes ~2–5s to boot. LOOP's call
timeout is 120s and its 60s recovery-probe retries automatically — a
cold start is invisible to the pipeline.

## Deploy (~4 minutes)

### 1. Install the CLI + log in

```bash
npm install -g firebase-tools
firebase login        # free Google account — the same one your AI Studio key uses is fine
```

### 2. Create the project (or use an existing one)

```bash
cd /home/z/my-project/proxy/firebase
firebase projects:create loop-gemini-proxy --display-name "LOOP Gemini Proxy"
# (if the name is taken, pick another — the project ID just shapes the URL)

# Point this directory at it:
firebase use loop-gemini-proxy
# (or link an existing project: firebase use --add)
```

### 3. Set the two secrets

```bash
# Shared secret — LOOP will use this as the "key" instead of your AIza key
openssl rand -hex 32                 # copy the output
firebase functions:config:set proxy.secret=<paste-the-hex>

# Your real Gemini key
firebase functions:config:set gemini.key=AIzaSy...your-real-key...
```

Note: `functions:config` values live in Firebase's config store
(encrypted at rest, visible in the Firebase console to project owners).
Don't add collaborators you don't trust; rotate the secret if the
project is ever shared. (Secret Manager — the stricter alternative —
needs the Blaze plan, which is why this uses functions:config.)

### 4. Deploy

```bash
bun install          # or npm install — compiles the TS + installs firebase-functions
firebase deploy --only functions,hosting
```

The deploy output (and the Hosting URL) is:
`https://<project-id>.web.app` — e.g. `https://loop-gemini-proxy.web.app`.

### 5. Verify

```bash
curl https://<project-id>.web.app/health
# → {"ok":true,"ts":...}

# First call may cold-start (~2-5s). Probe again right after — it should be fast:
curl "https://<project-id>.web.app/v1beta/models/gemini-2.5-flash:generateContent?key=<proxy-secret>" \
  -H 'content-type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"Say OK"}]}]}'
# → {"candidates":[...]} = the bypass works. Google saw a US IP.
```

## Wire LOOP to it

Add one line to `/home/z/my-project/.env`:

```bash
GEMINI_PROXY_BASE_URL=https://<project-id>.web.app
```

Restart the LOOP dev server. In the GEMINI panel: `[ CLEAR KEY ]`, then
paste the **proxy.secret** value (the hex string — NOT the AIza key) and
click `[ SAVE · VERIFY · REBOOT ]`. The verify call routes through
Firebase → egresses from us-central1 → Google sees a US IP → your key
works. The panel's `last error` clears and the next cycle logs
`modelUsed: "gemini:..."`.

## How the routing works

LOOP calls `${GEMINI_PROXY_BASE_URL}/v1beta/models/<model>:generateContent`.
Firebase Hosting (free) rewrites `/v1beta/**`, `/v1/**`, and `/health`
to the `geminiProxy` function, preserving the original path — so the
function sees the exact upstream path and only swaps the host. The
Hosting domain (`<project-id>.web.app`) is the proxy base URL.

## Local testing (optional)

```bash
bun install
firebase emulators:start --only functions,hosting
# → http://localhost:5000  (health: http://localhost:5000/health)
# Set the same functions:config values first (the emulator reads the
# live project's config, or .runtimeconfig.json in functions/).
```

## Rotating

```bash
firebase functions:config:set proxy.secret=$(openssl rand -hex 32)
firebase deploy --only functions
# Then update the value in LOOP's GEMINI panel. No code change.
```

## Why the body is buffered (vs the CF Worker's streaming)

Gen 1's express.json already parses the request body, so the function
re-serializes and forwards it. This serves non-streaming
`generateContent` — which is everything LOOP's pipeline uses. If you
ever need `streamGenerateContent` (SSE), use the Cloudflare Worker
edition (`/proxy/cloudflare-worker.ts`), which streams both directions.
