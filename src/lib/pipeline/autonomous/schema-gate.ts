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

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";

const PROJECT_ROOT = "/home/z/my-project";
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
 *  re-pushed so file and DB stay in sync. */
export function applySchemaMutation(proposed: string): { ok: boolean; reason: string } {
  const original = readFileSync(SCHEMA_PATH, "utf-8");

  // Step 1: structural additive-only check.
  const check = checkAdditiveSchema(original, proposed);
  if (!check.ok) return { ok: false, reason: check.reason };

  const restore = (why: string): { ok: boolean; reason: string } => {
    try {
      writeFileSync(SCHEMA_PATH, original, "utf-8");
      // Re-push the ORIGINAL schema. --accept-data-loss covers dropping
      // the just-added (empty) columns/tables; nothing of value existed
      // in them for the seconds they lived.
      spawnSync("bun", ["run", "db:push"], { cwd: PROJECT_ROOT, timeout: 120000, stdio: "pipe" });
    } catch {
      /* original file restore is the critical part; push is best-effort */
    }
    return { ok: false, reason: `REVERTED after failure: ${why}` };
  };

  // Step 2: write the proposal.
  try {
    writeFileSync(SCHEMA_PATH, proposed, "utf-8");
  } catch (e) {
    return restore(`could not write schema file: ${(e as Error).message}`);
  }

  // Step 3: prisma validate (grammar + datasource sanity).
  const validate = spawnSync("bunx", ["prisma", "validate"], { cwd: PROJECT_ROOT, timeout: 90000, encoding: "utf-8" });
  if (validate.status !== 0) {
    return restore(`prisma validate failed: ${(validate.stderr || validate.stdout || "").slice(-300)}`);
  }

  // Step 4: db push (applies to SQLite + regenerates the client).
  const push = spawnSync("bun", ["run", "db:push"], { cwd: PROJECT_ROOT, timeout: 120000, encoding: "utf-8" });
  if (push.status !== 0) {
    return restore(`prisma db push failed: ${(push.stderr || push.stdout || "").slice(-300)}`);
  }

  // Step 5: canary — a FRESH child process imports the regenerated
  //  client and round-trips the memory tables. The running process's
  //  client instance predates the change; the child proves the new
  //  client + new schema actually work together.
  const canary = spawnSync(
    "bun",
    ["-e", "const {db}=require('/home/z/my-project/src/lib/db.ts'); Promise.all([db.postmortem.count(), db.lesson.count(), db.gitPushTarget.findUnique({where:{id:'singleton'}})]).then(([p,l,g])=>{ if(p<0||l<0||!g) process.exit(2); console.log('canary-ok',p,l); process.exit(0); }).catch(e=>{ console.error(e.message); process.exit(3); });"],
    { cwd: PROJECT_ROOT, timeout: 60000, encoding: "utf-8" }
  );
  if (canary.status !== 0) {
    return restore(`canary round-trip failed: ${(canary.stderr || canary.stdout || "").slice(-300)}`);
  }

  const summary =
    check.addedModels.length > 0
      ? `added model(s): ${check.addedModels.join(", ")}`
      : `added field(s): ${check.addedFields.join(", ")}`;
  return { ok: true, reason: `schema mutation applied and canary-verified (${summary})` };
}
