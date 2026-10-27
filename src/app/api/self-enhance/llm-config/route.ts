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
  // but reject obviously malformed input.
  if (key.length < 20 || /\s/.test(key)) {
    return NextResponse.json({ ok: false, error: "Key looks malformed (expected 20+ chars, no whitespace)" }, { status: 400 });
  }

  // Verify the key with a minimal generateContent call.
  let locationBlocked = false;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
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
      if (status === "FAILED_PRECONDITION" && /location/i.test(msg)) {
        locationBlocked = true;
        // fall through to save
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
