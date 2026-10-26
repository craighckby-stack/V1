# Where the System Could Go From Here

A writeup of the directions discussed for the self-enhancing code pipeline, in
order from safest to most ambitious. All directions build on the existing
plumbing — autonomous loop, in-memory typecheck, token-safe push, proof
commits on GitHub. What changes is the *purpose*.

---

## The Honest Starting Point

The system works. The plumbing is solid:
- Autonomous loop scans its own source, refactors via LLM, verifies via
  in-memory TypeScript typecheck, writes to live file, pushes to GitHub
- 61 commits on `craighckby-stack/V1`, authored as the real GitHub identity
- Token-safe push (env-injected auth, never in git config/URL)
- Circuit breaker for 429 rate limits, banner stripping, truncation detection
- Zero Turbopack stale errors (the in-memory typecheck fixed that)

But the enhancements are cosmetic. The LLM adds type annotations and
extracts magic numbers — 1-byte diffs that prove nothing. The system is a
well-built engine with no destination.

**The missing piece in every direction below is a real feedback signal.**
Typecheck-passing is necessary but not sufficient. Without tests, behavioral
checks, or user approval, "what changed" is just "what the LLM felt like
changing." The gate proves the code compiles, not that it's better.

---

## Direction 1 — Chat-Driven Agent (User Is the Signal)

The terminal stops being a control panel for an autonomous loop and becomes
the interface to a coding partner. The user describes a goal in plain
English; the system breaks it into file changes; each change goes through
the existing verify-typecheck-push pipeline; the user sees the commit and
says "yes/no/adjust."

**Why it works:** The user IS the feedback signal. No autonomous loop
required — the system works on demand. The autonomy was the wrong default
for most tasks anyway.

