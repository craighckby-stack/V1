"""LOOP Build Record — narrative content, chapters 5-6 (failures and decisions)."""

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
          ".loop-push-state.json — the DB is a cache, the file is the source of truth, exactly the pattern "
          "that had already saved the postmortems (5.5). Write ordering is file-first on both insert and "
          "delete: writing DB-first leaves a zombie row when the file write fails, and deleting DB-first "
          "leaves a zombie credential when the row delete fails. The file is written atomically (temporary "
          "file, rename) at mode 0600, and on startup it re-seeds any missing DB rows bidirectionally. The "
          "fix was verified with a three-phase end-to-end test: file restored into a fresh DB, DB row "
          "back-filled into a missing file, and a full purge of both. All three phases passed."),
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
          "across restarts. <b>Fix.</b> SIGKILL to the full process tree, delete .next when corruption is "
          "suspected, then clean start. The lifecycle rules in 4.3 are this incident, written down."),
    ("h2", "5.4 The 429 wall"),
    ("p", "<b>Symptom.</b> The LLM endpoint exhausted its quota. Every enhancement attempt answered 429, "
          "and the original retry logic burned the cooldown window eighteen times inside a single cycle, "
          "escalating the gate level with each hit while accomplishing nothing. <b>Diagnosis.</b> The "
          "backoff was per-call, not per-cycle: the loop kept re-attempting inside a cycle that could not "
          "possibly succeed, and the gate escalated as if the endpoint were being hammered deliberately. "
          "<b>Fix.</b> Whole-cycle pausing — a 429 at cycle start parks the entire cycle, and an escalation "
          "mid-cycle breaks the for-loop so one window costs one escalation. Progress logging every 60 "
          "seconds during the pause, so an operator watching a frozen dashboard can tell a healthy cooldown "
          "from a hang. The consecutive-cooldown continuation rule was also corrected: continuing to wait "
          "requires zero enhancements plus at least one substantive defer, not just absence of success. "
          "During the live verification for Appendix G the gate escalated 2 to 5 minutes across cycles and "
          "the countdown chip tracked both levels correctly."),
    ("h2", "5.5 The postmortem persistence gap"),
    ("p", "<b>Symptom.</b> The postmortem records — the system's own notes about its rejections — went "
          "missing in a restart, with the rest of the DB-only state. <b>Diagnosis.</b> Same class as 5.1: "
          "postmortems were stored only in the database. <b>Fix (audit2-c).</b> Postmortem records moved to "
          "JSON files under postmortems/, mirroring the repo layout, with the DB as an index. The proof it "
          "worked is cold: across the later rollback that killed the DB again, the files survived — exactly "
          "one postmortem exists in the shipped record (the github-helpers REVIEW_REJECTED, Appendix F), "
          "because at the time of the fix that was the only record that had been created. The fix pattern "
          "then generalized into 5.1's design."),
    ("h2", "5.6 The geo-block"),
    ("p", "<b>Symptom.</b> A plan to move the LLM layer to a direct Gemini key produced a hard regional "
          "block: the sandbox's network egress is geographically restricted, and the provider refuses the "
          "region outright. <b>Diagnosis.</b> Verified at the provider's API surface — not a configuration "
          "error, an environment property. <b>Consequence.</b> The z-ai endpoint remains the only viable "
          "LLM provider in this environment; 429 responses from it are quota, not availability. A dormant "
          "gemini-direct adapter exists in the tree (llm/gemini-direct.ts) and the 607-line portable "
          "spec documents the intended provider swap for environments where it is allowed. The decision "
          "record is 6.3."),
    ("h2", "5.7 The tracked .env"),
    ("p", "<b>Symptom.</b> Not an outage — a standing exposure, found in review: .env is tracked by git in "
          "this repository, and the sandbox auto-commits at session boundaries, so anything placed in .env "
          "is one session boundary away from the remote. <b>Status.</b> Recorded deliberately rather than "
          "silently rewritten — this document does not edit history to look cleaner than it was. The "
          "secret-bearing state files are outside git and 0600 (3.4); the .env entry predates that design "
          "and is flagged for any future rebuild to avoid. The review that found it also found fourteen "
          "hardcoded absolute paths — decision 6.5 — and a provider enum missing the zai case, all fixed "
          "in the same pass."),
    ("h2", "5.8 Green logs, red state"),
    ("p", "The meta-incident, worth its own entry: several of the failures above shared a symptom — the "
          "server log looked healthy while the system was wrong (5.2, 5.3). The working rule that fell out "
          "of the week: read the log against the API responses and the git state, never trust any one "
          "channel alone. When the console says the loop is running, check the status route. When the "
          "report says branches exist, check the remote. When the log says the server started, check which "
          "process owns the port. Every audit rule in Chapter 7 is this paragraph, specialized."),
    ("h2", "5.9 The third persistence loss (cause undetermined)"),
    ("p", "<b>Symptom.</b> While compiling this record, the push-target state vanished: the state file, the "
          "database row, and the API view all report unconfigured — the PAT, repository, and branch counter "
          "gone together. This is a third loss, and its signature differs from the first two: in 5.1 the "
          "database was recreated and the file survived; here both copies are gone at once. "
          "<b>Diagnosis.</b> The full request log rules out the application: 991 GET requests on the "
          "push-target endpoint across the log and zero requests of any other method — no clear action was "
          "ever issued, and the only deletion code path is the clear endpoint. No filesystem rollback "
          "occurred (all session artifacts from the same hours survived, including files newer and older "
          "than the state file). The cause is undetermined, recorded as such. <b>What held.</b> The design "
          "assumption of 6.2 was that the filesystem is the durable layer and the database is the cache; "
          "this event removed the durable layer itself, which no in-system design can survive — the "
          "boundary of what persistence engineering can protect is the machine, not the application. "
          "<b>Recovery.</b> The operator re-enters the PAT in the config panel; nothing else is lost, "
          "because the state file only ever held configuration. The record itself was never at risk: "
          "the git history on the remote is the durable copy of everything that matters, which is the "
          "entire point of pushing every accepted mutation."),
]

