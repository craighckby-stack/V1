#!/usr/bin/env bash
#
# rea-restore.sh — Strip the "Architecture Helper Pipeline" headers and
# restore redacted/shebang-damaged files from the original rea-main repo.
#
# Usage:
#   ./rea-restore.sh <rea-main-path> <rea-helper-evolution-path>
#
# Example:
#   ./rea-restore.sh /path/to/rea-main /path/to/rea-helper-evolution
#
# What this script does:
#   1. Restores all 41 redacted files (where the sanitizer replaced
#      fixture strings, env vars, class names, base64 alphabets, etc.
#      with [REDACTED_HIGH_ENTROPY_KEY] or [REDACTED_PII]) from rea-main.
#   2. Restores all 10 shebang-damaged files (where the header was
#      inserted above the #! line) from rea-main.
#   3. For the remaining ~1,491 files with only the cosmetic header +
#      unused ExecutionContract interface, strips both, leaving any
#      genuine changes intact (if any exist).
#   4. Removes docs/POSTMORTEMS.md (the 1,283-line auto-generated file).
#
# After running, the helper-evolution directory should contain ONLY
# genuine changes (if any exist). In our analysis, no genuine changes
# were found — the pipeline added zero new functionality.
#
# The script is idempotent and safe to run multiple times. It does NOT
# modify rea-main. It prints a summary at the end.
#
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <rea-main-path> <rea-helper-evolution-path>" >&2
  exit 1
fi

MAIN="$1"
EVO="$2"

if [ ! -d "$MAIN" ]; then
  echo "Error: rea-main path does not exist: $MAIN" >&2
  exit 1
fi
if [ ! -d "$EVO" ]; then
  echo "Error: rea-helper-evolution path does not exist: $EVO" >&2
  exit 1
fi

echo "rea-restore.sh"
echo "  main: $MAIN"
echo "  evo:  $EVO"
echo ""

restored_redactions=0
restored_shebangs=0
stripped_headers=0
stripped_execution_contract=0
removed_postmortems=0
genuine_changes=0
errors=0

# ---------------------------------------------------------------------------
# 1. Restore redacted files (high-entropy + PII redactions) from main.
#    These files have [REDACTED_HIGH_ENTROPY_KEY] or [REDACTED_PII] where
#    there should be fixture strings, env vars, class names, etc. The only
#    safe fix is to restore them entirely from main (we verified no
#    genuine changes exist in these files).
# ---------------------------------------------------------------------------
echo "=== Step 1: Restoring redacted files from main ==="
while IFS= read -r rel; do
  if [ -z "$rel" ]; then continue; fi
  main_f="$MAIN/$rel"
  evo_f="$EVO/$rel"
  if [ ! -f "$main_f" ]; then
    echo "  WARN: main file not found, skipping: $rel" >&2
    errors=$((errors + 1))
    continue
  fi
  if [ ! -f "$evo_f" ]; then
    echo "  WARN: evo file not found, skipping: $rel" >&2
    errors=$((errors + 1))
    continue
  fi
  cp "$main_f" "$evo_f"
  restored_redactions=$((restored_redactions + 1))
done < <(grep -rl "REDACTED_HIGH_ENTROPY_KEY\|REDACTED_PII" "$EVO" \
  --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.cjs" \
  --include="*.js" --include="*.jsx" --include="*.py" --include="*.java" \
  --include="*.swift" --include="*.go" --include="*.rs" 2>/dev/null \
  | grep -v node_modules \
  | sed "s|^$EVO/||")
echo "  Restored $restored_redactions redacted files"
echo ""

# ---------------------------------------------------------------------------
# 2. Restore shebang-damaged files from main.
#    The header was inserted above the #! line, which breaks node --check
#    for .mjs files and loses the interpreter for .py/.sh files.
# ---------------------------------------------------------------------------
echo "=== Step 2: Restoring shebang-damaged files from main ==="
for evo_f in $(find "$EVO" -type f \( -name "*.mjs" -o -name "*.py" -o -name "*.sh" -o -name "*.cjs" \) -not -path "*/node_modules/*"); do
  rel="${evo_f#$EVO/}"
  main_f="$MAIN/$rel"
  if [ ! -f "$main_f" ]; then
    continue  # file only in evo, not a shebang-damage case
  fi
  main_first=$(head -1 "$main_f")
  evo_first=$(head -1 "$evo_f")
  if [[ "$main_first" == "#!"* ]] && [[ "$evo_first" != "#!"* ]]; then
    # Shebang was lost — restore the whole file from main (the header
    # is the only diff for these files, so restoring is safe).
    cp "$main_f" "$evo_f"
    restored_shebangs=$((restored_shebangs + 1))
    echo "  Restored shebang: $rel"
  fi
done
echo "  Restored $restored_shebangs shebang-damaged files"
echo ""

# ---------------------------------------------------------------------------
# 3. Strip the cosmetic header + unused ExecutionContract interface from
#    the remaining changed files. This handles the ~1,445 TS files that
#    have only the "Enhanced by Architecture Helper Pipeline" banner and
#    the `export interface ExecutionContract { ... }` block.
#
#    The header is one of:
#      /**\n * Enhanced by Architecture Helper Pipeline\n * Template Origin: ...\n * Verified: ...\n * Engine: ...\n */
#      # Enhanced by Architecture Helper Pipeline\n# Template Origin: ...\n# Verified: ...\n# Engine: ...
#      <!-- Enhanced by Architecture Helper Pipeline\n  Template Origin: ...\n  Verified: ... -->
#
#    The ExecutionContract block (TS only):
#      // Type-safe execution interface\nexport interface ExecutionContract {\n  readonly status: 'active' | 'completed';\n  readonly timestamp: number;\n}\n\n
# ---------------------------------------------------------------------------
echo "=== Step 3: Stripping cosmetic headers + ExecutionContract ==="
for evo_f in $(find "$EVO" -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.mjs" -o -name "*.cjs" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.swift" -o -name "*.css" -o -name "*.html" -o -name "*.yaml" -o -name "*.yml" -o -name "*.sh" -o -name "*.sql" -o -name "*.md" \) -not -path "*/node_modules/*"); do
  rel="${evo_f#$EVO/}"
  main_f="$MAIN/$rel"
  if [ ! -f "$main_f" ]; then
    continue  # file only in evo — keep it (genuine addition)
  fi

  # Skip if files are already identical (already restored or never changed)
  if cmp -s "$evo_f" "$main_f"; then
    continue
  fi

  # Read the evo file and strip the header + ExecutionContract
  python3 - "$evo_f" "$main_f" << 'PYEOF'
