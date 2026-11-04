import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET (and HEAD) /api/healthz
 *
 * Minimal, dependency-free health probe for the platform's preview
 * edge. Some edge proxies / load balancers probe a fixed health path
 * before they consider a backend "up" — and this chat's preview has
 * been stuck showing "temporarily down" even while the app verifiably
 * serves 200s on / and /api/*. This endpoint gives any prober a
 * dead-simple, always-200, zero-dependency target.
 *
 * It deliberately does NOT touch the DB, the LLM gate, or the loop —
 * a health probe must answer even when subsystems are degraded.
 *
 * It also exposes one config fact that is itself zero-subsystem:
 * `mutationGate.configured` — whether `process.env.LOOP_API_KEY` is
 * set. The middleware (src/middleware.ts) fails OPEN when that env
 * var is unset (mutations are NOT actually locked), so the UI's
 * "API KEY NOT SET — MUTATIONS LOCKED" hint in ApiUnlock would be a
 * lie in that case. ApiUnlock fetches this field on mount and only
 * renders the hint when `configured === true`. Reading an env var is
 * not a "subsystem" — the answer is a static fact about the server's
 * environment, so the healthz still answers when everything else is
 * degraded.
 */
export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      ts: new Date().toISOString(),
      service: "loop",
      mutationGate: { configured: !!process.env.LOOP_API_KEY },
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store, must-revalidate",
      },
    }
  );
}

export async function HEAD() {
  return new Response(null, {
    status: 200,
    headers: {
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}
