import { NextResponse } from "next/server";
import { selfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const scan = await selfEnhanceLoop.rescan();
  return NextResponse.json({ ok: true, ...scan });
}
