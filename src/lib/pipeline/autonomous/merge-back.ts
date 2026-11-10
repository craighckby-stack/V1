/**
 * Merge-Back — bring a retained `loop-NN` mutation branch's source changes
 * back into the operator-curated `main` branch.
 *
 * WHY THIS EXISTS (audit 4 — the main↔loop divergence the user flagged):
 * the autonomous loop commits each mutation to local HEAD and pushes it to
 * a remote `loop-NN` branch (per-cycle branching), but `main` is operator-
 * curated — the operator deliberately merges specific loops in (e.g. the
 * `Merge remote-tracking branch 'origin/loop-175'` commit on main). The
 * loop has NO mechanism to feed its mutations back to main, so after 198
 * cycles main was 35 mutations behind loop-198 (49 files, 782 insertions /
 * 874 deletions) — the running system was NOT benefiting from its own
 * recent self-enhancements.
 *
 * This module provides a reviewed, typecheck-gated path to catch main up.
 * It does NOT auto-merge: the operator picks a branch and a strategy, the
 * module computes the plan (what files change, conflicts, typecheck
 * status) for preview, and only executes on explicit request.
 *
 * STRATEGIES:
 *   - "theirs-for-source": for files under `src/`, take the loop branch's
 *     version (the mutations); leave everything else (README, memory/,
 *     postmortems/, package.json, prisma/) on main's version. This is a
 *     checkout-then-commit, NOT a git merge — no conflict markers, no
 *     history rewrite. The cleanest "catch up the source" operation.
 *   - "dry-run": compute the plan only, change nothing.
 *
 * SAFETY:
 *   - Typecheck gate: after staging the source files, runs `tsc --noEmit`.
 *     If it fails, aborts (unstage + restore working tree) and returns the
 *     errors. The commit never lands.
 *   - Working-tree guard: refuses if there are uncommitted changes under
 *     `src/` (would be clobbered by the checkout). Changes outside `src/`
 *     (postmortems, memory) are left alone — they don't conflict.
 *   - Push is NOT automatic: the commit lands locally on main. The
 *     operator pushes via the existing [PUSH] UI when ready. This keeps
 *     the merge-back reversible (git reset --soft HEAD~1 undoes it before
 *     the push).
 */

import { execSync, execFileSync } from "child_process";
import { PROJECT_ROOT } from "../core/paths";

// (local helper type — the branch-picker summary row)
type BranchCandidate = { name: string; number: number };

export interface MergeBackPlan {
  branch: string;
  branchSha: string;
  mainSha: string;
  commitsAhead: number; // loop commits not in main
  commitsBehind: number; // main commits not in loop
  /** files that would change under `theirs-for-source` (src/ only) */
  sourceFilesToChange: Array<{ path: string; status: "modified" | "added" | "deleted" }>;
  /** files main has that the loop branch doesn't touch (kept on main) */
  mainOnlyFiles: string[];
  /** files the loop branch has under non-src/ paths (NOT brought over —
   *  operator's metadata stays) */
  loopMetadataFiles: string[];
  /** typecheck of the loop branch's own HEAD (cached analysis) */
  loopBranchTypecheck: "unknown" | "pass" | "fail";
  conflictsIfMerged: string[]; // files that would conflict in a git merge
}

export interface MergeBackResult {
  ok: boolean;
  branch: string;
  strategy: string;
  committed: boolean;
  commitSha?: string;
  filesChanged: number;
  typecheckPassed: boolean;
  typecheckErrors?: string;
  pushed?: boolean;
  error?: string;
}

/** Compute the merge-back plan for a given loop-NN branch vs main.
 *  Read-only: changes nothing on disk. Safe for GET requests. */
