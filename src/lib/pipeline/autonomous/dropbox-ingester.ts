/**
 * dropbox-ingester.ts — the loop learns from external systems.
 *
 * WHAT THIS IS
 * ───────────
 * The #8 from the 10/10 list: the "learns from other systems" axis.
 * The operator drops files into `dropbox/<system>/` (e.g.
 * `dropbox/darlek-caan/voice.ts`, `dropbox/darlek-caan/spec.pdf`).
 * This module walks the folder, dedupes by content hash, classifies
 * each leaf (text/PDF/binary), extracts text, and distills CANDIDATE
 * lessons tagged `source: "dropbox"`, `system: "<top-level-folder>"`.
 *
 * THE TRUST MODEL (the candidate → verified → promoted lifecycle)
 * ──────────────────────────────────────────────────────────────
 * Dropbox lessons are NEVER injected as PROCEDURE (permanent
 * operating constraints). They seed as `kind: "judgment"` (scorable),
 * `source: "dropbox"`. The bandit scores them: if a dropbox lesson
 * helps a mutation, its score rises; if it hurts, it falls. The
 * existing `getLessonsForPrompt` injects by score — so a helpful
 * dropbox lesson naturally rises into the prompt, and a harmful one
 * sinks out. This is the same lifecycle as autonomous lessons,
 * except the SOURCE tag makes them auditable + excludable.
 *
 * The autonomous distiller's sourceCount (countPostmortems) already
 * filters to `source: "autonomous"` postmortems — so dropbox lessons
 * never inflate the aggregate distiller input. They ride the bandit,
 * not the distiller.
 *
 * DEDUP (the content-hash manifest)
 * ────────────────────────────────
 * A manifest at `.git/info/loop-dropbox-manifest.json` records every
 * ingested file's sha256 + mtime. On each scan, only files with a
 * NEW or CHANGED hash are ingested; unchanged files are skipped. So
 * the common case (reload, nothing new) is O(new files), not O(total).
 *
 * WHAT GETS EXTRACTED
 * ──────────────────
 * - `.ts`/`.tsx`/`.js`/`.jsx`/`.py`/`.go`/`.rs`/`.java`/`.md`/`.txt`/
 *   `.json`/`.yaml`/`.yml`/`.css`/`.html` — read as UTF-8 text.
 * - `.pdf` — text extraction via `pdftotext` shell-out (if available);
 *   falls back to skipping if pdftotext isn't installed.
 * - binaries (images, archives) — skipped (a future VLM pass could
 *   describe them; not now).
 *
 * THE DISTILL CALL (one LLM pass per new file)
 * ───────────────────────────────────────────
 * The extracted text (capped at 8000 chars) is sent to the LLM with
 * a "distill 1-3 candidate lessons from this" prompt. The LLM returns
 * JSON; each lesson is seeded as a candidate. The call is BUDGET-
 * CAPPED: at most MAX_INGEST_PER_SCAN files per scan (default 3) so a
 * 500-file dropbox doesn't burn the LLM quota in one cycle.
 *
 * PERFORMANCE
 * ───────────
 * Walking + hashing is cheap (fs + crypto). The LLM call is the cost
 * — capped at MAX_INGEST_PER_SCAN. Best-effort: any failure (LLM
 * unavailable, pdftotext missing, unreadable file) skips that file
 * and continues. Never throws into the caller.
 *
 * INTEGRITY: this module is in PROTECTED_FILES so the loop can't
 * rewrite its own ingestion rule or bypass the candidate gate.
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from "fs";
import { join, relative, extname, dirname } from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { db } from "@/lib/db";
import { llmComplete } from "../llm/agent-llm";
import { PROJECT_ROOT } from "../core/paths";
import { atomicWriteFileSync } from "../core/atomic-file";

/** The dropbox folder root. The operator creates this and drops
 *  `dropbox/<system>/` subfolders into it. */
const DROPBOX_DIR = join(PROJECT_ROOT, "dropbox");

/** The dedup manifest. Lives in .git/info/ (wipe-proof, never tracked). */
const MANIFEST_PATH = join(PROJECT_ROOT, ".git/info/loop-dropbox-manifest.json");

/** Max files to ingest per scan (budget cap — the LLM call is the cost). */
const MAX_INGEST_PER_SCAN = 3;

/** Max chars of extracted text to send to the LLM per file. */
const MAX_TEXT_CHARS = 8000;

/** Text extensions we can read as UTF-8. */
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".swift", ".rb", ".php",
  ".md", ".txt", ".rst",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".css", ".scss", ".html", ".xml", ".svg",
  ".sh", ".bash", ".zsh",
  ".sql",
]);

interface ManifestEntry {
  /** sha256 of the file content — the dedupe key. */
  hash: string;
  /** mtime at last ingest (for the "skip unchanged" fast path). */
  mtime: number;
  /** When this file was last ingested (ISO). */
  ingestedAt: string;
  /** How many candidate lessons were distilled from it. */
  lessonsDistilled: number;
}

