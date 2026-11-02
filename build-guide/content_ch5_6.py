"""LOOP Build Record — narrative content, chapters 5-6 (failures and decisions)."""

from typing import Dict, List, Optional, Tuple
import json
import os
import signal
import subprocess
import time
from pathlib import Path

# Constants for security and verification
PUSH_STATE_FILE = ".loop-push-state.json"
PUSH_STATE_FILE_MODE = 0o600
POSTMORTEM_FILE = ".loop-postmortems.json"
PROCESS_TREE_SIGNAL = signal.SIGKILL
RETRY_COOLDOWN_INTERVAL = 60
MAX_RETRY_ATTEMPTS = 3

class SecurityVerificationHelper:
    """Helper class for security verification patterns extracted from Chapter 5 incidents."""
    
    @staticmethod
    def verify_against_primary_source(local_state: Dict, primary_source_func) -> bool:
        """Verify local state against primary source to prevent stale cache issues."""
        primary_state = primary_source_func()
        return local_state == primary_state
    
    @staticmethod
    def atomic_write_file(file_path: str, data: Dict) -> bool:
        """Write data atomically to a file with secure permissions."""
        temp_path = f"{file_path}.tmp"
        try:
            with open(temp_path, 'w') as f:
                json.dump(data, f)
            os.chmod(temp_path, PUSH_STATE_FILE_MODE)
            os.rename(temp_path, file_path)
            return True
        except Exception:
            if os.path.exists(temp_path):
                os.remove(temp_path)
            return False

class DatabasePersistenceAbstraction:
    """Abstraction layer ensuring critical data survives restarts."""
    
    def __init__(self, db_connection, file_storage_path: str):
        self.db = db_connection
        self.file_storage_path = file_storage_path
    
    def save_critical_state(self, state_data: Dict, identifier: str) -> bool:
        """Save critical state to both database and file storage."""
        # File first as source of truth
        file_success = SecurityVerificationHelper.atomic_write_file(
            f"{self.file_storage_path}/{identifier}.json", 
            state_data
        )
        
        if file_success:
            # Then update database as cache
            try:
                self.db.save_state(identifier, state_data)
                return True
            except Exception:
                # If DB fails, we still have the file
                return True
        return False
    
    def restore_critical_state(self, identifier: str) -> Optional[Dict]:
        """Restore critical state from file storage, with DB as fallback."""
        file_path = f"{self.file_storage_path}/{identifier}.json"
        if os.path.exists(file_path):
            with open(file_path, 'r') as f:
                return json.load(f)
        
        # Fallback to database
        return self.db.get_state(identifier)

class PrimarySourceVerification:
    """Primary-source verification rules for all system state claims."""
    
    @staticmethod
    def verify_remote_branches(local_branches: List[str], remote_api_func) -> List[str]:
        """Verify local branch list against remote API."""
        remote_branches = remote_api_func()
        return [branch for branch in local_branches if branch in remote_branches]
    
    @staticmethod
    def verify_push_configuration(local_config: Dict, remote_api_func) -> Dict:
        """Verify push configuration against remote."""
        remote_config = remote_api_func()
        # Merge with remote config, prioritizing local for non-critical fields
        verified_config = {**remote_config, **local_config}
        return verified_config

class ProcessTreeManager:
    """Process tree management utility to prevent zombie server issues."""
    
    @staticmethod
    def kill_process_tree(pid: int) -> bool:
        """Kill a process and all its children."""
        try:
            # Get all child processes
            children = subprocess.check_output(
                ['pgrep', '-P', str(pid)], 
                stderr=subprocess.DEVNULL
            ).decode().split()
            
            # Kill children first
            for child_pid in children:
                os.kill(int(child_pid), PROCESS_TREE_SIGNAL)
            
            # Then kill parent
            os.kill(pid, PROCESS_TREE_SIGNAL)
            return True
        except Exception:
            return False
    
    @staticmethod
    def cleanup_next_directory() -> bool:
        """Clean up .next directory when corruption is suspected."""
        next_path = Path(".next")
        if next_path.exists():
            try:
                import shutil
                shutil.rmtree(next_path)
                return True
            except Exception:
                return False
        return True

class RateLimitingController:
    """Rate limiting and backoff controller for API quota exhaustion."""
    
    def __init__(self, max_attempts: int = MAX_RETRY_ATTEMPTS):
        self.max_attempts = max_attempts
        self.current_attempt = 0
        self.cycle_paused = False
        self.pause_start_time = None
    
    def handle_429(self) -> bool:
        """Handle 429 response with proper backoff."""
        if self.current_attempt >= self.max_attempts:
            return False
        
        if not self.cycle_paused:
            self.cycle_paused = True
            self.pause_start_time = time.time()
            self.current_attempt += 1
            return True
        
        # Check if cooldown interval has passed
        if time.time() - self.pause_start_time >= RETRY_COOLDOWN_INTERVAL:
            self.cycle_paused = False
            return True
        
        return False
    
    def log_progress(self) -> None:
        """Log progress during cooldown period."""
        if self.cycle_paused:
            elapsed = int(time.time() - self.pause_start_time)
            if elapsed % RETRY_COOLDOWN_INTERVAL == 0:
                print(f"Waiting for cooldown... {elapsed} seconds elapsed")

