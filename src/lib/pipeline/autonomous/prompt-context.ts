/**
 * prompt-context.ts — the loop's context-assembly, separated from the
 * prompt template.
 *
 * WHAT THIS IS
 * ───────────
 * The coherence-debt fix (#4 from the 10/10 list). The enhance prompt
 * used to be a 6-block string concat that knew about 8 subsystems:
 * postmortems, ancestral RAG, prior-art, lessons (promoted + bounded),
 * rejected transforms, arch context, provenance, goals — each with its
 * own try/catch assembly inline, then 3 template literals (refactor /
 * visual-polish / schema) each concatenating a different subset.
 *
 * Adding a context source meant editing 3 template strings + the
 * inline assembly. This module separates the ASSEMBLY (which blocks,
 * in what order, with what budgets, fail-soft) from the TEMPLATE (the
 * role / job / format / hard rules). Adding a context source is now
 * ONE function, not a 40-line template edit.
 *
 * THE CONTRACT
 * ───────────
 * buildEnhanceContext(filePath, relPath, mode) → {
 *   systemBlocks: string[],   // ordered, already-wrapped, ready to join
 *   userBlocks: string[],     // ordered, ready to join
 *   lessonIds: string[],      // for the verdict feedback loop
 * }
 *
 * - Each block is fail-soft: "" on any error, and the array filters
 *   empties out so the joined string has no empty blocks.
 * - The ORDER is the documented prompt structure (see the loop's
 *   self-enhance-loop.ts comments): operating constraints → postmortem
 *   → provenance → rejected → ancestral → priorArt (refactor only) →
 *   lessons. This module owns that order; the template doesn't.
 * - MODE-AGNOSTIC blocks (operating, postmortem, provenance, rejected,
 *   ancestral, lessons) are included in both refactor and visual-polish.
 *   MODE-SPECIFIC blocks (priorArt, archContext) are excluded from
 *   visual-polish (the engine corpus is backend logic; arch context is
 *   less relevant for styling changes).
 * - The caller (the loop) still owns `goalsBullets` (it's rendered into
 *   the role body inside the template, not the system tail) and the
 *   file content (goes into the user prompt).
 *
 * WHY THIS IS BETTER
 * ──────────────────
 * - Adding a context source = add one assembly line + one array push.
 *   No template edit.
 * - The order is explicit + named, not implicit in a 40-line literal.
 * - Each block's fail-soft contract is in ONE place (this module), not
 *   duplicated across 3 try/catches.
 * - The template is a thin role/format/hard-rules string — readable.
 *
 * PERFORMANCE: same as before. The blocks are computed once per
 * enhanceFile call; this module just collects them into arrays instead
 * of inline-concatenating. No extra DB calls, no extra LLM calls.
 */

import { postmortemStore } from "../postmortem/postmortem-store";
import { queryRelevantPostmortems, formatAncestralPromptBlock } from "../postmortem/ancestral-rag";
import { searchEngines, formatPriorArtBlock } from "./githistory-corpus";
import {
  getPromotedProcedures,
  getLessonsForPrompt,
  formatOperatingConstraintsBlock,
  formatLessonsBlock,
  markInjected,
  type LessonRow,
} from "./lesson-store";
import {
  getRejectedTransformsForFile,
  formatRejectedTransformsBlock,
} from "./mutation-corpus";
import { buildArchContext } from "./arch-context";
import { buildProvenanceDigestForPrompt } from "./provenance-digest";
import { buildMutationPolicyBlock } from "./mutation-policy";

export interface EnhanceContext {
  /** Ordered system-prompt blocks (fail-soft, empties filtered). The
   *  caller joins them and appends to the role/format template. */
  systemBlocks: string[];
  /** Ordered user-prompt blocks (fail-soft, empties filtered). The
   *  caller joins them and appends to the file-content template. */
  userBlocks: string[];
  /** The lesson IDs injected this cycle (for the verdict feedback loop
   *  in runCycle — the wrapper after the enhanceFile call). */
  lessonIds: string[];
  /** The content of the file being processed. */
  fileContent?: string;
  /** The path of the file being processed. */
  filePath?: string;
}

