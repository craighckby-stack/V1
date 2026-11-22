/**
 * One-off: list the actual file tree of the configured target repo so we
 * can see WHY the target scanner found 0 mutable files. Read-only.
 */
import { getTargetConfig, resolveTargetToken } from "@/lib/pipeline/target/target-store";
import { listTargetTree } from "@/lib/pipeline/target/target-github";
import { isMutableTargetPath, MAX_TARGET_FILE_BYTES } from "@/lib/pipeline/target/target-scan";

async function main() {
  const cfg = await getTargetConfig();
  if (!cfg) {
    console.error("No target configured.");
    process.exitCode = 1;
    return;
  }
  const token = await resolveTargetToken();
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

    // Safely extract extension
    const lastDotIndex = f.path.lastIndexOf('.');
    if (lastDotIndex > 0) { // lastDotIndex > 0 ensures it's not a leading dot like in .gitignore
      const ext = f.path.substring(lastDotIndex + 1);
      exts.set(ext, (exts.get(ext) ?? 0) + 1);
    } else if (lastDotIndex === 0 && f.path.length > 1) {
      // Handle dotfiles like .gitignore where the dot is the first character, but it has content after.
      // We treat the whole name (minus the leading dot) as the extension/identifier for counting purposes,
      // or more simply, group them under a specific dotfile category if no further dot exists.
      // For consistency with the original logic's intent (grouping by segment after dot),
      // if there's only one segment after the leading dot, we use that.
      const parts = f.path.substring(1).split(".");
      const ext = parts.length === 1 ? parts[0] : parts.pop()!;
      exts.set(ext, (exts.get(ext) ?? 0) + 1);
    } else {
      exts.set("(no-ext)", (exts.get("(no-ext)") ?? 0) + 1);
    }
  }

  console.log(`\nmutable+size-ok files: ${mutable} / ${files.length}`);
  console.log(`\nfile-type breakdown:`);
  [...exts.entries()].sort((a, b) => b[1] - a[1]).forEach(([e, n]) => console.log(`  ${n}  .${e}`));
}

main().catch((e) => { console.error("FATAL: Failed to inspect target tree.", e); process.exitCode = 2; });