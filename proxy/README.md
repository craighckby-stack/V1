# Gemini Geo-Bypass Proxy

A ~150-line Bun server that lets LOOP call Google's Gemini API from a
region Google refuses to serve directly.

## The problem it solves

The LOOP sandbox egresses through Hong Kong. Google's Gemini API returns
`FAILED_PRECONDITION "location is not supported"` for any request from
that region — a hard IP-based geo-block, not a key problem or a quota
problem. This proxy runs in Singapore (`sgp` on Fly.io, a supported
region), forwards the request, and injects the real Gemini key server-side.
LOOP only ever holds a shared secret.

```
LOOP (HK sandbox) ──?key=SHARED_SECRET──► proxy (Singapore) ──?key=GEMINI_KEY──► Gemini
                                                     │
                                            GEMINI_API_KEY lives only here
```

## What's in this directory

| File | Purpose |
|---|---|
| `index.ts` | The proxy itself. Zero npm dependencies — uses only `Bun.serve` and `fetch`. |
| `fly.toml` | Fly.io config. Pinned to `sgp`, smallest machine (256MB, ~$2/mo), warm always. |
| `Dockerfile` | Bun base image, single-file copy. ~50MB image, ~50ms boot. |
| `package.json` | Just so `bun run start` works. No deps. |
| `.env.example` | Template for local testing. **Never commit a real `.env`.** |

## What the proxy does (and doesn't)

**Does:**
1. Validates `?key=<secret>` against `PROXY_SECRET` (constant-time compare).
2. Swaps the secret for the real `GEMINI_API_KEY` in the query string.
3. Streams the response back unchanged (both `generateContent` JSON and `streamGenerateContent` SSE work).

**Doesn't:**
- Log request or response bodies (privacy + log hygiene).
- Rate-limit (LOOP's own cooldown machinery in `agent-llm.ts` handles 429s).
- Allowlist models (LOOP picks the model; the proxy is dumb).
- Touch the request body (other than streaming it through verbatim).

## Deploy to Fly.io (5 minutes)

### 1. Install the Fly CLI

```bash
curl -L https://fly.io/install.sh | sh
fly auth signup   # or: fly auth login
```

### 2. Launch the app (don't deploy yet — we set secrets first)

From this directory:

```bash
cd proxy
fly launch --no-remote --name loop-gemini-proxy
```

When prompted, **don't** `fly deploy` yet — say no. We need to set secrets
before the first deploy or the container will exit with the FATAL message.

### 3. Set the secrets

```bash
# Generate a strong shared secret (LOOP will use this instead of a Gemini key)
fly secrets set PROXY_SECRET=$(openssl rand -hex 32)

# Set the real Gemini key (get one from https://aistudio.google.com/apikey)
fly secrets set GEMINI_API_KEY=AIzaSy...your-real-key...
```

You can do both in one command if you prefer:
```bash
fly secrets set PROXY_SECRET=$(openssl rand -hex 32) GEMINI_API_KEY=AIzaSy...
```

### 4. Deploy

```bash
fly deploy
```

First deploy takes ~30 seconds. You'll see it allocate an IPv4 + a
`*.fly.dev` hostname.

### 5. Verify the proxy is alive

```bash
curl https://loop-gemini-proxy.fly.dev/health
# → {"ok":true,"ts":1761714123456}
```

That's it. The proxy is running. Now wire LOOP to use it.

## Wire LOOP to the proxy

### 1. Set the base URL in LOOP's `.env`

Add one line to `/home/z/my-project/.env`:

```bash
# Gemini direct calls route through the Singapore proxy instead of hitting
# Google from the HK egress (which Google refuses to serve).
GEMINI_PROXY_BASE_URL=https://loop-gemini-proxy.fly.dev
```

Then restart the LOOP dev server so the env var is picked up.

### 2. Paste the shared secret in the LOOP config panel

In the dashboard, open the **Configure Push** / **LLM Config** panel.
Where you'd normally paste a Gemini API key, paste the value of
`PROXY_SECRET` instead (the output of `openssl rand -hex 32` from step 3).

The proxy swaps it for the real key on its side. LOOP's existing
`gemini-direct.ts` code keeps working unchanged — it just talks to the
proxy URL instead of `generativelanguage.googleapis.com`.

### 3. Pick a model

Set the model in the same panel (e.g. `gemini-2.5-pro` or
`gemini-2.5-flash`). The proxy forwards the path verbatim, so any model
Google serves works.

### 4. Watch the first cycle

When the next LOOP enhance cycle runs, it calls Gemini through the
proxy. In `dev.log` you should see the location-blocked error message
*disappear*. If you see `Gemini 401: API key not valid`, the secret
doesn't match — check you pasted the `PROXY_SECRET` value (not the
`GEMINI_API_KEY`).

