#!/bin/bash
# db-tier-loop.sh — recurring DB tier backup (operator, 2026-11-23).
#
# WHY THIS FILE EXISTS
# ─────────────────────
# The round-2 hardening commit (79025753) claimed a "10-min backup loop
# running" — but it lived at /home/z/wipewatch/backup-loop.sh OUTSIDE the
# repo, ran exactly once (04:27 UTC), died, and nothing respawned it. The
# only location guaranteed to survive the platform's untracked-file wipe
# on machine restart is .git/ — and the only spawn path guaranteed to run
# again after a machine restart is dev.sh (tracked). So the loop itself
# is now tracked HERE and spawned by dev.sh at every boot.
#
# LAYERS (same contract as the wipewatch script it replaces):
#   1. WIPE-PROOF TIER (primary): scripts/loop-db-tier.ts backup →
#      .git/info/loop-db-backup/ — survives machine restarts.
#   2. db/backups/ (forensic window): plain copies, newest 12 kept.
#      Untracked (*.db gitignored) — wiped on machine restart; useful
#      only for within-machine forensics.
#
# SINGLE INSTANCE: pidfile guard (.zscripts/db-tier-loop.pid, gitignored
# via *.pid). A stale pidfile (machine restart) is detected with kill -0
# and cleared. dev.sh may be re-run by the watchdog — the guard makes
# re-spawning a no-op instead of stacking loops.
#
# This file is under the .zscripts/ protected prefix — the loop can never
# disable its own recovery cadence.

set -u

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TIER="$PROJECT_DIR/scripts/loop-db-tier.ts"
DB="$PROJECT_DIR/db/custom.db"
BK="$PROJECT_DIR/db/backups"
LOG="$PROJECT_DIR/.zscripts/db-tier-backup.log"
PIDFILE="$PROJECT_DIR/.zscripts/db-tier-loop.pid"
INTERVAL="${DB_TIER_INTERVAL_SECONDS:-600}"

# ── single-instance guard ────────────────────────────────────────────────
if [ -f "$PIDFILE" ]; then
    OLD_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "[db-tier-loop] already running (pid $OLD_PID) — exiting." >> "$LOG"
        exit 0
    fi
    rm -f "$PIDFILE" # stale (machine restart or crash) — reclaim
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT INT TERM

echo "=== db-tier-loop started $(date -u '+%F %T') (pid $$, every ${INTERVAL}s) ===" >> "$LOG"
mkdir -p "$BK"

# Keep the log bounded — it grows one line per 10 minutes forever.
truncate_log() {
    if [ -f "$LOG" ] && [ "$(stat -c '%s' "$LOG")" -gt 262144 ]; then
        tail -c 131072 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
    fi
}

while true; do
    if [ -f "$DB" ]; then
        # Primary layer: wipe-proof tier (SQLite-safe VACUUM INTO snapshot,
        # integrity-checked by the tier script itself).
        if ! (cd "$PROJECT_DIR" && bun "$TIER" backup) >> "$LOG" 2>&1; then
            echo "[db-tier-loop] tier backup FAILED at $(date -u '+%F %T') — retrying next interval" >> "$LOG"
        fi
        # Forensic layer: plain copy, newest 12 kept.
        cp "$DB" "$BK/custom-$(date -u +%Y%m%dT%H%M%S).db" 2>> "$LOG"
        ls -1t "$BK"/custom-*.db 2>/dev/null | tail -n +13 | xargs -r rm -f
    else
        echo "[db-tier-loop] live DB missing at $(date -u '+%F %T') — nothing to back up (dev.sh restore path handles this)" >> "$LOG"
    fi
    truncate_log
    sleep "$INTERVAL"
done