/** Build the enhance context for one file. One DB/git call per block
 *  (fail-soft), collected into ordered arrays. The caller decides which
 *  template (refactor / visual-polish / schema) to splice into.
 *
 *  `mode` controls which blocks are included:
 *    - "refactor": all blocks (operoting, postmortem, provenance,
 *      rejected, ancestral, priorArt, lessons; archContext in user).
 *    - "visual-polish": all EXCEPT priorArt + archContext (the engine
 *      corpus is backend logic; arch context is less relevant for
 *      styling changes).
 *    - "schema": operating, postmortem, provenance, rejected, lessons
 *      (no ancestral, no priorArt, no archContext — schema is a single
 *      file with no imports neighborhood). */
export async function buildEnhanceContext(
  filePath: string,
  relPath: string,
  mode: "refactor" | "visual-polish" | "schema",
): Promise<EnhanceContext> {
  // Validate input parameters
  if (!filePath || typeof filePath !== "string") {
    throw new Error("filePath must be a non-empty string");
  }
  if (!relPath || typeof relPath !== "string") {
    throw new Error("relPath must be a non-empty string");
  }
  if (!["refactor", "visual-polish", "schema"].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Must be "refactor", "visual-polish", or "schema"`);
  }

  const systemBlocks: string[] = [];
  const userBlocks: string[] = [];
  let lessonIds: string[] = [];

  // ── 1. POSTMORTEM (per-file active constraint) ──────────────────
  // Always first (after the operating block below) — the active
  // failure constraint is the most prominent per-file signal.
  // Also capture the symptom string — the ancestral query (below)
  // prepends it to the keyword so a syntax-drop scar on foo.ts
  // surfaces verified scars from other files with the same symptom.
  let postmortemBlock = "";
  let postmortemActive = false;
  let postmortemSymptom = "";
  try {
    const postmortem = await postmortemStore.getConstraintsForFile("self", "main", relPath);
    postmortemActive = postmortem.hasActivePostmortem;
    postmortemBlock = postmortemActive ? `\n${postmortem.promptBlock}\n` : "";
    postmortemSymptom = postmortem.symptom ?? "";
  } catch (error) {
    console.error(`Failed to retrieve postmortem constraints for ${relPath}:`, error);
    /* best-effort */
  }

  // ── 2. ANCESTRAL RAG (verified postmortems from OTHER files) ────
  // Schema mode: skip (a single-file schema has no imports neighborhood
  // to cross-reference). Refactor + visual-polish: include.
  // The keyword prepends the active postmortem's symptom (when present)
  // so a file with a "AST_SYMBOL_DROPPED" scar surfaces other files'
  // verified scars with the same symptom — cross-file failure transfer.
  let ancestralBlock = "";
  if (mode !== "schema") {
    try {
      // Construct keyword once to avoid repeated string operations
      const pathKeyword = relPath.replace(/[\/\\]/g, " ").replace(/\.[a-z]+$/, "");
      const ancestralKeyword = postmortemSymptom ? `${postmortemSymptom} ${pathKeyword}` : pathKeyword;
      const ancestral = await queryRelevantPostmortems({
        keyword: ancestralKeyword,
        excludeFilePath: relPath,
        repo: "self",
        limit: 5,
      });
      ancestralBlock = formatAncestralPromptBlock(ancestral);
    } catch (error) {
      console.error(`Failed to retrieve ancestral RAG for ${relPath}:`, error);
      /* best-effort */
    }
  }

  // ── 3. PRIOR-ART RAG (GitHistory-Sync fleet corpus) ─────────────
  // Refactor mode only — the engine corpus is backend logic; styling
  // prompts have no use for it. Same exclusion as arch context. Reuses
  // the ancestral keyword (symptom + relPath) for consistency.
  let priorArtBlock = "";
  if (mode === "refactor") {
    try {
      // Reuse the already constructed keyword from above
      const pathKeyword = relPath.replace(/[\/\\]/g, " ").replace(/\.[a-z]+$/, "");
      const ancestralKeyword = postmortemSymptom ? `${postmortemSymptom} ${pathKeyword}` : pathKeyword;
      const engineHits = searchEngines(ancestralKeyword, 3);
      priorArtBlock = formatPriorArtBlock(engineHits);
    } catch (error) {
      console.error(`Failed to retrieve prior art for ${relPath}:`, error);
      /* best-effort */
    }
  }

  // ── 4. LESSONS (promoted procedures + bounded general rules) ───
  // D2 two-track: PROMOTED procedures inject through a separate,
  // unbounded Operating Constraints block ABOVE the postmortem; the
  // bounded block carries the rest under a hard byte budget.
  let operatingBlock = "";
  let lessonsBlock = "";
  try {
    const promoted: LessonRow[] = await getPromotedProcedures();
    const ls = await getLessonsForPrompt();
    const all = [...promoted, ...ls];
    if (all.length > 0) {
      lessonIds = all.map((x) => x.id);
      operatingBlock = formatOperatingConstraintsBlock(promoted);
      lessonsBlock = formatLessonsBlock(ls);
      // Only mark lessons as injected if we actually have lesson IDs
      if (lessonIds.length > 0) {
        await markInjected(lessonIds);
      }
    }
  } catch (error) {
    console.error(`Failed to retrieve lessons for ${relPath}:`, error);
    /* lessons are an amplifier, not a gate */
  }

  // ── 5. REJECTED TRANSFORMS (this file's exhausted space) ────────
  let rejectedBlock = "";
  try {
    const rejected = await getRejectedTransformsForFile(relPath);
    rejectedBlock = formatRejectedTransformsBlock(rejected);
  } catch (error) {
    console.error(`Failed to retrieve rejected transforms for ${relPath}:`, error);
    /* best-effort */
  }

  // ── 6. ARCH CONTEXT (2-hop neighborhood) ───────────────────────
  // Refactor mode only (in the user prompt). Schema + visual-polish
  // skip it.
  let archContextBlock = "";
  if (mode === "refactor") {
    try {
      const arch = buildArchContext(filePath);
      if (arch.summary.length > 0) {
        archContextBlock = `\n--- ARCHITECTURE CONTEXT (2-hop neighborhood, ${arch.fileCount} files parsed, hop=${arch.hopCount}) ---\n${arch.summary}\n--- END ARCHITECTURE CONTEXT ---\n`;
      }
    } catch (error) {
      console.error(`Failed to build arch context for ${filePath}:`, error);
      /* arch context is a vision amplifier, not a gate */
    }
  }

  // ── 7. PROVENANCE DIGEST (the loop's own history with this file) ─
  // Mode-agnostic: the loop's prior attempts are relevant in all modes.
  let provenanceBlock = "";
  try {
    provenanceBlock = await buildProvenanceDigestForPrompt(relPath);
  } catch (error) {
    console.error(`Failed to build provenance digest for ${relPath}:`, error);
    /* best-effort */
  }

  // ── 3.75 MUTATION POLICY (learned transform-family prior) ────────
  // Refactor mode only — it steers WHAT KIND of change to make
  // (which transform families historically pass the gates); the
  // visual-polish and schema transforms are fixed by their mode, so a
  // strategy prior is noise there. Two-tier + honesty rules: see
  // mutation-policy.ts. Positioned AFTER provenance (history) and
  // BEFORE rejected (the exhausted space): policy says what TO do,
  // rejected says what NOT to do.
  let policyBlock = "";
  if (mode === "refactor") {
    try {
      policyBlock = await buildMutationPolicyBlock();
    } catch (error) {
      console.error(`Failed to build mutation policy block for ${relPath}:`, error);
      /* the policy is a prior, not a gate */
    }
  }

  // ── ASSEMBLE THE ORDERED BLOCKS ────────────────────────────────
  // The documented prompt structure (self-enhance-loop.ts comments):
  //   1. operating constraints (promoted procedures, always-on)
  //   2. postmortem (the active per-file constraint)
  //   3. provenance (the loop's wider history)
  //   3.5 mutation policy (learned transform prior) — refactor only
  //   4. rejected transforms (the exhausted space)
  //   5. ancestral (cross-file wisdom)
  //   6. priorArt (fleet corpus) — refactor only
  //   7. lessons (general rules, bounded)
  if (operatingBlock) systemBlocks.push(operatingBlock);
  if (postmortemBlock) systemBlocks.push(postmortemBlock);
  if (provenanceBlock) systemBlocks.push(provenanceBlock);
  if (policyBlock) systemBlocks.push(policyBlock);
  if (rejectedBlock) systemBlocks.push(rejectedBlock);
  if (ancestralBlock) systemBlocks.push(ancestralBlock);
  if (priorArtBlock) systemBlocks.push(priorArtBlock);
  if (lessonsBlock) systemBlocks.push(lessonsBlock);

  if (archContextBlock) userBlocks.push(archContextBlock);

  return { systemBlocks, userBlocks, lessonIds };
}