CH6 = [
    ("h1", "Chapter 6 — Decisions Log: The Removed Bits"),
    ("p", "Every entry here is a fork where one design shipped and at least one alternative was considered, "
          "implemented in some cases, and removed. The removed bits are the point of this chapter: the "
          "current code reads as a set of arbitrary choices until the dead alternatives are visible, at "
          "which point each one reads as the survivor of a specific argument. The general pattern across "
          "all eight entries: the simpler mechanism lost to the one that degrades safely or fails closed."),
    ("h2", "6.1 Permanent EMG locking vs replaceable saturation"),
    ("p", "The early design, inherited from the EMG subsystem, locked a file permanently once it stopped "
          "improving — a one-way ratchet against wasted cycles. Removed. In a dependency graph rather than "
          "a linear queue, a permanent lock is wrong the moment a downstream mutation unlocks an upstream "
          "opportunity: the file that 'could not be improved' in generation N is improvable in generation "
          "N+1 after its consumers changed. The shipped design locks on three consecutive no-growth cycles, "
          "classifies outcomes into growth / no-growth / neutral so quota deferrals never lock a file "
          "that was never actually assessed, and exposes an unlock endpoint for the operator. The operating "
          "model that goes with it: linear per-module progression, system-level stability checkpoints, and "
          "cross-file dependencies handled by defer-and-queue rather than hard stops."),
    ("h2", "6.2 DB-first vs file-first persistence"),
    ("p", "Both orderings were implemented. DB-first is the natural instinct — the database is durable, "
          "typed, and transactional. Removed after 5.1: the database is the layer the environment recreates "
          "at boot, so DB-first state is the state that dies. The shipped ordering writes the plain file "
          "first (atomic, 0600), the DB second, deletes in the same order, and self-heals the DB from the "
          "file at startup. The database remains the query surface; the file is the record. The same "
          "pattern, applied earlier to postmortems, is what kept Appendix F in existence."),
    ("h2", "6.3 Direct Gemini vs the z-ai endpoint"),
    ("p", "The LLM layer was designed to be provider-portable, and a direct Gemini adapter was built — "
          "then parked. The portability survives in two forms: the LLMProvider interface with a mock that "
          "obeys the real output contract, and the 607-line reproduction spec that documents the swap for "
          "any environment where the provider is reachable. What shipped is the endpoint that is actually "
          "callable from this sandbox. The failed export review that motivated the swap also produced the "
          "portability review checklist in 6.7's sibling decisions — provider enums, output contracts on "
          "mocks, runtime declarations — all of which are worth more than the swap itself, because they are "
          "what keeps the swap possible later."),
    ("h2", "6.4 Whole-tree scan vs the TARGET_FILES allowlist"),
    ("p", "The original loop scanned the whole source tree every cycle. Removed for cost and for safety: "
          "cost, because a full scan starts above 100,000 tokens per cycle and grows with the platform "
          "layer; safety, because a mutation to a random file deep in a dependency chain cannot be "
          "reasonably reviewed in the same window. The allowlist ships with one display-side file, which "
          "is the smallest safe demonstration of the whole pipeline — one target that exercises scan, "
          "pin, enhance, gate, debate, commit, push, and hot-swap, at roughly 15,000 tokens per cycle. The "
          "empty-allowlist-means-disabled rule is the fail-closed property: misconfiguration stops the "
          "loop instead of widening it."),
    ("h2", "6.5 Fourteen hardcoded paths vs PROJECT_ROOT"),
    ("p", "The export review counted fourteen hardcoded absolute paths to /home/z/my-project across the "
          "tree. All consolidated behind a single PROJECT_ROOT constant, imported everywhere. Un glamorous, "
          "and the difference between a system that can be reasoned about from any working directory and "
          "one that quietly breaks when moved. This entry is here because it is the kind of fix that gets "
          "skipped in a rebuild if the failure is not recorded — the same review pass is itemized in the "
          "spec so a reproducer inherits it."),
    ("h2", "6.6 Serverless export vs self-hosted runtime"),
    ("p", "An export target was evaluated and rejected: SQLite files and multi-minute loop cycles are a "
          "poor fit for a serverless platform's ephemeral filesystem and execution windows. The shipped "
          "declaration on every route touching the LLM, the filesystem, or child_process is nodejs runtime "
          "with force-dynamic — the configuration a long-lived, stateful loop actually needs. Any future "
          "port should start from that declaration set, not from the export assumptions."),
    ("h2", "6.7 The .env question, and the review pass that found it"),
    ("p", "The full export review produced: the tracked .env (5.7), the fourteen paths (6.5), a provider "
          "enum that omitted the zai case, and mock providers that did not obey the real output contract. "
          "The last one is subtle and worth stating plainly: a mock that returns free-form output trains "
          "the gates on the wrong envelope, so when the real provider is attached the gates reject "
          "everything for format reasons and the operator concludes the provider is broken. The fixed "
          "mock obeys the identical contract — ENDORSE / APPROVED envelopes included — which is what makes "
          "the calibration stage of 4.1 meaningful. All four findings were fixed in one pass; the spec "
          "carries them forward as requirements."),
]

NARRATIVE_2 = CH5 + CH6
