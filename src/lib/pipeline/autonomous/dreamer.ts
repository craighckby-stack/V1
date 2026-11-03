/**
 * DREAMER — idle-time consolidation, one cheap task at a time.
 * (concepts: genesis-agent DreamCycle, kai-evolve checkpoint distillation,
 * Raven's separate Evolver — D3 of the compounding-intelligence set)
 *
 * The loop already detects idle windows and wastes them: a cooldown
 * block is a multi-minute stall with zero productive work, and the 5s
 * inter-cycle gap is never used. The dreamer converts idle time into
 * preparation for the next real cycle — never into mutation:
 *
 *   ratchet-draft   — draft a characterization test for the most-attempted
 *                     untested module. ADVISORY ONLY: stored in memory,
 *                     never written to disk. The ratchet's real gates
 *                     (anti-tautology, bun-test-pass, tsc, debate) check
 *                     the FINAL test regardless of where the draft came
 *                     from; a bad draft dies at the gates and costs one
 *                     prompt slot.
 *   pattern-name     — take the mutation corpus's raw failed-transform
 *                     list and ask the LLM to name the 1-3 recurring
 *                     transforms in one line each. Stored; the distiller
 *                     injects it so lessons get distilled from named
 *                     patterns, not raw counts.
 *
 * QUOTA CONTRACT (the design's hard rule): the dreamer must never steal
 * mutation quota. Both tasks are LLM calls gated by the shared cooldown
 * gate — a task self-skips when llmCooldownMs() > 0, so during a 429
 * window the dreamer does NOTHING (deterministic work is not worth
 * doing here: the distiller builds its own digest, and the corpus is
 * written by the cycles themselves). Dreams only fire when the gate is
 * OPEN at an idle moment — i.e. quota exists to spare. ONE task per
 * invocation, round-robin, so an idle stretch spaces its work.
 *
 * This module is advisory (body, not brain): its outputs pass through
 * the existing gates. A corrupted dreamer can at worst waste quota —
 * and it shares the gate with the real mutations, which always win the
 * queue when the gate is the constraint.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname, basename, relative } from "path";
import { llmComplete, llmCooldownMs } from "../llm/agent-llm";
import { db } from "@/lib/db";
import { getCorpusDigest } from "./mutation-corpus";

const PROJECT_ROOT = "/home/z/my-project";
const DRAFT_TTL_MS = 60 * 60 * 1000; // drafts older than 1h are stale landscape
const PATTERN_TTL_MS = 2 * 60 * 60 * 1000;

interface DreamState {
  ratchetDrafts: Map<string, { at: number; code: string }>;
  namedPatterns: { at: number; text: string } | null;
  lastDreamAt: number;
  dreamCount: number;
  lastTask: string | null;
  lastResult: string | null;
}

const state: DreamState = {
  ratchetDrafts: new Map(),
  namedPatterns: null,
  lastDreamAt: 0,
  dreamCount: 0,
  lastTask: null,
  lastResult: null,
};

/** The draft for a file, or null if absent/stale. Consumed by the
 *  ratchet (writeTestsForFile) as a starting point. */
export function getRatchetDraft(filePath: string): string | null {
  const d = state.ratchetDrafts.get(filePath);
  if (!d) return null;
  if (Date.now() - d.at > DRAFT_TTL_MS) {
    state.ratchetDrafts.delete(filePath);
    return null;
  }
  return d.code;
}

/** The named recurring-transform text, or null if absent/stale.
 *  Consumed by the distiller prompt (lesson-store). */
export function getNamedPatterns(): string | null {
  if (!state.namedPatterns) return null;
  if (Date.now() - state.namedPatterns.at > PATTERN_TTL_MS) {
    state.namedPatterns = null;
    return null;
  }
  return state.namedPatterns.text;
}

// ── helpers ──────────────────────────────────────────────────────────

/** Most-attempted active postmortem whose file has no test pin yet and
 *  is small enough for the LLM. That's the module whose next ratchet
 *  call would benefit most from a drafted starting point. */
async function pickDraftTarget(): Promise<{ absPath: string; relPath: string; attempts: number } | null> {
  try {
    const rows = await db.postmortem.findMany({
      where: { status: "active" },
      orderBy: { attempts: "desc" },
      take: 10,
      select: { filePath: true, attempts: true },
    });
    for (const r of rows) {
      const abs = join(PROJECT_ROOT, r.filePath);
      if (!existsSync(abs)) continue;
      const ext = abs.endsWith(".tsx") ? ".tsx" : ".ts";
      const base = basename(abs, ext);
      const testPath = join(dirname(abs), `${base}.test${ext}`);
      if (existsSync(testPath)) continue; // already pinned
      try {
        const src = readFileSync(abs, "utf-8");
        if (src.length > 12000) continue;
        return { absPath: abs, relPath: r.filePath, attempts: r.attempts };
      } catch {
        continue;
      }
    }
  } catch {
    /* db unavailable */
  }
  return null;
}