interface Manifest {
  [filePath: string]: ManifestEntry;
}

interface IngestResult {
  scanned: number;
  newFiles: number;
  ingested: number;
  lessonsDistilled: number;
  skipped: string[];
  errors: string[];
}

/** Read the dedup manifest. Returns {} if absent/unreadable. */
function readManifest(): Manifest {
  try {
    if (!existsSync(MANIFEST_PATH)) return {};
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
  } catch {
    return {};
  }
}

/** Write the manifest atomically. Best-effort. */
function writeManifest(manifest: Manifest): void {
  try {
    mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
    atomicWriteFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  } catch {
    /* best-effort */
  }
}

/** sha256 of a file's content. Returns null on read failure. */
function hashFile(absPath: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
}

/** Walk a directory recursively, returning all file paths (leaves only). */
function walkDir(dir: string, acc: string[] = []): string[] {
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walkDir(full, acc);
      } else if (st.isFile()) {
        acc.push(full);
      }
    }
  } catch {
    /* unreadable dir — skip */
  }
  return acc;
}

/** Extract text from a file. Returns { text, kind } or null if
 *  unsupported. `.pdf` uses pdftotext; text extensions read UTF-8;
 *  binaries return null. */
function extractText(absPath: string): { text: string; kind: string } | null {
  const ext = extname(absPath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    try {
      const raw = readFileSync(absPath, "utf8");
      return { text: raw.slice(0, MAX_TEXT_CHARS), kind: "text" };
    } catch {
      return null;
    }
  }
  if (ext === ".pdf") {
    // Use pdftotext (poppler-utils) if available. Synchronous shell-out
    // — pdftotext is fast for text extraction. Falls back to null if
    // the binary isn't installed (the file is skipped with a note).
    try {
      const text = execSync(`pdftotext "${absPath}" - 2>/dev/null`, {
        maxBuffer: 2 * 1024 * 1024,
        timeout: 10000,
        encoding: "utf8",
      }).slice(0, MAX_TEXT_CHARS);
      return { text, kind: "pdf" };
    } catch {
      return null;
    }
  }
  return null; // binary or unsupported
}

/** The system tag = the top-level folder name under dropbox/.
 *  `dropbox/darlek-caan/voice.ts` → "darlek-caan". "untitled" if
 *  the file is directly in dropbox/ (no system subfolder). */
function systemTagFor(absPath: string): string {
  const rel = relative(DROPBOX_DIR, absPath);
  const top = rel.split("/")[0] ?? "";
  return top || "untitled";
}

/** Distill candidate lessons from extracted text via one LLM call.
 *  Returns an array of { content, kind } — the LLM's proposed rules.
 *  Best-effort: returns [] on any LLM failure or unparseable output. */
async function distillCandidateLessons(
  text: string,
  systemTag: string,
  filePath: string,
): Promise<Array<{ content: string; kind: string }>> {
  const systemPrompt = `You are distilling CANDIDATE lessons from an external system's source file. The operator dropped a file from the "${systemTag}" system into the dropbox folder. Extract 1-3 general imperative rules that could transfer to OTHER codebases — patterns, conventions, or design principles visible in this code.

Rules for the lessons:
- Phrase each as a one-sentence imperative ("Never...", "Always...", "Prefer...").
- Make it GENERAL (applies across files, not specific to this one).
- Make it ACTIONABLE (a developer could follow it).
- Only extract lessons that are genuinely transferable — skip anything too specific to this file.

Source file: ${filePath}
System tag: ${systemTag}

Return JSON: { "lessons": [{ "content": "...", "kind": "judgment" }] }
If the file has no transferable lessons, return { "lessons": [] }.`;

  try {
    const result = await llmComplete({
      systemPrompt,
      userPrompt: `Source text (first ${MAX_TEXT_CHARS} chars):\n\n${text}`,
      temperature: 0.3,
    });
    if (!result.ok) return [];
    // Parse the JSON — the LLM may wrap it in markdown fences.
    const match = result.content.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { lessons?: Array<{ content: string; kind: string }> };
    if (!Array.isArray(parsed.lessons)) return [];
    return parsed.lessons.filter((l) => typeof l.content === "string" && l.content.length > 10).slice(0, 3);
  } catch {
    return [];
  }
}

/** Seed a candidate lesson into the Lesson table. Tagged
 *  `source: "dropbox"`, `system: <tag>`, `kind: "judgment"` (scorable,
 *  never PROCEDURE — the bandit scores it, the operator promotes).
 *  Best-effort: returns null on any DB failure. */
async function seedDropboxLesson(
  content: string,
  systemTag: string,
  _sourceFile: string,
): Promise<string | null> {
  try {
    const row = await db.lesson.create({
      data: {
        content: content.slice(0, 500),
        sourceType: "dropbox",
        source: "dropbox",
        system: systemTag,
        kind: "judgment",
        sourceCount: 1,
        // The lesson starts at score 0 (neutral). The bandit scores it
        // as it's injected + helped/hindered. Helpful lessons rise;
        // harmful ones sink. Same lifecycle as autonomous lessons.
      },
    });
    return row.id;
  } catch {
    return null;
  }
}

