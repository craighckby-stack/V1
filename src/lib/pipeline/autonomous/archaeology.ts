/**
 * ARCHAEOLOGY — deterministic git-history mining (CAE port).
 *
 * The compounding-intelligence layer (Lesson/MutationCorpus, D1-D9) only
 * accumulates from RUNTIME failures — postmortems written while the loop
 * is alive. Everything that happened BEFORE the loop existed (the whole
 * human-era history: 455+ commits, dozens of wrong→fix pairs) is
 * invisible to it. The Lesson table starts with exactly one hand-planted
 * seed row.
 *
 * This module closes that gap the same way the Commit Archaeology Engine
 * (CAE — see upload/commit_history_split.py and the studio brief §7)
 * does: mine the repo's own git history with a DETERMINISTIC 3-path
 * detector and convert what it finds into the loop's native memory
 * formats.
 *
 * The three detection paths (proven across three generations of this
 * logic — python CLI → CAE server → here; same regex lineage):
 *   1. REVERTED  — a later commit body contains "This reverts commit
 *      <hash>". The reverted commit is WRONG; the revert is its fix.
 *   2. SELF-FAIL — the subject itself confesses (wip/broken/attempt/
 *      didn't work/failed/hotfix/hacky/...).
 *   3. FIX-PAIR — a fix-subject commit walks BACKWARD to the closest
 *      preceding commit with overlapping files and brands it WRONG.
 *
 * What the findings become (each goes where the architecture already
 * consumes that shape of information):
 *   - CROSS-FILE recurring failure themes  → Lesson rows
 *     (sourceType "archaeology", kind "judgment" — they compete for
 *     injection by score exactly like distilled lessons, and the D1
 *     lapse / D9 revocation machinery measures them the same way. A
 *     mined lesson that doesn't transfer dies by the same rules as a
 *     distilled one — no special trust.)
 *   - Per-file fragility map (wrongCycles per file)  → report artifact.
 *     File-specific facts stay OUT of the Lesson table on purpose —
 *     "a bad lesson is file-specific; that's what postmortems are for"
 *     — the per-file story belongs to the scar log, not the transfer
 *     layer.
 *   - Historically-stable files (correct-rich, wrong-free, untouched
 *     for weeks)  → report artifact — predictive evidence for the
 *     stable-file cooldown heuristic (loop-runtime), which until now
 *     could only learn stability REACTIVELY (after burning attempts).
 *
 * COST: zero LLM calls. The detector is pure regex + git log. It runs
 * even while the LLM gate is 429-blocked — arguably the BEST time to
 * mine history is exactly when mutations can't run.
 *
 * IDEMPOTENT: re-running without { force: true } is a no-op once
 * archaeology lessons exist (same contract as seedLessons).
 */

import { spawnSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { db } from "@/lib/db";
import { exportLessonsMarkdown } from "./lessons-markdown";

import { PROJECT_ROOT } from "../core/paths";
const REPORT_PATH = join(PROJECT_ROOT, "postmortems", "archaeology-report.json");

/** Max general lessons one mining pass may plant. Deliberately small:
 *  these are UNMEASURED at birth (score 1.0, benefit of the doubt) —
 *  flooding the table with them would drown the measured lessons in
 *  the bounded prompt block. */
export const MAX_ARCHAEOLOGY_LESSONS = 6;
/** A theme only becomes a lesson when at least this many commits
 *  support it — one repair is an event, two is a coincidence, three
 *  is a pattern. High bar on purpose: these lessons are UNMEASURED at
 *  birth; precision beats recall. */
const MIN_THEME_EVIDENCE = 3;
/** Days of untouched + wrong-free history before a file counts as a
 *  stable candidate. (This repo is young — 21 days would yield nothing.) */
const STABLE_DAYS = 10;
/** Days of untouched + correct-rich history for the stable list. */
const STABLE_MIN_CORRECT = 3;

// ── Detection patterns (verbatim lineage from commit_history_split.py
//    → CAE server.ts — three generations, one regex family) ──────────
const REVERT_HASH_PATTERN = /This reverts commit ([0-9a-f]{7,40})/i;
const FAILURE_WORDS =
  /\b(wip|broken|attempt|trying|fixup|squash|didn'?t work|did not work|failed|failure|revert|undo|rollback|hotfix|hacky|kludge)\b/i;
const FIX_PATTERN = /\b(fix|fixes|fixed|bugfix|patch)\b/i;

// Machine-generated / checkpoint subjects — factual about state, not
// about quality. Branding them WRONG via fix-walk-back would be pure
// noise (this repo's history is full of both shapes).
const UUID_SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i;
const CHECKPOINT_SUBJECT = /^Manual push\b/i;

// Files that are provenance noise for fragility scoring — the tool's
// own outputs must never contaminate its inputs (same rule as CAE's
// isLedgerOrMetaFile), and only CODE files matter for the loop's
// universe anyway.
const META_FILE_PATTERN =
  /(^|\/)(CORRECT|WRONG|stuff|COMMITS_LEDGER|RAW_GIT_LOG|SUMMARY|metadata|README|CHANGELOG|POSTMORTEMS|APPLIEDLEARNING)(-[^/]*)?\.(md|json|txt)$/i;
const CODE_FILE_PATTERN = /\.(ts|tsx|prisma|sql|sh|py|css)$/i;

interface RawCommit {
  hash: string;
  short: string;
  date: string; // YYYY-MM-DD
  subject: string;
  body: string;
  files: string[];
  isMerge: boolean;
  isRevert: boolean;
  isCheckpoint: boolean;
  wrong: boolean;
  wrongReason: string;
  fixedBy: string | null;
}

export interface FragileFile {
  file: string;
  wrongCycles: number;
  correctCommits: number;
  lastTouched: string;
}

export interface StableFile {
  file: string;
  correctCommits: number;
  lastTouched: string;
}

export interface ArchaeologyReport {
  ranAt: string;
  totalCommits: number;
  wrongCommits: number;
  fixPairs: number;
  lessonsSeeded: number;
  lessonsSkipped?: string;
  fragileFiles: FragileFile[];
  stableFiles: StableFile[];
  themes: Array<{ theme: string; count: number }>;
  wrongList: Array<{ short: string; date: string; subject: string; reason: string; fixedBy: string | null }>;
}

type LessonDelegate = typeof db.lesson | undefined;

/** Same fail-soft delegate check as lesson-store: a running process that
 *  predates the Lesson model treats "no table" as "no lessons" — the
 *  mining still runs, the report is still written, seeding is dormant
 *  until the next restart. */
function lessons(): LessonDelegate {
  const d = (db as unknown as { lesson?: LessonDelegate }).lesson;
  return typeof d?.findMany === "function" ? d : undefined;
}

/** TWO git passes — the same design as the reference implementation
 *  (commit_history_split.py). One call can't do it: with --name-only,
 *  git emits the pretty format, a newline, THEN the file list, so any
 *  record separator placed in the format lands BETWEEN the meta and
 *  the files — every file list would attach to the wrong commit (and
 *  multi-line bodies would bleed into the file list besides).
 *
 *    Pass 1: meta only  — %H %ad %s %b, \x1f between fields, \x1e
 *                        between commits. Multi-line bodies stay
 *                        intact inside field 4.
 *    Pass 2: files only — %H then --name-only; \x1e between commits,
 *                        keyed by full hash.
 */
function readGitHistory(): RawCommit[] {
  const metaRes = spawnSync(
    "git",
    ["log", "--date=short", "--pretty=format:%H%x1f%ad%x1f%s%x1f%b%x1e"],
    { cwd: PROJECT_ROOT, timeout: 15000, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  if (metaRes.error || metaRes.status !== 0) {
    throw new Error(`git log (meta) failed: ${metaRes.error?.message ?? metaRes.stderr?.slice(0, 200)}`);
  }

  // Pass 2 → files-by-hash map. The separator goes BEFORE the hash
  // (%x1e%H): git emits the pretty format, a newline, THEN the file
  // list — a trailing separator would bind every hash to the NEXT
  // commit's files. A leading separator binds it to its own.
  const filesRes = spawnSync(
    "git",
    ["log", "--date=short", "--pretty=format:%x1e%H", "--name-only"],
    { cwd: PROJECT_ROOT, timeout: 15000, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  if (filesRes.error || filesRes.status !== 0) {
    throw new Error(`git log (files) failed: ${filesRes.error?.message ?? filesRes.stderr?.slice(0, 200)}`);
  }

  // Pass 2 → files-by-hash map.
  const filesByHash = new Map<string, string[]>();
  for (const raw of (filesRes.stdout ?? "").split("\x1e")) {
    const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const hash = lines[0];
    const files = lines
      .slice(1)
      .filter((l) => !META_FILE_PATTERN.test(l));
    if (!filesByHash.has(hash)) filesByHash.set(hash, files);
  }

  // Pass 1 → commit records.
  const commits: RawCommit[] = [];
  for (const raw of (metaRes.stdout ?? "").split("\x1e")) {
    if (!raw.trim()) continue;
    const fields = raw.replace(/^\n/, "").split("\x1f");
    if (fields.length < 3) continue;
    const [hash, date, subject, ...bodyParts] = fields;
    const body = bodyParts.join("\x1f").trim();
    const isMerge = /^Merge (?:branch|pull request|remote-tracking|tag|commit|#\d+)/i.test(subject);
    // Merge commits are structural, not judgments about code quality —
    // excluded from wrongness analysis both ways.
    if (isMerge) continue;
    const isRevert = REVERT_HASH_PATTERN.test(subject) || REVERT_HASH_PATTERN.test(body);
    const isCheckpoint = UUID_SUBJECT.test(subject) || CHECKPOINT_SUBJECT.test(subject);
    commits.push({
      hash,
      short: hash.slice(0, 8),
      date,
      subject,
      body,
      files: filesByHash.get(hash) ?? [],
      isMerge,
      isRevert,
      isCheckpoint,
      wrong: false,
      wrongReason: "",
      fixedBy: null,
    });
  }
  return commits; // git log is newest-first; caller reverses for chronology
}

/** The 3-path detector. Mutates the array in place (same contract as
 *  the python original) and returns it, chronological order. */
function detect(commits: RawCommit[]): RawCommit[] {
  const chrono = [...commits].reverse();

  // 1. Revert pairing — strongest signal, runs first.
  const byHash = new Map(chrono.map((c) => [c.hash, c]));
  for (const c of chrono) {
    const m = c.body.match(REVERT_HASH_PATTERN) ?? c.subject.match(REVERT_HASH_PATTERN);
    if (!m) continue;
    const target =
      byHash.get(m[1]) ??
      chrono.find((tc) => tc.hash.startsWith(m[1]) || m[1].startsWith(tc.short));
    if (!target || target === c) continue;
    if (!target.wrong) {
      target.wrong = true;
      target.wrongReason = `Reverted by ${c.short}`;
      target.fixedBy = c.short;
    }
  }

  // 2. Self-confessed failure. Three exclusions: revert commits (the
  //    word "Revert" would self-match), FIX-subject commits — a
  //    subject like "fix: failed-file cooldown" DESCRIBES a failure
  //    it is correcting; flagging it would invert the corpus (CAE
  //    reached the same effect by running fix-detection before
  //    self-fail) — and checkpoint subjects (state, not quality).
  for (const c of chrono) {
    if (c.wrong || c.isRevert || c.isCheckpoint) continue;
    if (FIX_PATTERN.test(c.subject)) continue;
    if (FAILURE_WORDS.test(c.subject)) {
      c.wrong = true;
      c.wrongReason = `Self-identified failure in subject ("${c.subject.slice(0, 80)}")`;
    }
  }

  // 3. Fix backward-matching — a fix commit walks back to the closest
  //    preceding same-file commit that isn't itself a fix. (Walk-back,
  //    not immediate-successor: bugs can sit 2-3 commits before their
  //    fix — the CAE improvement over the python original.)
  //    ATTRIBUTED wrongs only: this path is probabilistic (the walk
  //    back may brand an innocent bystander) — its findings feed the
  //    fragility map, never the lesson themes.
  for (let i = 0; i < chrono.length; i++) {
    const c = chrono[i];
    if (!FIX_PATTERN.test(c.subject) || c.isRevert) continue;
    for (let j = i - 1; j >= 0; j--) {
      const pred = chrono[j];
      if (FIX_PATTERN.test(pred.subject) || pred.isCheckpoint) continue; // a fix isn't the bug; a checkpoint isn't a judgment
      const overlap = pred.files.filter((f) => c.files.includes(f));
      if (overlap.length > 0) {
        if (!pred.wrong) {
          pred.wrong = true;
          pred.wrongReason = `Introduced issue in ${overlap[0]}, fixed by ${c.short} ("${c.subject.slice(0, 60)}")`;
        }
        if (!pred.fixedBy) pred.fixedBy = c.short;
        break; // closest preceding introducer only
      }
    }
  }
  return chrono;
}

/** Extract the themes that earn lesson-hood — from CONFIDENT evidence
 *  only, never from fix-walk-back attributions (which are probabilistic
 *  and misfire on dense same-file histories):
 *    - REVERT-paired and SELF-FAIL commits (the subject confesses), and
 *    - FIX commits themselves — a fix is confident evidence that its
 *      AREA broke, even when the introducer is unknowable. The theme of
 *      a fix subject ("duress", "hot-swap", "push-target") is a
 *      reliable "this subsystem needed repairs N times" signal.
 *  A theme with >= MIN_THEME_EVIDENCE supporting commits is a recurring
 *  failure class — the only thing deterministic mining is entitled to
 *  turn into a GENERAL lesson. */
function extractThemes(chrono: RawCommit[]): Array<{ theme: string; count: number; shas: string[] }> {
  const STOP = new Set([
    // commit grammar / prefixes
    "fix", "fixes", "fixed", "bugfix", "patch", "feat", "refactor", "graft", "chore",
    "docs", "style", "test", "perf", "build", "self", "concept", "manual", "mine",
    "enhancement", "current", "live", "state", "push", "update", "audit", "v433",
    // common connective/technical words that carry no theme
    "add", "adds", "the", "and", "for", "with", "into", "from", "this", "that",
    "when", "where", "what", "which", "will", "must", "should", "than", "then",
    "not", "now", "stop", "kill", "make", "made", "keep", "gets", "gone", "only",
    "every", "entry", "each", "more", "most", "less", "over", "under", "have",
    "does", "doesnt", "dont", "cant", "wont", "cant", "always", "never", "again",
    "used", "using", "uses", "undefined", "binding", "field", "fields", "name",
    "names", "shape", "wire", "wired", "real", "true", "false", "path", "read",
    "back", "pre", "gate", "dead", "race", "retry", "honesty", "restore", "lost",
    "stash", "existing", "type", "types", "errors", "error", "correct", "wrong",
    "broken", "attempt", "trying", "failed", "failure", "revert", "reverts",
    "rollback", "undo", "hotfix", "hacky", "kludge", "wip", "squash", "fixup",
  ]);
  const counts = new Map<string, { count: number; shas: string[] }>();
  const feed = (subject: string, sha: string) => {
    const words = new Set(
      subject
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4 && w.length <= 24 && !STOP.has(w) && !/^v\d/.test(w))
    );
    for (const w of words) {
      const e = counts.get(w) ?? { count: 0, shas: [] };
      e.count++;
      e.shas.push(sha);
      counts.set(w, e);
    }
  };
  for (const c of chrono) {
    // Confident sources: confessed wrongs (revert-paired or self-fail —
    // both carry a wrongReason set by paths 1-2) and fix commits.
    const confessed = c.wrong && c.wrongReason && !c.wrongReason.startsWith("Introduced issue");
    const isFix = FIX_PATTERN.test(c.subject) && !c.isRevert;
    if (!confessed && !isFix) continue;
    feed(c.subject, c.short);
  }
  return [...counts.entries()]
    .map(([theme, e]) => ({ theme, count: e.count, shas: e.shas }))
    .sort((a, b) => b.count - a.count);
}

function daysSince(dateStr: string): number {
  const t = Date.parse(dateStr);
  if (isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/** Mine LOOP's own history and seed the findings. Deterministic, no LLM.
 *  Returns the report; throws only when git itself fails. */
export async function runArchaeology(force = false): Promise<ArchaeologyReport> {
  const chrono = detect(readGitHistory());

  // ── Per-file fragility + stability ─────────────────────────────────
  const fileStats = new Map<string, { wrong: number; correct: number; lastTouched: string; lastTs: number }>();
  for (const c of chrono) {
    const ts = Date.parse(c.date) || 0;
    for (const f of c.files) {
      const e = fileStats.get(f) ?? { wrong: 0, correct: 0, lastTouched: c.date, lastTs: 0 };
      if (c.wrong) e.wrong++;
      else e.correct++;
      if (ts >= e.lastTs) {
        e.lastTs = ts;
        e.lastTouched = c.date;
      }
      fileStats.set(f, e);
    }
  }
  const fragileFiles: FragileFile[] = [...fileStats.entries()]
    .filter(([f, e]) => e.wrong > 0 && CODE_FILE_PATTERN.test(f))
    .map(([file, e]) => ({ file, wrongCycles: e.wrong, correctCommits: e.correct, lastTouched: e.lastTouched }))
    .sort((a, b) => b.wrongCycles - a.wrongCycles)
    .slice(0, 15);
  const stableFiles: StableFile[] = [...fileStats.entries()]
    .filter(
      ([f, e]) =>
        e.wrong === 0 &&
        e.correct >= STABLE_MIN_CORRECT &&
        daysSince(e.lastTouched) >= STABLE_DAYS &&
        CODE_FILE_PATTERN.test(f) // only code files are loop candidates
    )
    .map(([file, e]) => ({ file, correctCommits: e.correct, lastTouched: e.lastTouched }))
    .sort((a, b) => b.correctCommits - a.correctCommits)
    .slice(0, 15);

  // ── Lesson seeding (cross-file themes only) ────────────────────────
  const themes = extractThemes(chrono).filter((t) => t.count >= MIN_THEME_EVIDENCE);
  const wrongCommits = chrono.filter((c) => c.wrong);
  const fixPairs = wrongCommits.filter((c) => c.fixedBy).length;

  let lessonsSeeded = 0;
  let lessonsSkipped: string | undefined;
  const l = lessons();
  if (!l) {
    lessonsSkipped = "Lesson table dormant in this process — restart the server, then re-run (force) to seed.";
  } else {
    const existingArch = await l.findFirst({ where: { sourceType: "archaeology" } });
    if (existingArch && !force) {
      lessonsSkipped = "already seeded (re-run with force to refresh)";
    } else {
      const existingContents = (
        (await l.findMany({ select: { content: true } })) as Array<{ content: string }>
      ).map((e) => e.content.toLowerCase());
      for (const t of themes.slice(0, MAX_ARCHAEOLOGY_LESSONS)) {
        const content =
          `Historical repair cluster "${t.theme}": ${t.count} fix/failure commits in this codebase's git history target this theme ` +
          `(evidence: ${t.shas.slice(0, 4).join(", ")}). The area has a documented history of subtle breakage — when mutating ${t.theme}-related code, prefer minimal surgical diffs and explicitly verify the behavior that previously broke.`;
        if (content.length > 400) continue;
        // Same dedupe contract as distillLessons: exact-prefix match
        // against everything already known.
        if (existingContents.some((e) => e.includes(content.toLowerCase().slice(0, 60)))) continue;
        try {
          await l.create({
            data: {
              content,
              kind: "judgment",
              sourceType: "archaeology",
              sourceCount: t.count,
            },
          });
          lessonsSeeded++;
        } catch {
          /* skip this one — best-effort by contract */
        }
      }
      // D6: mirror the table to memory/lessons.md immediately (same as
      // seedLessons — don't wait for the next distillation).
      if (lessonsSeeded > 0) {
        void exportLessonsMarkdown().catch(() => {});
      }
    }
  }

  const report: ArchaeologyReport = {
    ranAt: new Date().toISOString(),
    totalCommits: chrono.length,
    wrongCommits: wrongCommits.length,
    fixPairs,
    lessonsSeeded,
    ...(lessonsSkipped ? { lessonsSkipped } : {}),
    fragileFiles,
    stableFiles,
    themes: themes.slice(0, 10).map(({ theme, count }) => ({ theme, count })),
    wrongList: [...wrongCommits]
      .reverse() // newest first, ledger convention
      .slice(0, 30)
      .map((c) => ({ short: c.short, date: c.date, subject: c.subject, reason: c.wrongReason, fixedBy: c.fixedBy })),
  };

  try {
    mkdirSync(join(PROJECT_ROOT, "postmortems"), { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  } catch {
    /* report is advisory; a write failure must not fail the run */
  }
  return report;
}

/** GET handler backing store — returns the last report or null. */
export function readArchaeologyReport(): ArchaeologyReport | null {
  try {
    if (!existsSync(REPORT_PATH)) return null;
    return JSON.parse(readFileSync(REPORT_PATH, "utf8")) as ArchaeologyReport;
  } catch {
    return null;
  }
}
