/**
 * One-off: list the actual file tree of the configured target repo so we
 * can see WHY the target scanner found 0 mutable files. Read-only.
 */
import { getTargetConfig, resolveTargetToken } from "@/lib/pipeline/target/target-store";
import { listTargetTree } from "@/lib/pipeline/target/target-github";
import { isMutableTargetPath, MAX_TARGET_FILE_BYTES } from "@/lib/pipeline/target/target-scan";

async function main() {
  // Fetch config and token concurrently to reduce latency
  const [cfg, token] = await Promise.all([
    getTargetConfig(),
    resolveTargetToken(),
  ]);

  if (!cfg) {
    console.error("No target configured.");
    process.exitCode = 1;
    return;
  }

  const ref = cfg.branch ?? "main";
  const res = await listTargetTree(cfg.repo, ref, token);

  if (!res.ok) {
    console.error(`Tree fetch failed for ${cfg.repo} @ ${ref}:`, res.error);
    process.exitCode = 1;
    return;
  }

  const files = res.tree.files;
  console.log(`\nrepo: ${cfg.repo} @ ${ref}`);
  console.log(`total tree entries: ${files.length} (truncated=${res.tree.truncated})`);
  console.log(`MAX_TARGET_FILE_BYTES: ${MAX_TARGET_FILE_BYTES}`);
  console.log(`\nall files (path | size | mutable?):`);
  let mutable = 0;
  const exts = new Map<string, number>();

  for (const f of files) {
    const isMut = isMutableTargetPath(f.path) && f.size <= MAX_TARGET_FILE_BYTES;
    if (isMut) mutable++;
    console.log(`  ${isMut ? "Y" : "."}  ${String(f.size).padStart(8)}  ${f.path}`);

    // Unified and simplified extension extraction logic
    const lastDotIndex = f.path.lastIndexOf('.');
    let ext: string;

    if (lastDotIndex > 0) {
      // Standard case: dot is not the first character
      ext = f.path.substring(lastDotIndex + 1);
    } else if (lastDotIndex === 0 && f.path.length > 1) {
      // Dotfile case (e.g., .gitignore, .config/file)
      // Extract segment after the leading dot, handling potential internal dots.
      const nameWithoutDot = f.path.substring(1);
      const parts = nameWithoutDot.split(".");
      // If there are no more dots (e.g., .gitignore), use the whole name.
      // Otherwise, use the last segment (consistent with original intent for complex dotfiles).
      ext = parts.length === 1 ? parts[0] : parts.pop()!;
    } else {
      // No dot, or path is just "." or "" (shouldn't happen in file list)
      ext = "(no-ext)";
    }
    
    exts.set(ext, (exts.get(ext) ?? 0) + 1);
  }

  console.log(`\nmutable+size-ok files: ${mutable} / ${files.length}`);
  console.log(`\nfile-type breakdown:`);
  [...exts.entries()].sort((a, b) => b[1] - a[1]).forEach(([e, n]) => console.log(`  ${n}  .${e}`));
}

main().catch((e) => { console.error("FATAL: Failed to inspect target tree.", e); process.exitCode = 2; });