import { NextResponse } from "next/server";
import { listTasks, getQueueStats } from "@/lib/pipeline/autonomous/self-task-generator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 30);

  const [tasks, queue] = await Promise.all([listTasks(status, limit), getQueueStats()]);
  return NextResponse.json({ tasks, queue });
}
