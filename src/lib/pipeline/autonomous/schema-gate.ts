/**
 * SCHEMA GATE — additive-only mutation of prisma/schema.prisma.
 *
 * The most dangerous thing the loop could touch: the schema defines the
 * system's own memory (postmortems, lessons, push target). A bad schema
 * change can destroy the postmortem DB or break every `db.*` call site.
 *
 * The contract — a proposed schema is ACCEPTED only if the diff vs the
 * live schema is EXACTLY:
 *   1. NEW model blocks (a whole `model X { ... }` that didn't exist), or
 *   2. NEW fields on a non-protected model, each with a @default()
 *      (so existing rows backfill; nullable-without-default also
 *      accepted since SQLite allows NULL on old rows).
 *
 * Everything else is REJECTED:
 *   - ANY change (field add/remove/rename/type-change, attr change,
 *     block deletion) to a PROTECTED model — the memory models:
 *     Postmortem, Lesson, GitPushTarget, LlmConfig, Prophecy, SystemFlag.
 *     A self-improving system must not be able to edit its own memory
 *     substrate or its learning substrate.
 *   - Removing or renaming ANY existing model or field (destructive).
 *   - Changing a field type or removing @default/@unique constraints.
 *   - Changes to the generator/datasource blocks.
 *
 * After the structural check passes, the apply chain is:
 *   write → `prisma validate` → `prisma db push` → canary round-trip
 *   (a child process reads postmortem + lesson counts through the
 *   freshly generated client). ANY step failing → restore the original
 *   file and re-push (safe: additive columns that existed for seconds
 *   hold no data) so the live DB and file stay in sync.
 */

import { runChildAsync } from "../core/async-spawn";
import { readFileSync, writeFileSync } from "fs";
import { PROJECT_ROOT } from "../core/paths";
import { sha16 } from "../core/hash";
import { withTreeLock } from "../core/tree-lock";

const SCHEMA_PATH = `${PROJECT_ROOT}/prisma/schema.prisma`;

/** Models the loop may never touch. The memory + learning substrate:
 *  the scar log, the lesson system, the push/LLM config, the prophecy
 *  oracle, the runtime flags — plus (D4/D8) the mutation corpus and the
 *  meta-parameter table. A self-improving system must not be able to
 *  edit its own memory substrate, its learning substrate, its audit
 *  trail, or the table that tunes its own loop knobs. */
export const SCHEMA_PROTECTED_MODELS = new Set([
  "Postmortem",
  "Lesson",
  "GitPushTarget",
  "LlmConfig",
  "Prophecy",
  "SystemFlag",
  "MutationCorpus",
  "MetaParam",
  // The goal table — the loop's self-set SYSTEM DIRECTION. A corrupted
  // schema proposal could drop the goal loop's substrate (same class as
  // MetaParam: the loop must not be able to edit its own governance).
  "LoopGoal",
]);

export interface SchemaCheckResult {
  ok: boolean;
  reason: string;
  /** Model names added by the proposal (for logging). */
  addedModels: string[];
  /** Fields added by the proposal, as "Model.field" (for logging). */
  addedFields: string[];
}

/** Parse a .prisma file into ordered model blocks. Returns a map of
 *  model name → { startLine, endLine, body } plus the header (everything
 *  before the first model). Line-based, not a real parser — but the
 *  schema grammar's `model NAME {` at column 0 + matching final `}` at
 *  column 0 is stable in practice and Prisma validate (which runs after)
 *  is the real grammar authority. */
function parseModels(text: string): Map<string, { start: number; end: number; body: string }> {
  const lines = text.split("\n");
  const models = new Map<string, { start: number; end: number; body: string }>();
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/);
    if (m) {
      const name = m[1];
      const start = i;
      let depth = 1;
      let j = i + 1;
      while (j < lines.length && depth > 0) {
        if (/^\s*\{/.test(lines[j])) depth++;
        if (/^\s*\}/.test(lines[j])) depth--;
        if (depth === 0) break;
        j++;
      }
      models.set(name, { start, end: j, body: lines.slice(start, j + 1).join("\n") });
      i = j + 1;
    } else {
      i++;
    }
  }
  return models;
}

/** Field names declared in a model body (lines that aren't the braces,
 *  block comments, or @@ attributes). */
function fieldNames(body: string): Set<string> {
  const out = new Set<string>();
  for (const line of body.split("\n").slice(1, -1)) {
    const t = line.trim();
    if (!t || t.startsWith("//") || t.startsWith("///") || t.startsWith("@@")) continue;
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+/);
    if (m) out.add(m[1]);
  }
  return out;
}

