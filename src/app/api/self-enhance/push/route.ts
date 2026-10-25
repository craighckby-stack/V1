import { NextResponse } from "next/server";
import { execSync } from "child_process";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  try {
    const status = execSync("git status --porcelain", { cwd: "/home/z/my-project", encoding: "utf-8", timeout: 5000 });
    if (!status.trim()) {
      return NextResponse.json({ pushed: false, message: "No changes to push" });
    }
    execSync("git add -A", { cwd: "/home/z/my-project", timeout: 5000 });
    execSync('git commit -m "Manual push: current live state"', { cwd: "/home/z/my-project", timeout: 5000 });
    const sha = execSync("git rev-parse HEAD", { cwd: "/home/z/my-project", encoding: "utf-8", timeout: 5000 }).trim();
    try {
      execSync("git push 2>&1", { cwd: "/home/z/my-project", timeout: 15000 });
      return NextResponse.json({ pushed: true, commitSha: sha.slice(0, 7) });
    } catch (err) {
      return NextResponse.json({ pushed: false, committed: true, commitSha: sha.slice(0, 7), error: "Push failed — no remote configured?" });
    }
  } catch (err) {
    return NextResponse.json({ pushed: false, error: (err as Error).message }, { status: 500 });
  }
}