import re, sys
evo_path, main_path = sys.argv[1], sys.argv[2]
with open(evo_path, 'r', encoding='utf-8', errors='replace') as f:
    evo_content = f.read()
with open(main_path, 'r', encoding='utf-8', errors='replace') as f:
    main_content = f.read()

stripped = evo_content

# Strip the JSDoc-style header:
#   /**\n * Enhanced by Architecture Helper Pipeline\n * Template Origin: ...\n * Verified: ...\n * Engine: ...\n */
# (handles any * lines between /** and */)
stripped = re.sub(
    r'/\*\*\s*\n(?:\s*\*.*\n)*?\s*\*/\s*\n',
    lambda m: '' if 'Enhanced by Architecture Helper Pipeline' in m.group(0) else m.group(0),
    stripped,
    count=1,
)

# Strip the Python/shell-style header:
#   # Enhanced by Architecture Helper Pipeline\n# Template Origin: ...\n# Verified: ...\n# Engine: ...\n\n
stripped = re.sub(
    r'(# Enhanced by Architecture Helper Pipeline\n(?:#[^\n]*\n)*)\n*',
    '',
    stripped,
    count=1,
)

# Strip the HTML-style header:
#   <!-- Enhanced by Architecture Helper Pipeline\n  Template Origin: ...\n  Verified: ... -->\n\n
stripped = re.sub(
    r'<!-- Enhanced by Architecture Helper Pipeline[\s\S]*?-->\s*\n*',
    '',
    stripped,
    count=1,
)

# Strip the unused ExecutionContract interface block (TS only):
#   // Type-safe execution interface\nexport interface ExecutionContract {\n  readonly status: 'active' | 'completed';\n  readonly timestamp: number;\n}\n\n
stripped = re.sub(
    r"// Type-safe execution interface\nexport interface ExecutionContract \{\n  readonly status: 'active' \| 'completed';\n  readonly timestamp: number;\n\}\n\n",
    '',
    stripped,
    count=1,
)

# Strip any leading blank lines left after header removal
stripped = stripped.lstrip('\n')

# Write back only if we actually changed something
if stripped != evo_content:
    with open(evo_path, 'w', encoding='utf-8') as f:
        f.write(stripped)
    print(f"STRIPPED: {evo_path}")
PYEOF
done 2>/dev/null | while read -r line; do
  stripped_headers=$((stripped_headers + 1))
done
echo "  Stripped headers from changed files"
echo ""

# ---------------------------------------------------------------------------
# 4. Remove docs/POSTMORTEMS.md (the 1,283-line auto-generated file with
#    39 entries that have no real lessons yet).
# ---------------------------------------------------------------------------
echo "=== Step 4: Removing docs/POSTMORTEMS.md ==="
if [ -f "$EVO/docs/POSTMORTEMS.md" ]; then
  rm "$EVO/docs/POSTMORTEMS.md"
  removed_postmortems=1
  echo "  Removed docs/POSTMORTEMS.md"
fi
echo ""

# ---------------------------------------------------------------------------
# 5. Final check: any files that still differ from main have genuine changes.
# ---------------------------------------------------------------------------
echo "=== Step 5: Checking for genuine changes ==="
genuine_files=0
genuine_list=""
while IFS= read -r line; do
  if echo "$line" | grep -q "^Files .* differ"; then
    rel=$(echo "$line" | sed "s|^Files $MAIN/||; s| and .*||")
    genuine_files=$((genuine_files + 1))
    genuine_list="$genuine_list\n  $rel"
  fi
done < <(diff -rq "$MAIN" "$EVO" 2>&1 | grep -v node_modules)

if [ "$genuine_files" -gt 0 ]; then
  echo "  Found $genuine_files file(s) with genuine changes:"
  echo -e "$genuine_list"
else
  echo "  No genuine changes found — all files now match rea-main."
fi
echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "=========================================="
echo "SUMMARY"
echo "=========================================="
echo "  Redacted files restored:    $restored_redactions"
echo "  Shebang files restored:     $restored_shebangs"
echo "  Headers stripped:           ~$(find "$EVO" -type f -not -path "*/node_modules/*" | wc -l) files checked"
echo "  POSTMORTEMS.md removed:     $removed_postmortems"
echo "  Genuine changes remaining:  $genuine_files"
echo "  Errors:                     $errors"
echo ""
if [ "$genuine_files" -eq 0 ] && [ "$errors" -eq 0 ]; then
  echo "  ✅ helper-evolution now matches rea-main exactly."
  echo "  The pipeline added no genuine functionality."
else
  echo "  Review the genuine changes above before merging."
fi
