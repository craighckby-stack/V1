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
    if (verify.status === 400 || verify.status === 401 || verify.status === 403) {
      const errBody = await verify.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Key rejected by Google (${verify.status}): ${errBody.slice(0, 200)}` }, { status: 400 });
    }
    if (verify.status === 429) {
      // Key is valid but the Google quota is temporarily exhausted — still
      // save it; the loop will use it when quota resets. Don't punish a good
      // key for a temporary throttle.
      // fall through to save
    } else if (!verify.ok) {
      const errBody = await verify.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Google verification failed (${verify.status}): ${errBody.slice(0, 200)}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Network error verifying key: ${(e as Error).message}` }, { status: 500 });
  }

  await db.llmConfig.upsert({
    where: { id: SINGLETON_ID },
    update: { geminiApiKey: key, geminiModel: model, lastError: null },
    create: { id: SINGLETON_ID, geminiApiKey: key, geminiModel: model },
  });

  return NextResponse.json({ ok: true, model, verified: true });
}

/** DELETE — clear the Gemini config. */
export async function DELETE() {
  await db.llmConfig.deleteMany({ where: { id: SINGLETON_ID } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
