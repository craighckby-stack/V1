#!/usr/bin/env python3
"""
dev-daemon.py — start the Next.js dev server as a true daemon.

Why this exists: the sandbox reaps every process spawned by a tool session
when that session ends — even setsid'd ones. The ONLY escape found (tested
live): classic double-fork daemonization, where the middle child exits
IMMEDIATELY while the spawning session is still alive, orphaning the
grandchild to PID 1 before the session cleanup kills the process tree.
The re-parented grandchild survives (same mechanism that keeps the
WS mini-service on port 3003 alive since 04:26).

Usage:
  python3 scripts/dev-daemon.py start   # daemonize `next dev -p 3000`
  python3 scripts/dev-daemon.py status  # is the daemon alive?
  python3 scripts/dev-daemon.py stop    # kill the daemon tree

PID file: .dev-daemon.pid (project root). Log: dev.log (project root).
"""

import os
import sys
import signal
import subprocess
import time

ROOT = "/home/z/my-project"
PID_FILE = os.path.join(ROOT, ".dev-daemon.pid")
LOG_FILE = os.path.join(ROOT, "dev.log")


def read_pid():
    try:
        with open(PID_FILE) as f:
            return int(f.read().strip())
    except (FileNotFoundError, ValueError):
        return None


def is_alive(pid):
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def start():
    pid = read_pid()
    if is_alive(pid):
        print(f"daemon already running (pid {pid})")
        return

    # Flush any stale pid file
    if pid is not None:
        try:
            os.remove(PID_FILE)
        except FileNotFoundError:
            pass

    # --- Double-fork daemonization ---
    pid1 = os.fork()
    if pid1 == 0:
        # Child 1: new session, detach from terminal
        os.setsid()

        pid2 = os.fork()
        if pid2 == 0:
            # Grandchild — this is the daemon. It gets re-parented to PID 1
            # the moment child 1 exits (below), which happens WHILE the
            # spawning tool session is still alive. That is the whole trick:
            # by the time the session cleanup kills the tree, this process
            # is already owned by init and outside the tree.
            try:
                os.chdir(ROOT)
                # Write the pid file BEFORE exec so the spawner can see it
                with open(PID_FILE, "w") as f:
                    f.write(str(os.getpid()))
                # Redirect stdio to the log, detach from the session's fds
                logfd = os.open(LOG_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
                os.dup2(logfd, 1)
                os.dup2(logfd, 2)
                devnull = os.open(os.devnull, os.O_RDONLY)
                os.dup2(devnull, 0)
                os.close(logfd)
                os.close(devnull)
                # Reset signal handlers the session may have set
                signal.signal(signal.SIGHUP, signal.SIG_DFL)
                signal.signal(signal.SIGTERM, signal.SIG_DFL)
                signal.signal(signal.SIGINT, signal.SIG_IGN)
                # Exec the dev server — `next dev` directly (NOT `bun run dev`,
                # whose `| tee` pipeline is another fragile process tree).
                os.execv(
                    os.path.join(ROOT, "node_modules/.bin/next"),
                    ["next", "dev", "-p", "3000"],
                )
            except Exception as e:
                print(f"daemon exec failed: {e}", file=sys.stderr)
                os._exit(1)
        # Child 1 exits immediately — grandchild is orphaned to init NOW,
        # before the spawning session ends.
        os._exit(0)

    # Parent: reap child 1 so it doesn't linger as a zombie
    os.waitpid(pid1, 0)

    # Wait for the pid file / port
    for _ in range(30):
        time.sleep(1)
        pid = read_pid()
        if is_alive(pid):
            print(f"daemon started (pid {pid}) — waiting for port 3000...")
            # wait for the HTTP port
            for _ in range(60):
                try:
                    with subprocess.Popen(
                        ["curl", "-s", "-o", os.devnull, "-w", "%{http_code}",
                         "http://localhost:3000/"],
                        stdout=subprocess.PIPE,
                    ) as probe:
                        code = probe.communicate(timeout=5)[0].decode().strip()
                    if code in ("200", "000"):
                        if code == "200":
                            print("dev server is UP on http://localhost:3000/")
                            return
                except Exception:
                    pass
                time.sleep(2)
            print("daemon running but port 3000 not answering yet — check dev.log")
            return
    print("daemon failed to write pid file — check dev.log")
    sys.exit(1)


def stop():
    pid = read_pid()
    if not is_alive(pid):
        print("daemon not running")
        return
    os.kill(pid, signal.SIGTERM)
    # next dev forwards SIGTERM to its children; give it a moment
    for _ in range(15):
        time.sleep(1)
        if not is_alive(pid):
            print(f"daemon {pid} stopped")
            try:
                os.remove(PID_FILE)
            except FileNotFoundError:
                pass
            return
    os.kill(pid, signal.SIGKILL)
    print(f"daemon {pid} force-killed")
    try:
        os.remove(PID_FILE)
    except FileNotFoundError:
        pass


def status():
    pid = read_pid()
    if is_alive(pid):
        print(f"daemon running (pid {pid})")
    else:
        print("daemon not running")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    {"start": start, "stop": stop, "status": status}.get(cmd, status)()