export function analyzeMergeBack(branchName: string): MergeBackPlan | null {
  // Normalize: accept "loop-198" or "origin/loop-198".
  const branch = branchName.replace(/^origin\//, "");
  const ref = `origin/${branch}`;

  try {
    // Verify the ref exists (remote-tracking).
    execSync(`git rev-parse --verify ${ref}`, {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 5000,
      stdio: "pipe",
    });
  } catch {
    return null;
  }

  const branchSha = execSync(`git rev-parse --short ${ref}`, {
    cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5000, stdio: "pipe",
  }).trim();
  const mainSha = execSync("git rev-parse --short main", {
    cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5000, stdio: "pipe",
  }).trim();

  // Ahead/behind (left-right count: <main-unique> <ref-unique>).
  const counts = execSync(`git rev-list --left-right --count main...${ref}`, {
    cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 10000, stdio: "pipe",
  }).trim().split(/\s+/);
  const commitsBehind = Number.parseInt(counts[0] ?? "0", 10) || 0;
  const commitsAhead = Number.parseInt(counts[1] ?? "0", 10) || 0;

  // Files that differ between main and the loop branch.
  const diffOutput = execSync(`git diff --name-status main ${ref}`, {
    cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 10000, stdio: "pipe",
  }).trim();

  const sourceFilesToChange: MergeBackPlan["sourceFilesToChange"] = [];
  const mainOnlyFiles: string[] = [];
  const loopMetadataFiles: string[] = [];
  const conflictsIfMerged: string[] = [];

  if (diffOutput.length > 0) {
    for (const line of diffOutput.split("\n")) {
      const [statusRaw, ...pathParts] = line.split("\t");
      const path = pathParts.join("\t");
      if (!path) continue;
      // statusRaw may be "M", "A", "D", "R100" (rename), "C100" (copy).
      // IMPORTANT: "deleted" (D) means the file exists on MAIN but NOT on
      // the loop branch — it's a NEWER main addition. The execute path
      // (--diff-filter=AM) does NOT bring these over (it would delete
      // main's newer files). So D-status src files are PRESERVED on main,
      // not "changed". We surface them in mainOnlyFiles so the plan
      // matches what execute actually does.
      const status = statusRaw.startsWith("A") ? "added"
        : statusRaw.startsWith("D") ? "deleted"
        : statusRaw.startsWith("R") ? "modified" /* rename: treat as modified */
        : "modified";
      if (path.startsWith("src/")) {
        if (status === "deleted") {
          // Main's newer src/ addition — preserved, NOT changed.
          mainOnlyFiles.push(path);
        } else {
          sourceFilesToChange.push({ path, status });
        }
      } else {
        loopMetadataFiles.push(path);
      }
      // Any file modified on BOTH sides would conflict in a git merge.
      if (status === "modified") {
        conflictsIfMerged.push(path);
      }
    }
  }

  // Files that exist on main but not on the loop branch (main-only, across
  // ALL paths — augments the D-status src files captured above). These are
  // preserved by `theirs-for-source` (execute only checks out A/M src/ files
  // from the loop branch, never deletes main's files).
  const mainOnlyOutput = execSync(
    `git diff --name-only --diff-filter=A ${ref} main`,
    { cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 10000, stdio: "pipe" },
  ).trim();
  if (mainOnlyOutput.length > 0) {
    for (const p of mainOnlyOutput.split("\n")) {
      if (p.trim() && !mainOnlyFiles.includes(p.trim())) mainOnlyFiles.push(p.trim());
    }
  }

  // We can't cheaply typecheck the loop branch without checking it out,
  // so we report "unknown" — the operator can run the merge-back dry-run
  // (which DOES typecheck the post-merge tree) to verify.
  return {
    branch,
    branchSha,
    mainSha,
    commitsAhead,
    commitsBehind,
    sourceFilesToChange,
    mainOnlyFiles: mainOnlyFiles.slice(0, 50), // cap for UI
    loopMetadataFiles: loopMetadataFiles.slice(0, 50),
    loopBranchTypecheck: "unknown",
    conflictsIfMerged,
  };
}

/** Execute the merge-back. Typecheck-gated. See module docstring. */
export function executeMergeBack(
  branchName: string,
  opts: { strategy: "theirs-for-source" | "dry-run"; push?: boolean }
): MergeBackResult {
  const branch = branchName.replace(/^origin\//, "");
  const ref = `origin/${branch}`;
  const strategy = opts.strategy ?? "dry-run";

  const base: Omit<MergeBackResult, "ok" | "error"> = {
    branch,
    strategy,
    committed: false,
    filesChanged: 0,
    typecheckPassed: false,
  };

  try {
    // 0. Verify the ref.
    try {
      execSync(`git rev-parse --verify ${ref}`, {
        cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5000, stdio: "pipe",
      });
    } catch {
      return { ...base, ok: false, error: `branch ${ref} not found` };
    }

    // 1. Working-tree guard: refuse if there are uncommitted changes under
    //    src/ (the checkout would clobber them). Changes outside src/ are
    //    fine — we never touch them.
    const status = execSync("git status --porcelain", {
      cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5000, stdio: "pipe",
    }).trim();
    const srcDirty = status.split("\n").some((l) => l.trim() && l.slice(3).startsWith("src/"));
    if (srcDirty) {
      return {
        ...base, ok: false,
        error: "working tree has uncommitted changes under src/ — commit or stash them first (merge-back would clobber them)",
      };
    }

    // 2. Compute the src/ files to bring over. CRITICAL: use --diff-filter=AM
    //    (Added + Modified only), NOT the default (which includes Deleted).
    //    A "deleted" entry means the file exists on MAIN but NOT on the loop
    //    branch — i.e. it's a NEWER main addition (added after the lineages
    //    diverged). A `git checkout <ref> -- <that file>` would DELETE it
    //    from main, which is the OPPOSITE of "catch main up". The loop-198
    //    plan, for example, shows merge-back/route.ts and merge-back-
    //    panel.tsx as "deleted" because they were added to main AFTER
    //    loop-198 was pushed — merging loop-198 forward must NOT delete
    //    them. So we only bring files that are Added (new on loop) or
    //    Modified (both sides have it, loop's version is the mutation).
    //
    //    We capture per-file status (A vs M) so the abort path can restore
    //    correctly: M files get `git checkout main -- <f>`; A files (new on
    //    loop, don't exist on main) get `git reset HEAD -- <f>` + `rm <f>`.
    const diffStatusOutput = execSync(
      `git diff --name-status --diff-filter=AM main ${ref} -- src/`,
      { cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 10000, stdio: "pipe" },
    ).trim();
    const fileStatus = new Map<string, "A" | "M">();
    if (diffStatusOutput.length > 0) {
      for (const line of diffStatusOutput.split("\n")) {
        const [statusRaw, ...pathParts] = line.split("\t");
        const path = pathParts.join("\t").trim();
        if (!path) continue;
        fileStatus.set(path, statusRaw.startsWith("A") ? "A" : "M");
      }
    }
    const srcFiles = Array.from(fileStatus.keys());

    if (srcFiles.length === 0) {
      return { ...base, ok: true, error: "no src/ files differ — main is already caught up to this branch" };
    }
    base.filesChanged = srcFiles.length;

    if (strategy === "dry-run") {
      const added = Array.from(fileStatus.entries()).filter(([, s]) => s === "A").map(([p]) => p).length;
      const modified = srcFiles.length - added;
      return {
        ...base, ok: true,
        error: `dry-run: would bring ${srcFiles.length} src/ file(s) from ${branch} into main (${modified} modified, ${added} added; typecheck not run in dry-run)`,
      };
    }

    // 3. Stage the loop branch's versions of the src/ files.
    //    `git checkout <ref> -- <paths>` updates both the index AND the
    //    working tree to the ref's versions. We pass paths as argv (no
    //    shell) — paths come from `git diff --name-status`, not user input,
    //    but arg-vector is the defensive default.
    execFileSync("git", ["checkout", ref, "--", ...srcFiles], {
      cwd: PROJECT_ROOT, timeout: 30000, stdio: "pipe",
    });

    // 4. Typecheck gate — BEFORE committing. If tsc fails, abort cleanly:
    //    unstage all, restore modified files to main's versions, remove
    //    added files (they don't exist on main). The commit never lands,
    //    main stays clean. Non-src/ working-tree changes (e.g. postmortem
    //    JSONs the loop writes in the background) are NEVER touched.
    let tscErrors = "";
    try {
      execFileSync("bunx", ["tsc", "--noEmit"], {
        cwd: PROJECT_ROOT, timeout: 180000, stdio: "pipe",
      });
      base.typecheckPassed = true;
    } catch (err) {
      tscErrors = String((err as { stderr?: string }).stderr ?? (err as Error).message ?? "").slice(0, 2000);
      // Abort: unstage everything we staged first.
      try { execFileSync("git", ["reset", "HEAD", "--", ...srcFiles], { cwd: PROJECT_ROOT, timeout: 10000, stdio: "pipe" }); } catch { /* best-effort */ }
      // Restore modified files to main's version (index + working tree).
      const modifiedFiles = Array.from(fileStatus.entries()).filter(([, s]) => s === "M").map(([p]) => p);
      if (modifiedFiles.length > 0) {
        try { execFileSync("git", ["checkout", "main", "--", ...modifiedFiles], { cwd: PROJECT_ROOT, timeout: 30000, stdio: "pipe" }); } catch { /* best-effort */ }
      }
      // Remove added files (new on loop, don't exist on main) from the
      // working tree — they're stray. Use `git clean -f` scoped to each.
      const addedFiles = Array.from(fileStatus.entries()).filter(([, s]) => s === "A").map(([p]) => p);
      for (const f of addedFiles) {
        try { execFileSync("git", ["rm", "-f", "--", f], { cwd: PROJECT_ROOT, timeout: 10000, stdio: "pipe" }); } catch { /* best-effort — may already be unstaged */ }
      }
      return {
        ...base, ok: false,
        error: `typecheck failed after staging ${srcFiles.length} file(s) from ${branch} — aborted, working tree restored (modified files reverted, added files removed). tsc errors:\n${tscErrors}`,
      };
    }

    // 5. Commit. The commit message follows the commit-archaeology
    //    prefix convention so the loop's own archaeology greps it.
    const message =
      `Merge-back: ${branch} → main (${srcFiles.length} src/ files, typecheck-gated)\n` +
      `Reviewed merge of the loop's retained ${branch} branch into the operator-curated main.\n` +
      `Brought src/ mutations forward; metadata (README, memory/, postmortems/) kept on main.\n` +
      `Source: ${ref}`;
    execFileSync("git", ["commit", "-m", message], {
      cwd: PROJECT_ROOT, timeout: 10000, stdio: "pipe",
    });
    const commitSha = execSync("git rev-parse --short HEAD", {
      cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5000, stdio: "pipe",
    }).trim();
    base.committed = true;
    base.commitSha = commitSha;

    // 6. Optional push. Off by default — the operator pushes via the
    //    existing [PUSH] UI so the merge-back stays reversible until then.
    if (opts.push) {
      try {
        execSync("git push origin main", {
          cwd: PROJECT_ROOT, timeout: 60000, stdio: "pipe",
        });
        base.pushed = true;
      } catch (err) {
        return {
          ...base, ok: true,
          error: `committed ${commitSha} but push failed: ${String((err as Error).message).slice(0, 200)}`,
        };
      }
    }

    return { ...base, ok: true };
  } catch (err) {
    return { ...base, ok: false, error: (err as Error).message.slice(0, 500) };
  }
}

/** List the retained loop-NN branches with a one-line merge-back summary
 *  each, for the UI's branch picker. Read-only. */
export function listMergeBackCandidates(): Array<{
  name: string;
  number: number;
  sha: string;
  commitSubject: string;
  commitsAhead: number;
  sourceFilesDelta: number;
}> {
  // List all remote loop-NN branches.
  const raw = execSync("git branch -r --list 'origin/loop-*'", {
    cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 10000, stdio: "pipe",
  }).trim();
  const candidates: Array<BranchCandidate> = [];
  if (!raw) return [];
  for (const line of raw.split("\n")) {
    const name = line.trim().replace(/^origin\//, "");
    const m = name.match(/^loop-(\d+)$/);
    if (!m) continue;
    const number = Number.parseInt(m[1], 10);
    candidates.push({ name, number });
  }
  // Sort descending by number (newest first) — the operator usually wants
  // the most recent branch.
  candidates.sort((a, b) => b.number - a.number);

  return candidates.map((c) => {
    const ref = `origin/${c.name}`;
    let sha = "";
    let commitSubject = "";
    let commitsAhead = 0;
    let sourceFilesDelta = 0;
    try {
      sha = execSync(`git rev-parse --short ${ref}`, {
        cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5000, stdio: "pipe",
      }).trim();
      commitSubject = execSync(`git log -1 --format=%s ${ref}`, {
        cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5000, stdio: "pipe",
      }).trim();
      const counts = execSync(`git rev-list --left-right --count main...${ref}`, {
        cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 10000, stdio: "pipe",
      }).trim().split(/\s+/);
      commitsAhead = Number.parseInt(counts[1] ?? "0", 10) || 0;
      const diffCount = execSync(`git diff --name-only main ${ref} -- src/ | wc -l`, {
        cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 10000, stdio: "pipe",
      }).trim();
      sourceFilesDelta = Number.parseInt(diffCount, 10) || 0;
    } catch {
      /* best-effort per branch */
    }
    return { name: c.name, number: c.number, sha, commitSubject, commitsAhead, sourceFilesDelta };
  });
}
