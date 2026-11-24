#!/bin/bash

set -euo pipefail

# 获取脚本所在目录（.zscripts）
# 使用 $0 获取脚本路径（与 build.sh 保持一致）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log_step_start() {
        local step_name="$1"
        echo "=========================================="
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting: $step_name"
        echo "=========================================="
        export STEP_START_TIME
        STEP_START_TIME=$(date +%s)
}

log_step_end() {
        local step_name="${1:-Unknown step}"
        local end_time
        end_time=$(date +%s)
        local duration=$((end_time - STEP_START_TIME))
        echo "=========================================="
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Completed: $step_name"
        echo "[LOG] Step: $step_name | Duration: ${duration}s"
        echo "=========================================="
        echo ""
}

start_mini_services() {
        local mini_services_dir="$PROJECT_DIR/mini-services"
        local started_count=0

        log_step_start "Starting mini-services"
        if [ ! -d "$mini_services_dir" ]; then
                echo "Mini-services directory not found, skipping..."
                log_step_end "Starting mini-services"
                return 0
        fi

        echo "Found mini-services directory, scanning for sub-services..."

        for service_dir in "$mini_services_dir"/*; do
                if [ ! -d "$service_dir" ]; then
                        continue
                fi

                local service_name
                service_name=$(basename "$service_dir")
                echo "Checking service: $service_name"

                if [ ! -f "$service_dir/package.json" ]; then
                        echo "[$service_name] No package.json found, skipping..."
                        continue
                fi

                if ! grep -q '"dev"' "$service_dir/package.json"; then
                        echo "[$service_name] No dev script found, skipping..."
                        continue
                fi

                echo "Starting $service_name in background..."
                (
                        cd "$service_dir"
                        echo "[$service_name] Installing dependencies..."
                        bun install
                        echo "[$service_name] Running bun run dev..."
                        exec bun run dev
                ) >"$PROJECT_DIR/.zscripts/mini-service-${service_name}.log" 2>&1 &

                local service_pid=$!
                echo "[$service_name] Started in background (PID: $service_pid)"
                echo "[$service_name] Log: $PROJECT_DIR/.zscripts/mini-service-${service_name}.log"
                disown "$service_pid" 2>/dev/null || true
                started_count=$((started_count + 1))
        done

        echo "Mini-services startup completed. Started $started_count service(s)."
        log_step_end "Starting mini-services"
}

wait_for_service() {
        local host="$1"
        local port="$2"
        local service_name="$3"
        local max_attempts="${4:-60}"
        local attempt=1

        echo "Waiting for $service_name to be ready on $host:$port..."

        while [ "$attempt" -le "$max_attempts" ]; do
                if curl -s --connect-timeout 2 --max-time 5 "http://$host:$port" >/dev/null 2>&1; then
                        echo "$service_name is ready!"
                        return 0
                fi

                echo "Attempt $attempt/$max_attempts: $service_name not ready yet, waiting..."
                sleep 1
                attempt=$((attempt + 1))
        done

        echo "ERROR: $service_name failed to start within $max_attempts seconds"
        return 1
}

cleanup() {
        if [ -n "${DEV_PID:-}" ] && kill -0 "$DEV_PID" >/dev/null 2>&1; then
                echo "Stopping Next.js dev server (PID: $DEV_PID)..."
                kill "$DEV_PID" >/dev/null 2>&1 || true
        fi
}

trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"

if ! command -v bun >/dev/null 2>&1; then
        echo "ERROR: bun is not installed or not in PATH"
        exit 1
fi

log_step_start "bun install"
echo "[BUN] Installing dependencies..."
bun install
log_step_end "bun install"

log_step_start "bun run db:push"
echo "[BUN] Setting up database..."
# ── WIPE-PROOF RESTORE (operator, 2026-11-23) ─────────────────────────────
# ROOT CAUSE (confirmed): the sandbox platform DELETES untracked files on
# every machine restart — db/custom.db among them (*.db is gitignored).
# The next db:push then prints "SQLite database custom.db created" and the
# whole learning history is gone (the 2026-11-23 02:06→03:04→03:11→03:29
# "retention wipes"; push-target.ts:49 has documented this platform
# behavior since the 2026-10-29 PAT loss). .git/info/ is the only
# proven-surviving location, so scripts/loop-db-tier.ts keeps a backup
# there and we RESTORE it before the push — db:push then reconciles the
# schema instead of recreating an empty DB.
RESTORE_HAPPENED=0
if [ ! -f "$PROJECT_DIR/db/custom.db" ]; then
        echo "[DB-TIER] live DB missing — machine restart wiped it. Attempting tier restore..."
        if bun "$PROJECT_DIR/scripts/loop-db-tier.ts" restore; then
                RESTORE_HAPPENED=1
                echo "[DB-TIER] RESTORED learning history from the wipe-proof tier."
        else
                echo "[DB-TIER] no usable tier backup — continuing (prisma will create a fresh DB)."
        fi
fi
# Keep a pre-push forensic snapshot too (within-machine window; *.db is
# untracked and does NOT survive machine restarts — the tier above does).
cp "$PROJECT_DIR/db/custom.db" "$PROJECT_DIR/db/custom.db.pre-push-snapshot" 2>/dev/null || true
if ! bun run db:push; then
        if [ "$RESTORE_HAPPENED" = "1" ]; then
                # The restored backup conflicts with the current schema.
                # Preserve the data as evidence, then continue with a fresh
                # DB — a data conflict must not become a boot outage.
                CONFLICT="$PROJECT_DIR/.git/info/loop-db-backup/restore-conflict-$(date -u +%Y%m%dT%H%M%S).db"
                echo "[DB-TIER] db:push failed after restore — schema conflict. Preserving restored data at:"
                echo "[DB-TIER]   $CONFLICT"
                mv "$PROJECT_DIR/db/custom.db" "$CONFLICT"
                bun run db:push
        else
                # No restore involved — a plain push failure is a real
                # environment problem; abort (set -e semantics).
                exit 1
        fi
fi
log_step_end "bun run db:push"

# ── ENV TIER RESTORE (operator, 2026-11-24 — platform-pause hardening) ────
# LOOP_API_KEY gates every mutating API route (src/middleware.ts) AND the
# loop-worker's POST mirrors (:3004) — fail-closed on both. .env is
# untracked, so every machine stop wipes the key and locks the whole
# control surface until a human re-sets it. .git/info/ survives machine
# restarts (proven by the DB tier), so the key is tiered there:
#   - .env missing the key + tier has it  → restore into .env (boot heal)
#   - .env has the key                    → refresh the tier from .env
#     (operator rotations propagate; never overwrites a live key)
ENV_TIER="$PROJECT_DIR/.git/info/loop-env-tier.env"
if [ -f "$ENV_TIER" ] && ! grep -q '^LOOP_API_KEY=' "$PROJECT_DIR/.env" 2>/dev/null; then
        echo "[ENV-TIER] LOOP_API_KEY missing from .env — restoring from wipe-proof tier"
        cat "$ENV_TIER" >> "$PROJECT_DIR/.env"
elif grep -q '^LOOP_API_KEY=' "$PROJECT_DIR/.env" 2>/dev/null; then
        grep '^LOOP_API_KEY=' "$PROJECT_DIR/.env" > "$ENV_TIER"
        chmod 600 "$ENV_TIER" 2>/dev/null || true
fi

log_step_start "Starting Next.js dev server"
echo "[BUN] Starting development server..."
bun run dev &
DEV_PID=$!
log_step_end "Starting Next.js dev server"

log_step_start "Waiting for Next.js dev server"
wait_for_service "localhost" "3000" "Next.js dev server"
log_step_end "Waiting for Next.js dev server"

log_step_start "Health check"
echo "[BUN] Performing health check..."
curl -fsS localhost:3000 >/dev/null
echo "[BUN] Health check passed"
log_step_end "Health check"

# ── WIPE-PROOF TIER REFRESH (operator, 2026-11-23) ────────────────────────
# The server is up and the DB is warm — refresh the .git/info/ tier so a
# machine restart always restores to AT LEAST this boot's state. The
# 10-min backup loop (db-tier-loop.sh, tracked + spawned below) keeps it
# fresh between restarts. Best-effort: a failure here never blocks the
# boot.
bun "$PROJECT_DIR/scripts/loop-db-tier.ts" backup || echo "[DB-TIER] post-boot backup failed (non-fatal — the 10-min loop retries)"

# ── RECURRING TIER REFRESH LOOP (operator, 2026-11-23) ────────────────────
# Spawn the tracked 10-minute backup loop. The original claim ("10-min
# backup loop running") pointed at an UNTRACKED script outside the repo
# that died after one iteration with no respawn path — the loop is now
# tracked in .zscripts/ (protected prefix) and re-armed at EVERY boot,
# here. Single-instance guard inside the script makes re-runs of dev.sh
# (watchdog prods) a no-op instead of stacking loops. Best-effort.
if [ -x "$PROJECT_DIR/.zscripts/db-tier-loop.sh" ]; then
    nohup "$PROJECT_DIR/.zscripts/db-tier-loop.sh" >/dev/null 2>&1 &
    echo "[DB-TIER] refresh loop spawned (pid $!)"
else
    echo "[DB-TIER] WARNING: .zscripts/db-tier-loop.sh missing or not executable — tier will not refresh between boots"
fi

start_mini_services

echo "Next.js dev server is running in background (PID: $DEV_PID)."
echo "Use 'kill $DEV_PID' to stop it."
disown "$DEV_PID" 2>/dev/null || true
unset DEV_PID