/** Scan the dropbox folder for new/changed files and ingest them.
 *  Returns the ingest result. Best-effort: never throws.
 *
 *  This is the main entry point. Called by:
 *    - the curiosity drive (one file per curious cycle, budget-capped)
 *    - the `dropbox` console command (operator-triggered full scan)
 *    - a future pre-flight step (the boot ceremony)
 */
export async function ingestDropbox(): Promise<IngestResult> {
  const result: IngestResult = {
    scanned: 0,
    newFiles: 0,
    ingested: 0,
    lessonsDistilled: 0,
    skipped: [],
    errors: [],
  };

  if (!existsSync(DROPBOX_DIR)) {
    // No dropbox folder — dormant. The operator hasn't dropped anything yet.
    return result;
  }

  const allFiles = walkDir(DROPBOX_DIR);
  result.scanned = allFiles.length;
  if (allFiles.length === 0) return result;

  const manifest = readManifest();

  // Find new/changed files (hash differs or mtime changed or not in manifest).
  const toIngest: string[] = [];
  for (const absPath of allFiles) {
    const rel = relative(PROJECT_ROOT, absPath);
    const hash = hashFile(absPath);
    if (!hash) {
      result.skipped.push(`${rel} (unreadable)`);
      continue;
    }
    const st = statSync(absPath);
    const existing = manifest[rel];
    if (existing && existing.hash === hash && existing.mtime === st.mtimeMs) {
      // Unchanged — skip (the dedupe fast path).
      continue;
    }
    toIngest.push(absPath);
    result.newFiles++;
  }

  if (toIngest.length === 0) return result;

  // Budget cap: ingest at most MAX_INGEST_PER_SCAN per scan.
  const ingestBatch = toIngest.slice(0, MAX_INGEST_PER_SCAN);
  if (toIngest.length > MAX_INGEST_PER_SCAN) {
    result.skipped.push(`${toIngest.length - MAX_INGEST_PER_SCAN} file(s) deferred (budget cap — next scan)`);
  }

  for (const absPath of ingestBatch) {
    const rel = relative(PROJECT_ROOT, absPath);
    const systemTag = systemTagFor(absPath);
    const extracted = extractText(absPath);
    if (!extracted) {
      result.skipped.push(`${rel} (unsupported type or extraction failed)`);
      continue;
    }
    if (extracted.text.trim().length < 50) {
      result.skipped.push(`${rel} (too little text)`);
      continue;
    }
    const lessons = await distillCandidateLessons(extracted.text, systemTag, rel);
    let seeded = 0;
    for (const lesson of lessons) {
      const id = await seedDropboxLesson(lesson.content, systemTag, rel);
      if (id) seeded++;
    }
    result.lessonsDistilled += seeded;
    result.ingested++;

    // Update the manifest.
    const hash = hashFile(absPath);
    if (hash) {
      manifest[rel] = {
        hash,
        mtime: statSync(absPath).mtimeMs,
        ingestedAt: new Date().toISOString(),
        lessonsDistilled: seeded,
      };
    }
  }

  writeManifest(manifest);
  return result;
}

/** Get the dropbox status — what's been ingested, what's pending.
 *  For the `dropbox` console command + the /api/dropbox route. */
export async function getDropboxStatus(): Promise<{
  configured: boolean;
  totalFiles: number;
  ingestedFiles: number;
  pendingFiles: number;
  candidateLessons: number;
  bySystem: Array<{ system: string; lessons: number }>;
}> {
  const manifest = readManifest();
  const ingestedFiles = Object.keys(manifest).length;
  let totalFiles = 0;
  if (existsSync(DROPBOX_DIR)) {
    totalFiles = walkDir(DROPBOX_DIR).length;
  }
  const pendingFiles = Math.max(0, totalFiles - ingestedFiles);

  let candidateLessons = 0;
  const bySystemMap = new Map<string, number>();
  try {
    const lessons = await db.lesson.findMany({
      where: { source: "dropbox" },
      select: { system: true, active: true },
    });
    candidateLessons = lessons.filter((l) => l.active).length;
    for (const l of lessons) {
      const sys = l.system ?? "untitled";
      bySystemMap.set(sys, (bySystemMap.get(sys) ?? 0) + 1);
    }
  } catch {
    /* DB unavailable */
  }

  return {
    configured: existsSync(DROPBOX_DIR),
    totalFiles,
    ingestedFiles,
    pendingFiles,
    candidateLessons,
    bySystem: [...bySystemMap.entries()]
      .map(([system, lessons]) => ({ system, lessons }))
      .sort((a, b) => b.lessons - a.lessons),
  };
}