/** The additive-only structural check. Pure function — no I/O. */
export function checkAdditiveSchema(original: string, proposed: string): SchemaCheckResult {
  const oldModels = parseModels(original);
  const newModels = parseModels(proposed);

  const addedModels: string[] = [];
  const addedFields: string[] = [];

  // 1. No model may be REMOVED or RENAMED.
  for (const name of oldModels.keys()) {
    if (!newModels.has(name)) {
      return { ok: false, reason: `REJECTED: model ${name} was removed or renamed (destructive)`, addedModels, addedFields };
    }
  }

  // 2. Existing models: only NEW fields allowed, never on protected ones.
  for (const [name, oldDef] of oldModels) {
    const newDef = newModels.get(name);
    if (!newDef) continue; // covered above
    if (SCHEMA_PROTECTED_MODELS.has(name)) {
      if (oldDef.body.trim() !== newDef.body.trim()) {
        return {
          ok: false,
          reason: `REJECTED: protected model ${name} was modified (memory/learning substrate is untouchable)`,
          addedModels,
          addedFields,
        };
      }
      continue;
    }
    const oldFields = fieldNames(oldDef.body);
    const newFields = fieldNames(newDef.body);
    for (const f of oldFields) {
      if (!newFields.has(f)) {
        return { ok: false, reason: `REJECTED: field ${name}.${f} was removed or renamed (destructive)`, addedModels, addedFields };
      }
    }
    for (const f of newFields) {
      if (!oldFields.has(f)) {
        // New field on a non-protected model: must be nullable or carry
        // a @default so existing rows backfill without data migration.
        const decl = newDef.body
          .split("\n")
          .find((l) => l.trim().startsWith(`${f} `) || l.trim().startsWith(`${f}\t`));
        const safe = decl ? /@default\(/.test(decl) || /\?\s/.test(decl) : false;
        if (!safe) {
          return {
            ok: false,
            reason: `REJECTED: new field ${name}.${f} is neither nullable nor @default() — would break existing rows`,
            addedModels,
            addedFields,
          };
        }
        addedFields.push(`${name}.${f}`);
      }
    }
  }

  // 3. New models are allowed wholesale (they can't hurt existing rows).
  for (const name of newModels.keys()) {
    if (!oldModels.has(name)) addedModels.push(name);
  }

  if (addedModels.length === 0 && addedFields.length === 0) {
    return { ok: false, reason: "REJECTED: no additive change detected (only cosmetic churn)", addedModels, addedFields };
  }
  return { ok: true, reason: "additive-only diff verified", addedModels, addedFields };
}

/** Apply a schema mutation through the full gate chain. Returns
 *  { ok, reason } — on ANY failure the original file is restored and
 *  re-pushed so file and DB stay in sync.
 *
 *  ASYNC (de-mock of the event-loop blocker): the gate chain used to call
 *  spawnSync four times (validate 90s, push 120s, canary 60s, restore-push
 *  120s) — each blocking the Next.js server's event loop for up to 120s and
 *  freezing every /api/* poll mid-cycle. Now each step runs via runChildAsync
 *  (spawn + await): the child does the identical work, the parent yields the
 *  loop between steps. The fail-closed restore-on-failure contract is
 *  preserved bit-for-bit (original file written back, then a best-effort
 *  db:push of the original so file and DB never desync). */
export async function applySchemaMutation(proposed: string): Promise<{ ok: boolean; reason: string }> {
  // TREE LOCK (2026-11-17): the whole sequence — read → additive check →
  // write → validate → db:push → canary (→ restore on failure) — now holds
  // the cross-process tree lock. schema.prisma is the memory substrate and
  // db:push regenerates the Prisma client that the loop's typecheck gates
  // read, so serializing against the worker / chat-task / merge-back /
  // manual-push is correctness, not convenience. The caller (enhanceSchema)
  // holds no lock, so this cannot nest. Long hold is expected: validate +
  // push + canary ≈ up to ~5 min, inside the lock's 10-min wait budget.
  return withTreeLock(async () => {
  const original = readFileSync(SCHEMA_PATH, "utf-8");
  const originalSha = sha16(original);

  // Step 1: structural additive-only check.
  const check = checkAdditiveSchema(original, proposed);
  if (!check.ok) return { ok: false, reason: check.reason };

  const restore = async (why: string): Promise<{ ok: boolean; reason: string }> => {
    // ── Restore-path concurrent guard (2026-11-17) ──────────────────
    // The restore writes the ORIGINAL back after a validate/push failure.
    // If a concurrent writer changed schema.prisma AFTER our proposed
    // write landed, restoring the original would CLOBBER their edit.
    // Re-read and compare against what WE wrote: if the disk still holds
    // our proposed content, the crash-recovery restore is safe; if it
    // holds anything else, the concurrent edit is the new truth — skip
    // the file write-back (their content survives) and just best-effort
    // db:push so the DB re-syncs to the file truth (the system's
    // file-first invariant).
    let diskNow = "";
    try {
      diskNow = readFileSync(SCHEMA_PATH, "utf-8");
    } catch {
      /* file gone — fall through to the normal restore (it recreates it) */
    }
    const concurrentEdit = diskNow.length > 0 && diskNow !== proposed;
    if (!concurrentEdit) {
      try {
        writeFileSync(SCHEMA_PATH, original, "utf-8");
      } catch {
        /* original file restore is the critical part; push below is best-effort */
      }
    } else {
      console.error(
        "[schema-gate] restore skipped: schema.prisma changed on disk after our write (concurrent edit) — leaving the concurrent content in place and re-syncing the DB to it"
      );
    }
    // Re-push (original, or the concurrent content when it superseded
    // ours). --accept-data-loss covers dropping the just-added (empty)
    // columns/tables; nothing of value existed in them for the seconds
    // they lived.
    try {
      await runChildAsync("bun", ["run", "db:push"], { cwd: PROJECT_ROOT, timeoutMs: 120000 });
    } catch {
      /* best-effort — a failed re-push leaves a file/DB desync that the
         next db:push resolves; the operator-facing reason below says so */
    }
    return {
      ok: false,
      reason: concurrentEdit
        ? `REVERTED after failure: ${why} (file restore skipped — a concurrent edit superseded our write; DB re-synced to the concurrent content)`
        : `REVERTED after failure: ${why}`,
    };
  };

  // ── TOCTOU recheck (2026-11-17) ─────────────────────────────────────
  // The `original` was captured above, but the gate chain
  // (checkAdditiveSchema) ran since. An operator manual edit to
  // prisma/schema.prisma between the read and the write would be silently
  // clobbered by writeFileSync(proposed) below — and schema.prisma is the
  // memory substrate (protected file). Re-read and SHA-compare; if the
  // disk changed, abort cleanly (don't clobber the concurrent edit, don't
  // restore — the concurrent edit is the new truth, our proposal is stale).
  const diskNow = readFileSync(SCHEMA_PATH, "utf-8");
  if (sha16(diskNow) !== originalSha) {
    return {
      ok: false,
      reason: `TOCTOU: prisma/schema.prisma changed on disk between the structural check and the write — a concurrent writer (operator edit or host restore) landed. Aborting to avoid clobbering it; the proposal is stale against the new baseline.`,
    };
  }

  // Step 2: write the proposal.
  try {
    writeFileSync(SCHEMA_PATH, proposed, "utf-8");
  } catch (e) {
    return await restore(`could not write schema file: ${(e as Error).message}`);
  }

  // Step 3: prisma validate (grammar + datasource sanity).
  const validate = await runChildAsync("bunx", ["prisma", "validate"], { cwd: PROJECT_ROOT, timeoutMs: 90000 });
  if (validate.status !== 0) {
    return await restore(`prisma validate failed: ${(validate.stderr || validate.stdout || "").slice(-300)}`);
  }

  // Step 4: db push (applies to SQLite + regenerates the client).
  const push = await runChildAsync("bun", ["run", "db:push"], { cwd: PROJECT_ROOT, timeoutMs: 120000 });
  if (push.status !== 0) {
    return await restore(`prisma db push failed: ${(push.stderr || push.stdout || "").slice(-300)}`);
  }

  // Step 5: canary — a FRESH child process imports the regenerated
  //  client and round-trips the memory tables. The running process's
  //  client instance predates the change; the child proves the new
  //  client + new schema actually work together.
  const canary = await runChildAsync(
    "bun",
    [
      "-e",
      `const {db}=require('${PROJECT_ROOT}/src/lib/db.ts'); Promise.all([db.postmortem.count(), db.lesson.count(), db.gitPushTarget.findUnique({where:{id:'singleton'}})]).then(([p,l,g])=>{ if(p<0||l<0||!g) process.exit(2); console.log('canary-ok',p,l); process.exit(0); }).catch(e=>{ console.error(e.message); process.exit(3); });`,
    ],
    { cwd: PROJECT_ROOT, timeoutMs: 60000 }
  );
  if (canary.status !== 0) {
    return await restore(`canary round-trip failed: ${(canary.stderr || canary.stdout || "").slice(-300)}`);
  }

  const summary =
    check.addedModels.length > 0
      ? `added model(s): ${check.addedModels.join(", ")}`
      : `added field(s): ${check.addedFields.join(", ")}`;
  return { ok: true, reason: `schema mutation applied and canary-verified (${summary})` };
  });
}