## Local testing (optional)

You don't need Fly to test the proxy works. From this directory:

```bash
cp .env.example .env
# Fill in PROXY_SECRET and GEMINI_API_KEY in .env
bun install   # no-op — no deps — but creates the lockfile
bun run dev    # starts on :8787 with --hot reload
```

Then in another shell:
```bash
# Health check (no auth)
curl http://localhost:8787/health

# Real call through the proxy (substitute your secret + a real model)
curl "http://localhost:8787/v1beta/models/gemini-2.5-flash:generateContent?key=$PROXY_SECRET" \
  -H 'content-type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"Say hi in one word."}]}]}'
```

If you see a JSON response with `candidates`, the proxy works and your
`GEMINI_API_KEY` is valid.

## Operational notes

### Cost

`shared-cpu-1x` with 256MB RAM, kept warm (`min_machines_running = 1`),
runs ~$2/month on Fly's hobby-tier pricing. If you don't mind ~300ms
cold starts on the first request after idle, set `min_machines_running = 0`
in `fly.toml` and it drops to a few cents.

### Latency

Added RTT: HK → Singapore → Google ≈ 40ms. Irrelevant next to multi-second
Gemini generation time.

### Rotating the secret

If the shared secret leaks (or you just want to rotate on principle):

```bash
fly secrets set PROXY_SECRET=$(openssl rand -hex 32)
fly deploy   # restarts with the new secret
```

Then update the value in LOOP's config panel. No code change needed.

### Rotating the Gemini key

```bash
fly secrets set GEMINI_API_KEY=AIzaSy...new-key...
fly deploy
```

LOOP is unaware — it only knows the shared secret.

### Logs

```bash
fly logs
```

You'll see startup logs and any handler errors. Request/response bodies
are **never** logged by design.

### What if Google detects the circumvention?

ToS gray zone. Google's documented remedy is key termination, not
account action. Use a throwaway AI Studio project key, don't build
anything load-bearing on the connection, and rotate the key if you get
a suspension notice. The proxy itself is generic — it's just a reverse
proxy with auth — so even if this specific use case stops working, the
pattern (proxy in a supported region, inject credentials server-side)
keeps being useful for any geo-restricted API.

## Architecture notes

### Why Bun, not Cloudflare Workers

Cloudflare Workers are simpler to deploy but their egress region isn't
deterministic — Workers run at the edge, near the *caller*, not at a
pinned region. A Worker called from the HK sandbox might run from a
Hong Kong edge node, which would inherit the same geo-block. Fly.io
pinned to `sgp` is a deterministic Singapore egress IP — that's what
makes the geo-bypass reliable.

### Why not a full Dify/router setup

This proxy gets you exactly one provider (Gemini) with ~150 lines of
code and zero dependencies. The Dify router idea (from the design
discussion) gets you all providers plus structured logging plus a UI,
but at the cost of running a Dify instance. This is the 1% version;
Dify is the 100% version. Start here; graduate if you want multi-model.

### Why constant-time secret compare

A timing-attack on the secret compare would let an attacker recover it
byte-by-byte by measuring response time. Cheap to defeat (one extra
function, 5 lines), so we do. Standard practice for any auth check.

### Why no rate limiting on the proxy

LOOP already has elaborate cooldown machinery (see
`src/lib/pipeline/llm/agent-llm.ts`: escalating 2/5/15/30-min gates,
serialized dispatch, strike counter). Duplicating that at the proxy
would mean two layers fighting each other. The proxy is dumb on
purpose; LOOP is smart on purpose.

## Re-runnable

The proxy is intentionally trivial. To rebuild from scratch in a new
Fly account: `cd proxy && fly launch && fly secrets set ... && fly deploy`.
No state, no database, no migrations. The only thing that matters is
the two secrets, which live in Fly's secret store.
