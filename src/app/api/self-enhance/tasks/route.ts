import { NextResponse } from "next/server";
import { listTasks, getQueueStats } from "@/lib/pipeline/autonomous/self-task-generator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/self-enhance/tasks?status=&limit=
 *
 * Hardened (2026-11-17): this was the only route with no error handling and
 * no query validation — `?limit=abc` became `take: NaN`, Prisma threw a
 * validation error, and the request died as a raw framework 500 (non-JSON).
 * limit is now coerced/clamped (1..100, default 30) and the whole handler
 * reports failures as JSON like every other route.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const statusRaw = url.searchParams.get("status");
    const status = statusRaw && statusRaw.trim() !== "" ? statusRaw.trim() : undefined;

    const limitRaw = Number(url.searchParams.get("limit") ?? 30);
    const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.round(limitRaw))) : 30;

    const [tasks, queue] = await Promise.all([listTasks(status, limit), getQueueStats()]);
    return NextResponse.json({ tasks, queue });
  } catch (err) {
    return NextResponse.json(
      { tasks: [], queue: null, error: (err as Error).message },
      { status: 500 }
    );
  }
}
