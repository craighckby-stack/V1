import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SINGLETON_ID = "singleton";

/** GET — public view (key NEVER included). */
export async function GET() {
  const row = await db.llmConfig.findUnique({ where: { id: SINGLETON_ID } }).catch(() => null);
  if (!row) return NextResponse.json({ configured: false });
  return NextResponse.json({
    configured: true,
    model: row.geminiModel,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastError: row.lastError,
  });
}

/** POST — verify + persist the Gemini API key. */
export async function POST(req: Request) {
  let body: { geminiApiKey?: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const key = (body.geminiApiKey ?? "").trim();
  const model = (body.model ?? "gemini-2.5-flash").trim();
  if (!key) {
    return NextResponse.json({ ok: false, error: "Missing geminiApiKey" }, { status: 400 });
  }
  // Gemini API keys start with "AIza" and are ~39 chars. Be lenient on length
  // but reject obviously malformed input. When the proxy is in use, the
  // "key" is actually the proxy's shared secret (openssl rand -hex 32 = 64
  // hex chars), so we accept any 20+ char no-whitespace string.
  if (key.length < 20 || /\s/.test(key)) {
    return NextResponse.json({ ok: false, error: "Key looks malformed (expected 20+ chars, no whitespace)" }, { status: 400 });
  }

  // Verify the key with a minimal generateContent call. Route through the
  // proxy if GEMINI_PROXY_BASE_URL is set — otherwise the verify step hits
  // Google directly from the HK sandbox and fails the geo-block even when
  // the proxy is configured and working. The proxy swaps this secret for
  // the real Google key on its side.
  const VERIFY_BASE = process.env.GEMINI_PROXY_BASE_URL?.replace(/\/$/, "") ?? "https://generativelanguage.googleapis.com";
  const usingProxy = !!process.env.GEMINI_PROXY_BASE_URL;

  let locationBlocked = false;
  try {
    const url = `${VERIFY_BASE}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const verify = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "say OK" }] }],
        generationConfig: { maxOutputTokens: 5, temperature: 0 },
      }),
    });

    // Decode the Google error envelope once (Google returns { error: { code, message, status, details } })
    const readGoogleErr = async (): Promise<{ code?: number; message?: string; status?: string }> => {
      try {
        const body = (await verify.clone().json().catch(() => null)) as { error?: { code?: number; message?: string; status?: string } } | null;
        return body?.error ?? {};
      } catch {
        return {};
      }
    };

    if (verify.ok) {
      // Key works RIGHT NOW — fall through to save below.
    } else if (verify.status === 429) {
      // Key is valid, Google quota temporarily exhausted — save anyway so
      // the loop uses it when quota resets.
    } else if (verify.status === 400 || verify.status === 403 || verify.status === 401) {
      const gerr = await readGoogleErr();
      const status = gerr.status ?? "";
      const msg = gerr.message ?? "";

      // FAILED_PRECONDITION with "location is not supported" = the KEY is
      // valid, but the current network egress region isn't supported by
      // Google's free-tier Gemini API (e.g. HK, CN, ...). The key will work
      // from a supported region. SAVE it (don't punish a good key for the
      // sandbox's geography) and return a clear "saved but location-blocked"
      // status so the UI can show what's going on.
      //
      // When using the proxy, a location-block here means the PROXY is also
      // in a blocked region — which is a real config error, not just
      // geography. Surface that distinctly so the operator knows to redeploy
      // the proxy to a supported region (see /proxy/README.md).
      if (status === "FAILED_PRECONDITION" && /location/i.test(msg)) {
        locationBlocked = true;
        // fall through to save
      } else if (usingProxy && verify.status === 401) {
        // The proxy returns a Gemini-shaped 401 when the shared secret is
        // wrong. Distinguish from a Google 401 (which would mean the real
        // Gemini key is bad) so the operator knows which credential to fix.
        return NextResponse.json({ ok: false, error: `Proxy rejected the shared secret (401). The proxy is up but PROXY_SECRET doesn't match — re-enter the value from 'fly secrets get PROXY_SECRET'.` }, { status: 400 });
      } else if (status === "INVALID_ARGUMENT" && /api key/i.test(msg)) {
        return NextResponse.json({ ok: false, error: `Key rejected by Google: ${msg || "API key not valid"}` }, { status: 400 });
      } else if (verify.status === 403) {
        return NextResponse.json({ ok: false, error: `Key rejected by Google (403 PERMISSION_DENIED): ${msg || "key not permitted for this API"}` }, { status: 400 });
      } else if (verify.status === 401) {
        return NextResponse.json({ ok: false, error: `Key rejected by Google (401): ${msg || "unauthorized"}` }, { status: 400 });
      } else {
        return NextResponse.json({ ok: false, error: `Google verification failed (${verify.status} ${status}): ${msg}` }, { status: 400 });
      }
    } else if (!verify.ok) {
      const errBody = await verify.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Google verification failed (HTTP ${verify.status}): ${errBody.slice(0, 200)}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Network error verifying key: ${(e as Error).message}` }, { status: 500 });
  }

  await db.llmConfig.upsert({
    where: { id: SINGLETON_ID },
    update: { geminiApiKey: key, geminiModel: model, lastError: locationBlocked ? `Location not supported by Google Gemini API (key is valid; will work from a supported region)` : null },
    create: { id: SINGLETON_ID, geminiApiKey: key, geminiModel: model, lastError: locationBlocked ? `Location not supported by Google Gemini API (key is valid; will work from a supported region)` : null },
  });

  if (locationBlocked) {
    return NextResponse.json({
      ok: true,
      model,
      verified: false,
      locationBlocked: true,
      warning: `Key is valid but this network's egress region is not supported by Google's Gemini API. Key saved — it will work if the system runs from a supported region (US, EU, etc.). Until then, the loop falls back to the Z.AI model chain.`,
    });
  }

  return NextResponse.json({ ok: true, model, verified: true });
}

/** DELETE — clear the Gemini config. */
export async function DELETE() {
  await db.llmConfig.deleteMany({ where: { id: SINGLETON_ID } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
