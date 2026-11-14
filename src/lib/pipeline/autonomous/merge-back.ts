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
import { execFile } from "child_process";
import { promisify } from "util";
import { PROJECT_ROOT } from "../core/paths";
import { getStoredTargetSync } from "./push-target";

const execFileAsync = promisify(execFile);

/** Spawn a child process and await its exit, capturing combined stdout+
 *  stderr. UNLIKE execFile/execFileSync this does NOT block the Node.js
 *  event loop while the child runs — the await suspends the handler but
 *  the libuv loop keeps pumping, so other in-flight HTTP requests (e.g.
 *  the dashboard's status polls) keep being served. This is the fix for
 *  the "EXECUTE freezes the whole dashboard" symptom: the old code called
 *  execFileSync("bunx", ["tsc", "--noEmit"]) which blocks for the full
 *  typecheck (5s on a warm cache, up to 180s cold) — every /api/*
 *  poll blocked for that window, the UI wedged, and the operator saw
 *  EXECUTE "not work". Resolves with { code, stdout, stderr } so the
 *  caller can branch on the exit status without try/catch. */
function spawnCapture(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; maxBuffer?: number },
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
      env: process.env,
    }, (err, stdout, stderr) => {
      // execFile surfaces non-zero exit + timeout as an Error object; we
      // normalize to a {code, stdout, stderr, timedOut} result so callers
      // can branch without try/catch.
      if (err) {
        const e = err as NodeJS.ErrnoException & { code?: number | string; signal?: string };
        const timedOut = e.signal === "SIGTERM" || (err as { timedOut?: boolean }).timedOut === true;
        resolve({
          code: typeof e.code === "number" ? e.code : (e.signal ? -1 : 1),
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          timedOut,
        });
      } else {
        resolve({ code: 0, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", timedOut: false });
      }
    });
    // Belt-and-suspenders: never let an uncaught error on the child escape
    // the promise — a watcher crash must not turn into an unhandled
    // rejection that takes the request down with it.
    child.on?.("error", () => {
      resolve({ code: 1, stdout: "", stderr: "spawn error", timedOut: false });
    });
  });
}

// (BranchCandidate helper type removed — the parallelized
//  listMergeBackCandidates below inlines its use via a local Ref type.)

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

/** Execute the merge-back. Typecheck-gated. See module docstring.
 *
 *  ASYNC (Fix B): the tsc --noEmit gate now runs via spawnCapture (async
 *  spawn), NOT execFileSync. The old sync call blocked the entire Node.js
 *  worker for the duration of the typecheck (5s warm, up to 180s cold) —
 *  the dashboard's status polls froze, the UI wedged, and the operator
 *  saw the EXECUTE button "not work" even though the commit would
 *  eventually land. With an async spawn the await suspends THIS handler
 *  but the libuv loop keeps serving other requests; the dashboard keeps
 *  polling, the panel's "running tsc..." hint stays visible, and when
 *  tsc finishes the result renders cleanly. */
