import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { TargetRunResult } from "@/lib/pipeline/target/target-runner";
// Capture the REAL operator-touch module BEFORE mocking it. The mock
// below re-exports the full real surface and overrides only
// markOperatorTouch — so the route's transitive imports (and other test
// files in the same bun process, e.g. boot/scan's need for
// isDeadMansTripped) keep getting a faithful operator-touch. Mocking
// the whole module with only markOperatorTouch would leak globally and
// break every consumer that reads isDeadMansTripped / readOperatorTouch.
import * as realOperatorTouch from "@/lib/pipeline/autonomous/operator-touch";

/**
 * Real route tests for POST /api/target/run.
 *
 * The three pipeline dependencies (assertRouteCooldown, runTargetMutation,
 * markOperatorTouch) are replaced with bun:test mock.module fakes BEFORE
 * the route module is imported, so the route binds to the fakes. Every
 * test then invokes the real POST handler with a real Request and asserts
 * on the actual NextResponse it produced — never on a hand-rolled
 * reimplementation. Mock call counts and arguments are asserted too, so
 * the route's contract (cooldown gate, dryRun forwarding, operator-touch
 * refresh, status-code selection) is pinned by observable behavior.
 */

// ── Module mocks (registered before the route is imported) ────────────
const assertRouteCooldownMock = mock(() => ({ ok: true, retryAfterMs: 0 }));
const runTargetMutationMock = mock(async (): Promise<TargetRunResult> => ({
  ok: true,
  status: "no-work",
  repo: "test/owner",
  log: ["no mutable files in scope"],
}));
const markOperatorTouchMock = mock(() => undefined);

mock.module("@/lib/pipeline/autonomous/route-cooldown", () => ({
  assertRouteCooldown: assertRouteCooldownMock,
}));
mock.module("@/lib/pipeline/target/target-runner", () => ({
  runTargetMutation: runTargetMutationMock,
}));
// operator-touch: keep the full real export surface (isDeadMansTripped,
// readOperatorTouch, DEFAULT_DEAD_MANS_THRESHOLD_MS, …) so this mock
// does not starve other consumers; only markOperatorTouch is faked.
mock.module("@/lib/pipeline/autonomous/operator-touch", () => ({
  ...realOperatorTouch,
  markOperatorTouch: markOperatorTouchMock,
}));

// Dynamic import after mocks are registered: the route's transitive
// imports resolve to the fakes above.
const { POST, dynamic, runtime, maxDuration } = await import("./route");

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/target/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("route constants", () => {
  test("dynamic is 'force-dynamic'", () => {
    expect(dynamic).toBe("force-dynamic");
  });
  test("runtime is 'nodejs'", () => {
    expect(runtime).toBe("nodejs");
  });
  test("maxDuration is 300 (full attempt can take minutes)", () => {
    expect(maxDuration).toBe(300);
  });
});

describe("POST /api/target/run", () => {
  beforeEach(() => {
    assertRouteCooldownMock.mockReset();
    runTargetMutationMock.mockReset();
    markOperatorTouchMock.mockReset();
    // Defaults: cooldown allows the call; mutation succeeds (no-work).
    assertRouteCooldownMock.mockReturnValue({ ok: true, retryAfterMs: 0 });
    runTargetMutationMock.mockResolvedValue({
      ok: true,
      status: "no-work",
      repo: "test/owner",
      log: [],
    });
    markOperatorTouchMock.mockReturnValue(undefined);
  });

  test("returns 429 with Retry-After when cooldown is active, and does NOT run or touch", async () => {
    assertRouteCooldownMock.mockReturnValue({ ok: false, retryAfterMs: 9 });
    const res = await POST(jsonReq({ dryRun: true }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("9");
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("cooling down");
    expect(runTargetMutationMock).toHaveBeenCalledTimes(0);
    expect(markOperatorTouchMock).toHaveBeenCalledTimes(0);
  });

  test("dryRun=true forwards dryRun to runTargetMutation and returns 200 on ok", async () => {
    const res = await POST(jsonReq({ dryRun: true }));
    expect(res.status).toBe(200);
    expect(runTargetMutationMock).toHaveBeenCalledTimes(1);
    expect(runTargetMutationMock).toHaveBeenCalledWith({ dryRun: true });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("no-work");
  });

  test("dryRun=false (explicit) forwards dryRun:false and returns 200 on ok", async () => {
    const res = await POST(jsonReq({ dryRun: false }));
    expect(res.status).toBe(200);
    expect(runTargetMutationMock).toHaveBeenCalledWith({ dryRun: false });
  });

  test("returns 422 when runTargetMutation reports ok:false", async () => {
    runTargetMutationMock.mockResolvedValue({
      ok: false,
      status: "failed",
      repo: "test/owner",
      log: [],
      error: "LLM unavailable: quota",
    });
    const res = await POST(jsonReq({ dryRun: true }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("LLM unavailable: quota");
  });

  test("empty/invalid body is treated as a live run (dryRun:false) per contract", async () => {
    // Empty string is invalid JSON → route's catch sets body={} → dryRun stays false.
    const req = new Request("http://localhost/api/target/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(runTargetMutationMock).toHaveBeenCalledWith({ dryRun: false });
  });

  test("refreshes the operator dead-man's clock on every successful run", async () => {
    await POST(jsonReq({ dryRun: true }));
    expect(markOperatorTouchMock).toHaveBeenCalledTimes(1);
    expect(markOperatorTouchMock).toHaveBeenCalledWith("target-mode");
  });

  test("a pushed result is returned with 200 and carries the branch/commit fields", async () => {
    runTargetMutationMock.mockResolvedValue({
      ok: true,
      status: "pushed",
      repo: "test/owner",
      file: "src/app.ts",
      branch: "loop-t-7",
      commitSha: "abc123def456",
      log: ["RESULT: PUSHED"],
    });
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pushed");
    expect(body.branch).toBe("loop-t-7");
    expect(body.commitSha).toBe("abc123def456");
  });
});