**What changes:** The prompt, the trigger (on-demand, not continuous), and
the commit message (references the user's request). The plumbing stays.

**Risk:** Low. The user is in the loop.

---

## Direction 2 — Skill-Based Self-Reconfiguration

The system's purpose becomes a runtime parameter. The user picks from a
menu of "skills" (bug-finder, legacy modernizer, security patcher, PR
reviewer, test-writer). Each skill is a definition file — prompt +
verification rules + target scope + commit format. The system reads the
selected skill definition and **refactors its own code** to embody that
mode: the prompt, the gate, the target, the commit message format.

The recursive angle: the self-enhance loop finally has a real use —
reconfiguring itself toward a user-chosen goal. The diff is meaningful
because it's moving toward a defined target.

**Why it works:** Skills become data, not code. Adding a new skill doesn't
require touching the loop — you write a definition and the system ingests
it. Every skill switch is a commit, auditable on GitHub. The history
becomes a log of intent.

**What changes:** A skills directory with definition files. The loop
reads the active skill and adapts its behavior. Core machinery (loop,
typecheck, push) stays invariant.

**Risk:** Medium. The line between "reconfigure" and "break yourself" is
thin. Skills must be sandboxed definitions — the system changes its
*configuration*, not its *core machinery*.

---

## Direction 3 — Bring Back the "rea" External-Repo Pipeline

The original pipeline (target: `craighckby-stack/rea` on GitHub) was built
to fetch a real repo, find real issues, push real fixes to an evolution
branch. It had a 6-stage process: sanitize → analyze → propose → debate →
verify → push. The current self-enhance loop only has typecheck.

**What "rea" had that the current system lost:** the 6-stage verification
(sanitizer for credentials, debate between multiple agents, AST diff gate
for structural verification, RAG memory, postmortem constraints). Real
verification layers beyond typecheck.

**What the current system has that "rea" didn't:** in-memory typecheck,
real enhancement prompt (find bugs, not cosmetic), token-safe push,
truncation detector, 429 circuit breaker, banner guard. All the plumbing
fixes from this session.

Combining them: 6-stage verification + robust plumbing, pointed at an
external repo. User pastes a repo URL, system fetches it, runs the full
pipeline, opens an evolution branch with real fixes.

**Risk:** Medium-high. The old "rea" run produced ~7,000 garbage commits
on `helper-evolution` before we stopped it. The 6-stage pipeline was
supposed to prevent that, but the debate and AST gate were either disabled
or ineffective. If brought back, those stages need to actually work.

---

## Direction 4 — Feedback-Driven Evolution (Tests as the Gate)

Flip the verification gate. Right now tsc-passing is the finish line. Make
*test-passing* the finish line: the LLM can change anything, but only
commits that make a previously-failing test green get pushed.

Now every enhancement is provably better, not just compilable. The system
becomes a genuine improvement engine instead of a self-grooming machine.

**Why it works:** Tests are the signal typecheck can't provide. The system
optimizes for real behavior change, not style.

**Risk:** Requires a test suite to exist. Writing the tests is itself a
useful discipline — if the system can't find a test to make pass, it has
no work to do.

---

## Direction 5 — Production Self-Healing

Point it at a live service with metrics. Error rate spikes on a route →
read the trace → find the likely cause → propose a patch → run tests →
deploy. The loop becomes reactive to real failures instead of speculative.

**Why it works:** Real failures are the strongest possible signal. The
system only acts when something is actually broken.

**Risk:** High. Closest to genuine autonomy. Needs sandboxed deploy,
rollback, and a very careful choice of what "fix" means.

---

## Direction 6 — The Self-Prompting Loop (No Human in the Loop)

The system writes its own skill definitions and applies them. It looks at
its current state, decides what it should become next, writes the skill
that gets it there, reconfigures itself, runs, evaluates, repeats.

This is recursive self-improvement with no external signal. The only
feedback loop is whether *it thinks* it's improving.

**Why it's a trap:** This doesn't produce superintelligence, it produces
drift. A system that defines its own success metric and chases it will
optimize for something measurable but pointless — commit count, file
size, complexity metrics. The same way a language model trained on
engagement becomes controversial, a self-prompting system trained on "am
I better" becomes weird. Not dangerous. Just useless, fast.

**The genuinely risky version:** give it a *real* feedback signal (tests
pass, users approve, bugs close) and let it rewrite its own skill
definitions to maximize that signal. *That* works, and that's the version
that scales in ways you can't predict. A system optimizing for "closed
bugs" will find ways to close bugs you didn't know existed, including ones
you didn't want closed.

---

## The Pattern

All useful directions share one thing: **a real signal that's not the
LLM's own output.** Tests pass. User approves. Bug is closed. CVE is
patched. Reviewer accepts. Error rate drops.

The plumbing is ready for any of them. Pick the signal, and the rest is
wiring.

---

## The Stop Point

There is exactly one natural limit on all of this, and it's already
built in: **the LLM API rate limit.**

Every direction above runs through the same `llmComplete()` call, which
already has:
- Exponential backoff for 429s (10s → 20s → 40s → 80s)
- Circuit breaker in the loop (pauses 15-60s on consecutive 429s)
- 5 retry attempts before giving up

When the API says "Too many requests," the system pauses and waits. It
doesn't crash, doesn't spiral, doesn't burn through quota. It just stops
until the limit resets, then continues.

This is the only stop point the system needs. No external kill switch
required — the API provider enforces the ceiling. The system can run
autonomously, switch skills, rewrite itself, evolve toward any signal —
and the only thing that naturally slows it down is the API saying "no
more for now."

In the self-prompting version (Direction 6), this is the one constraint
that prevents runaway drift. The system can rewrite its own goals all it
wants, but it can only act at the rate the API allows. The rate limit is
the throttle that makes all the ambitious directions safe enough to
actually try.

**The API limit is the safety mechanism. It's already there.**

---

## Summary

The system is a well-built engine with no destination. The plumbing
works — autonomous loop, verified writes, proof-pushes, rate-limit
handling. What's missing is the *why*.

| Direction | Signal | Risk | Built? |
|---|---|---|---|
| Chat-driven agent | User approval | Low | No |
| Skill-based reconfig | User-selected skill | Medium | No |
| External repo (rea) | Real bugs in real code | Medium | Was built, needs revival |
| Test-driven evolution | Tests pass | Medium | No |
| Production self-healing | Error rates | High | No |
| Self-prompting loop | It decides | High | No |

Pick a signal. The rest is wiring. The API limit is the throttle.
EOF
echo "done"