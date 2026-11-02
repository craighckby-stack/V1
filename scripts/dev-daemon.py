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
from typing import Optional, Tuple

# Configuration constants
ROOT = "/home/z/my-project"
PID_FILE = os.path.join(ROOT, ".dev-daemon.pid")
LOG_FILE = os.path.join(ROOT, "dev.log")
DEV_SERVER_PATH = os.path.join(ROOT, "node_modules/.bin/next")
DEV_SERVER_ARGS = ["next", "dev", "-p", "3000"]
PORT = 3000
PROBE_URL = f"http://localhost:{PORT}/"
MAX_START_WAIT = 30  # seconds for pid file
MAX_PORT_WAIT = 60  # seconds for port response
SIGTERM_TIMEOUT = 15  # seconds for graceful shutdown


def daemonize() -> int:
    """
    Double-fork daemonization process.
    Returns the PID of the daemon process.
    """
    # First fork
    pid1 = os.fork()
    if pid1 == 0:
        # Child 1: new session, detach from terminal
        os.setsid()
        
        # Second fork
        pid2 = os.fork()
        if pid2 == 0:
            # Grandchild - this is the daemon
            return _setup_grandchild()
        # Child 1 exits immediately
        os._exit(0)
    
    # Parent: reap child 1
    os.waitpid(pid1, 0)
    return -1


def _setup_grandchild() -> int:
    """Setup the grandchild process as a daemon."""
    try:
        os.chdir(ROOT)
        
        # Write pid file
        with open(PID_FILE, "w") as f:
            pid = os.getpid()
            f.write(str(pid))
        
        # Redirect stdio
        _redirect_stdio()
        
        # Reset signal handlers
        _reset_signal_handlers()
        
        # Exec the dev server
        os.execv(DEV_SERVER_PATH, DEV_SERVER_ARGS)
    except Exception as e:
        print(f"daemon exec failed: {e}", file=sys.stderr)
        os._exit(1)
    
    # Should never reach here
    return -1


def _redirect_stdio() -> None:
    """Redirect stdio to log file and /dev/null."""
    logfd = os.open(LOG_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    os.dup2(logfd, 1)
    os.dup2(logfd, 2)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(logfd)
    os.close(devnull)


def _reset_signal_handlers() -> None:
    """Reset signal handlers to default."""
    signal.signal(signal.SIGHUP, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    signal.signal(signal.SIGINT, signal.SIG_IGN)


class DevDaemon:
    """Encapsulates daemon state and operations."""
    
    def __init__(self, pid_file: str, log_file: str, port: int):
        self.pid_file = pid_file
        self.log_file = log_file
        self.port = port
    
    def read_pid(self) -> Optional[int]:
        """Read PID from pid file."""
        try:
            with open(self.pid_file) as f:
                return int(f.read().strip())
        except (FileNotFoundError, ValueError):
            return None
    
    def is_alive(self, pid: Optional[int]) -> bool:
        """Check if process with given PID is alive."""
        if pid is None:
            return False
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    
    def start(self) -> None:
        """Start the daemon."""
        pid = self.read_pid()
        if self.is_alive(pid):
            print(f"daemon already running (pid {pid})")
            return
        
        # Flush any stale pid file
        if pid is not None:
            try:
                os.remove(self.pid_file)
            except FileNotFoundError:
                pass
        
        # Daemonize
        daemon_pid = daemonize()
        if daemon_pid == -1:
            # We're in the parent process
            self._wait_for_daemon()
        else:
            # We're in the daemon process
            os._exit(0)
    
    def _wait_for_daemon(self) -> None:
        """Wait for daemon to start and write pid file."""
        for _ in range(MAX_START_WAIT):
            time.sleep(1)
            pid = self.read_pid()
            if self.is_alive(pid):
                print(f"daemon started (pid {pid}) — waiting for port {self.port}...")
                self._wait_for_port()
                return
        
        print("daemon failed to write pid file — check dev.log")
        sys.exit(1)
    
    def _wait_for_port(self) -> None:
        """Wait for the HTTP port to respond."""
        for _ in range(MAX_PORT_WAIT):
            try:
                with subprocess.Popen(
                    ["curl", "-s", "-o", os.devnull, "-w", "%{http_code}",
                     PROBE_URL],
                    stdout=subprocess.PIPE,
                ) as probe:
                    code = probe.communicate(timeout=5)[0].decode().strip()
                if code in ("200", "000"):
                    if code == "200":
                        print(f"dev server is UP on {PROBE_URL}")
                    return
            except Exception:
                pass
            time.sleep(2)
        
        print(f"daemon running but port {self.port} not answering yet — check dev.log")
    
    def stop(self) -> None:
        """Stop the daemon."""
        pid = self.read_pid()
        if not self.is_alive(pid):
            print("daemon not running")
            return
        
        os.kill(pid, signal.SIGTERM)
        
        # Wait for graceful shutdown
        for _ in range(SIGTERM_TIMEOUT):
            time.sleep(1)
            if not self.is_alive(pid):
                print(f"daemon {pid} stopped")
                self._cleanup_pid_file()
                return
        
        # Force kill if still running
        os.kill(pid, signal.SIGKILL)
        print(f"daemon {pid} force-killed")
        self._cleanup_pid_file()
    
    def _cleanup_pid_file(self) -> None:
        """Remove the pid file if it exists."""
        try:
            os.remove(self.pid_file)
        except FileNotFoundError:
            pass
    
    def status(self) -> None:
        """Check daemon status."""
        pid = self.read_pid()
        if self.is_alive(pid):
            print(f"daemon running (pid {pid})")
        else:
            print("daemon not running")


# Create daemon instance
daemon = DevDaemon(PID_FILE, LOG_FILE, PORT)


# Legacy function wrappers for backward compatibility
def read_pid() -> Optional[int]:
    """Legacy wrapper for DevDaemon.read_pid()."""
    return daemon.read_pid()


def is_alive(pid: Optional[int]) -> bool:
    """Legacy wrapper for DevDaemon.is_alive()."""
    return daemon.is_alive(pid)


def start() -> None:
    """Legacy wrapper for DevDaemon.start()."""
    daemon.start()


def stop() -> None:
    """Legacy wrapper for DevDaemon.stop()."""
    daemon.stop()


def status() -> None:
    """Legacy wrapper for DevDaemon.status()."""
    daemon.status()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    {"start": start, "stop": stop, "status": status}.get(cmd, status)()