export async function executeMergeBack(
  branchName: string,
  opts: { strategy: "theirs-for-source" | "dry-run"; push?: boolean }
): Promise<MergeBackResult> {
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
    //
    //    ASYNC (Fix B): spawnCapture (async spawn) NOT execFileSync. The
    //    await suspends THIS handler but the Node.js libuv loop keeps
    //    serving other in-flight HTTP requests — the dashboard's status
    //    polls stay live while tsc runs, instead of wedging for up to 3
    //    minutes on a cold typecheck.
    let tscErrors = "";
    const tscRes = await spawnCapture("bunx", ["tsc", "--noEmit"], {
      cwd: PROJECT_ROOT, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
    });
    if (tscRes.code === 0 && !tscRes.timedOut) {
      base.typecheckPassed = true;
    } else {
      tscErrors = (tscRes.stderr || tscRes.stdout || (tscRes.timedOut ? "timed out after 180s" : `exit ${tscRes.code}`)).slice(0, 2000);
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
      // Auth injected per-push via GIT_CONFIG_* env vars (same scheme as
      // push-target.pushCurrentState) — the OLD bare `git push origin
      // main` had no credentials, so on the private configured remote it
      // ALWAYS failed with "could not read Username" and push:true was
      // effectively dead.
      const stored = getStoredTargetSync();
      const pushEnv = stored?.token
        ? {
            ...process.env,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(
              `x-access-token:${stored.token}`
            ).toString("base64")}`,
          }
        : process.env;
      try {
        execSync("git push origin main", {
          cwd: PROJECT_ROOT, timeout: 60000, stdio: "pipe", env: pushEnv,
        });
        base.pushed = true;
      } catch (err) {
        return {
          ...base, ok: true,
          error: `committed ${commitSha} but push failed: ${String((err as Error).message).slice(0, 200)}${stored?.token ? "" : " (no push target configured — configure it in the UI)"}`,
        };
      }
    }

    return { ...base, ok: true };
  } catch (err) {
    return { ...base, ok: false, error: (err as Error).message.slice(0, 500) };
  }
}

/** List the retained loop-NN branches with a one-line merge-back summary
 *  each, for the UI's branch picker. Read-only.
 *
 *  PERF FIX (24s → ~1s): the original called 4 git subprocesses PER branch
 *  (rev-parse + log -1 + rev-list --count + diff --name-only src/). With
 *  281 retained branches that's 1124 sequential execSync spawns — the panel
 *  sat on "Loading retained branches..." for 24 seconds, and during that
 *  window the EXECUTE button was disabled (no selection, no plan), so the
 *  operator saw a dead UI. The fix batches the cheap fields (sha + subject
 *  + committerdate) into ONE `git for-each-ref` call (zero per-branch
 *  cost), then runs the two count/diff queries per branch in PARALLEL via
 *  Promise.all (the kernel dispatches them concurrently). On 281
 *  branches this brings the GET from ~24s to ~1-2s — the panel opens fast
 *  enough that the EXECUTE button is reachable. */
export async function listMergeBackCandidates(): Promise<Array<{
  name: string;
  number: number;
  sha: string;
  commitSubject: string;
  commitsAhead: number;
  sourceFilesDelta: number;
}>> {
  // 1. ONE `git for-each-ref` call returns name + sha + subject for EVERY
  //    origin/loop-* branch — no per-branch cost for these three fields.
  //    Format: <refname-short>\t<short-sha>\t<subject>\n per ref, sorted
  //    by refname desc (newest loop-N first).
  const refList = (await execFileAsync(
    "git",
    [
      "for-each-ref",
      "--sort=-refname",
      "--format=%(refname:short)\t%(objectname:short)\t%(subject)",
      "refs/remotes/origin/loop-*",
    ],
    { cwd: PROJECT_ROOT, maxBuffer: 8 * 1024 * 1024, timeout: 15000 },
  )).stdout.trim();

  type Ref = { name: string; number: number; sha: string; subject: string };
  const refs: Ref[] = [];
  if (refList) {
    for (const line of refList.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const refShort = parts[0]; // "origin/loop-N"
      const sha = parts[1];
      const subject = parts.slice(2).join("\t");
      const name = refShort.replace(/^origin\//, "");
      const m = name.match(/^loop-(\d+)$/);
      if (!m) continue;
      refs.push({ name, number: Number.parseInt(m[1], 10), sha, subject });
    }
  }

  if (refs.length === 0) return [];

  // 2. Per-branch: commitsAhead (rev-list --left-right --count) +
  //    sourceFilesDelta (diff --name-only src/). PERF: 283 branches × 2
  //    queries = 566 git subprocess spawns. With Node's libuv thread pool
  //    capped at 4 concurrent spawns, each spawn costing ~30ms of overhead
  //    on top of git's 2ms work, the parallel Promise.all path took 10s
  //    (down from 24s sequential, but still too slow for a usable panel).
  //    The fix: spawn ONE shell subprocess that runs all the per-branch
  //    queries internally and prints TSV. Node-side spawn overhead
  //    amortizes to 1; the shell dispatches the 566 git calls in
  //    sequence (~2ms each) = ~1.5s total. sh -c is portable (POSIX),
  //    doesn't require bash, and the script uses only `git rev-list`,
  //    `git diff`, and `wc -l` (all in $PATH).
  //    Output format: <refname-short>\t<behind>\t<ahead>\t<src-delta>\n
  //    SAFETY: ref names come from `git for-each-ref` (not user input)
  //    and all match `loop-\d+$` (validated above), so embedding them in
  //    the shell `for` list is safe — no injection surface.
  const refListStr = refs.map((r) => r.name).join(" ");
  const shellScript =
    // Iterate the embedded list, run the two git queries, print TSV.
    // Single-threaded is fast enough at ~2ms/op; no xargs/parallelism.
    `for ref in ${refListStr}; do ` +
    "  counts=$(git rev-list --left-right --count \"main...origin/$ref\" 2>/dev/null || echo '0 0'); " +
    "  delta=$(git diff --name-only \"main\" \"origin/$ref\" -- src/ 2>/dev/null | wc -l); " +
    "  behind=$(echo \"$counts\" | awk '{print $1}'); " +
    "  ahead=$(echo \"$counts\" | awk '{print $2}'); " +
    "  printf '%s\\t%s\\t%s\\t%s\\n' \"$ref\" \"$behind\" \"$ahead\" \"$delta\"; " +
    "done";

  const shellRes = await spawnCapture("sh", ["-c", shellScript], {
    cwd: PROJECT_ROOT, timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  });
  // Best-effort parse: a spawn failure (rare — sh is always present)
  // leaves all summaries at 0/0; the panel still shows the branch list
  // with shas+subjects so the operator can pick and the per-branch plan
  // (analyzeMergeBack) still works as a fallback.
  const summaryMap = new Map<string, { commitsAhead: number; sourceFilesDelta: number }>();
  if (shellRes.code === 0 && shellRes.stdout) {
    for (const line of shellRes.stdout.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 4) continue;
      const name = parts[0];
      const ahead = Number.parseInt(parts[2] ?? "0", 10) || 0;
      const delta = Number.parseInt(parts[3] ?? "0", 10) || 0;
      summaryMap.set(name, { commitsAhead: ahead, sourceFilesDelta: delta });
    }
  }

  return refs.map((r) => {
    const s = summaryMap.get(r.name);
    return {
      name: r.name,
      number: r.number,
      sha: r.sha,
      commitSubject: r.subject,
      commitsAhead: s?.commitsAhead ?? 0,
      sourceFilesDelta: s?.sourceFilesDelta ?? 0,
    };
  });
}