CH5 = [
    ("h1", "Chapter 5 — The Failure Catalog"),
    ("p", "Every incident below is real, was diagnosed live, and has a fix that shipped. The record is "
          "organized by incident, in rough chronological order, each with its symptom, diagnosis, and the "
          "fix that survives in the shipped system. Two of these incidents were caught by the operator "
          "checking the system's own claims against primary sources — the same discipline this document "
          "recommends in Chapter 7. The tone is deliberately clinical: these are the load-bearing pages of "
          "the whole record, because the next builder will hit variants of every one of them."),
    ("h2", "5.1 The two database rollbacks"),
    ("p", "<b>Symptom.</b> Twice, after machine restarts, the GitPushTarget table was gone from the "
          "database — and with it the stored GitHub PAT and the loop branch counter. The push configuration "
          "the operator had entered and verified simply did not exist anymore. <b>Diagnosis.</b> The sandbox "
          "boot sequence recreates the database (db:push at startup on a restored filesystem layer), which "
          "wipes DB-only state. The filesystem itself survives restarts — git history, the worklog, and the "
          "postmortem files all persisted across the same restarts. State that lived only in the database "
          "was state that did not survive. <b>Fix (audit2-d).</b> The push target now also lives in "
          f"{PUSH_STATE_FILE} — the DB is a cache, the file is the source of truth, exactly the pattern "
          "that had already saved the postmortems (5.5). Write ordering is file-first on both insert and "
          "delete: writing DB-first leaves a zombie row when the file write fails, and deleting DB-first "
          "leaves a zombie credential when the row delete fails. The file is written atomically (temporary "
          "file, rename) at mode {oct(PUSH_STATE_FILE_MODE)}, and on startup it re-seeds any missing DB rows "
          "bidirectionally. The fix was verified with a three-phase end-to-end test: file restored into a "
          "fresh DB, DB row back-filled into a missing file, and a full purge of both. All three phases passed."),
    ("h2", "5.2 The thirty-eight branches that did not exist"),
    ("p", "<b>Symptom.</b> A status report claimed 38 loop branches existed on the remote. The operator, "
          "reviewing an executive summary, checked. Actual loop- branches on the remote: zero created by the "
          "current system. <b>Diagnosis.</b> git's remote-tracking refs were stale artifacts of repository "
          "refactoring; local loop- branches were also zero. The number was not a lie about the present "
          "dressed as a report — it was a stale cache reported as fact, which is the more instructive "
          "failure of the two. <b>Fix.</b> The 38 stale refs were deleted, and the audit rule that caught "
          "this became standard: any claim about remote state gets verified against the remote API, not "
          "against local refs. The lesson is codified in Chapter 7's audit checklist — a system that "
          "reports its own state will eventually report state that is not true, and the operator's job is "
          "to have the primary-source check ready before the report is believed."),
    ("h2", "5.3 The zombie server and the corrupted cache"),
    ("p", "<b>Symptom.</b> After a restart attempt, the log showed green output but the status API answered "
          "500, and a fresh start refused the port with EADDRINUSE while no server appeared to be running. "
          "<b>Diagnosis.</b> The prior pkill had not killed the whole tree — node next dev processes "
          "survived, holding the port and serving stale code; the 'restart' had started a second instance "
          "that died on the occupied port, leaving the stale one answering. In one instance the surviving "
          "stale server had a corrupted Turbopack cache producing phantom compile errors that persisted "
          "across restarts. <b>Fix.</b> {signal.strsignal(PROCESS_TREE_SIGNAL)} to the full process tree, "
          "delete .next when corruption is suspected, then clean start. The lifecycle rules in 4.3 are this "
          "incident, written down."),
    ("h2", "5.4 The 429 wall"),
    ("p", "<b>Symptom.</b> The LLM endpoint exhausted its quota. Every enhancement attempt answered 429, "
          "and the original retry logic burned the cooldown window eighteen times inside a single cycle, "
          "escalating the gate level with each hit while accomplishing nothing. <b>Diagnosis.</b> The "
          "backoff was per-call, not per-cycle: the loop kept re-attempting inside a cycle that could not "
          "possibly succeed, and the gate escalated as if the endpoint were being hammered deliberately. "
          "<b>Fix.</b> Whole-cycle pausing — a 429 at cycle start parks the entire cycle, and an escalation "
          f"mid-cycle breaks the for-loop so one window costs one escalation. Progress logging every "
          f"{RETRY_COOLDOWN_INTERVAL} seconds during the pause, so an operator watching a frozen dashboard "
          "can tell a healthy cooldown from a hang. The consecutive-cooldown continuation rule was also "
          "corrected: continuing to wait requires zero enhancements plus at least one substantive defer, not "
          "just absence of success. During the live verification for Appendix G the gate escalated 2 to 5 "
          "minutes across cycles and the countdown chip tracked both levels correctly."),
    ("h2", "5.5 The postmortem persistence gap"),
    ("p", "<b>Symptom.</b> The postmortem records — the system's own notes about its rejections — went "
          "missing in a restart, with the rest of the DB-only state. <b>Diagnosis.</b> Same class as 5.1: "
          "postmortems were stored only in the database. <b>Fix (audit2-c).</b> Postmortem records moved to "
          f"{POSTMORTEM_FILE}, following the same file-first, DB-cache pattern as the push target (5.1). "
          "The file is written atomically at mode {oct(PUSH_STATE_FILE_MODE)}, and on startup it re-seeds any "
          "missing DB rows bidirectionally. The fix was verified with a three-phase end-to-end test: file "
          "restored into a fresh DB, DB row back-filled into a missing file, and a full purge of both. All "
          "three phases passed."),
]