// ── the two dream tasks ──────────────────────────────────────────────

async function dreamRatchetDraft(): Promise<string> {
  const target = await pickDraftTarget();
  if (!target) return "no draft target (all hot files pinned or missing)";
  if (llmCooldownMs() > 0) return "skipped (gate closed)";
  try {
    const source = readFileSync(target.absPath, "utf-8");
    const rel = relative(PROJECT_ROOT, target.absPath);
    const ext = target.absPath.endsWith(".tsx") ? ".tsx" : ".ts";
    const base = basename(target.absPath, ext);
    const res = await llmComplete({
      systemPrompt: `You are drafting a CHARACTERIZATION TEST (never to be applied blindly) for a module in a self-improving system. The draft will be handed to the real test-writer later as a starting point; every import and expectation in it will be mechanically verified against the real module. Compute expected values from the implementation. Every test() needs at least one expect(). Output ONLY the test code in one fenced typescript block — no prose.`,
      userPrompt: `Module: ${rel} (failed ${target.attempts} times — this is the system's hottest untested module)\n\n\`\`\`${ext === ".ts" ? "typescript" : "tsx"}\n${source}\n\`\`\`\n\nDraft ${base}.test.ts using bun:test, importing from "./${base}".`,
      temperature: 0.2,
    });
    if (!res.ok) return `llm unavailable: ${res.error?.slice(0, 60)}`;
    const fence = res.content.match(/```(?:typescript|tsx)?\s*([\s\S]*?)```/);
    const code = fence ? fence[1].trim() : res.content.trim();
    if (code.length < 80) return "draft too short — discarded";
    state.ratchetDrafts.set(rel, { at: Date.now(), code: code.slice(0, 12000) });
    return `drafted characterization test for ${rel} (${target.attempts} attempts — advisory, gated later)`;
  } catch (e) {
    return `error: ${(e as Error).message.slice(0, 60)}`;
  }
}

async function dreamPatternName(): Promise<string> {
  if (llmCooldownMs() > 0) return "skipped (gate closed)";
  try {
    const raw = await getCorpusDigest();
    if (!raw || raw.length < 60) return "no corpus signal yet";
    const res = await llmComplete({
      systemPrompt: `You are the pattern-naming stage of a self-improving system. Below is the raw record of recent mutation attempts (which transforms the mutation LLM proposed, and which gates rejected them). Name the 1-3 RECURRING transforms — the patterns the mutation model keeps attempting that the gates keep rejecting. One line each: the transform's name in quotes, then what it gets wrong. No prose around the list.`,
      userPrompt: `Recent mutation record:\n\n${raw.slice(0, 3000)}\n\nName the recurring failed transforms.`,
      temperature: 0.3,
    });
    if (!res.ok) return `llm unavailable: ${res.error?.slice(0, 60)}`;
    const text = res.content.trim().slice(0, 800);
    if (text.length < 30) return "pattern text too short — discarded";
    state.namedPatterns = { at: Date.now(), text };
    return `named recurring transforms (${text.split("\n").length} line(s)) — distiller will inject them`;
  } catch (e) {
    return `error: ${(e as Error).message.slice(0, 60)}`;
  }
}

const TASKS: Array<{ name: string; run: () => Promise<string> }> = [
  { name: "ratchet-draft", run: dreamRatchetDraft },
  { name: "pattern-name", run: dreamPatternName },
];

let taskCursor = 0;

/**
 * Maybe run ONE dream task. Call from an idle moment: the runCycle
 * blocked branch (quota stall) or the inter-cycle wait. Fire-and-forget
 * safe; never throws. Returns the result line for logging, or null when
 * the dreamer declined (both tasks would steal quota / nothing to do).
 */
export async function maybeDream(): Promise<string | null> {
  // During a closed gate both tasks self-skip — check once up front so
  // an entire cooldown window costs one function call.
  if (llmCooldownMs() > 0) return null;
  const task = TASKS[taskCursor % TASKS.length];
  taskCursor++;
  try {
    const result = await task.run();
    state.lastDreamAt = Date.now();
    state.dreamCount++;
    state.lastTask = task.name;
    state.lastResult = result;
    if (result.startsWith("skipped")) return null;
    return `💤 dreamer: ${task.name} — ${result}`;
  } catch {
    return null;
  }
}
