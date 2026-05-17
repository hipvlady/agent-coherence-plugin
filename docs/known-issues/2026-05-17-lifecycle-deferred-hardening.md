# Unit 5 deferred hardening — lifecycle (fcntl spawn, idle shutdown, sweep)

**Status**: documented limitations of the v0.1 lifecycle module. None are blocking
for the v0.1 private alpha (~10 hand-picked installers, single-developer
interactive use). Each carries an explicit resolution target.

**Source**: adversarial review of `src/ccs/adapters/claude_code/lifecycle.py`
(library commit `e545a4a`). Three of four findings here were caught by the
adversarial subagent during the post-Unit-5 structured pause; one (`L4`) came
from own re-read of the residual risks.

---

## L1 — Inode race on `rm -rf .coherence/` mid-retry

**Severity**: P1 (narrow operational case).

**Scenario**: `ensure_coordinator` opens `server.pid` once at the top of its
unified spawn-or-join loop and keeps that fd across all 60 retry iterations
(~3000ms budget). If an external process unlinks `.coherence/` mid-retry (e.g.
`rm -rf` for a cold restart) and another spawn-side caller recreates it, the
loser's fd now refers to an orphaned inode. Subsequent `fcntl.flock` acquisitions
and port-file reads on that fd interact with a file that has no path —
operationally invisible but capable of producing a coordinator that no other
process can reach because the live pid file is on a different inode.

**Why deferred for v0.1**:
- Requires an external `rm -rf` during the 3-second retry window — operationally
  rare in single-developer interactive sessions.
- Two readily-available mitigations on the operator side:
  1. Don't `rm -rf .coherence/` while sessions are active; use
     `/agent-coherence reset` (Unit 6) instead.
  2. After any manual cleanup, restart your Claude Code sessions.

**Fix target**: v0.1.1 design pass. On each retry iteration, `os.stat` the path
and compare `st_ino`/`st_dev` against the fd's `fstat`. On mismatch, close the
fd and re-open, restart the retry counter.

---

## L2 — In-flight HTTP handler truncated by `registry.close()`

**Severity**: P2 (rare but real wedge under load).

**Scenario**: `coordinator.shutdown()` calls `self._server.shutdown()`
(stops the accept loop) then `self.registry.close()` (closes the SQLite
connection). `_ThreadingHTTPServer` sets `daemon_threads=True`, which means
`server.shutdown()` does NOT wait for in-flight handler threads to finish —
it only stops accepting new requests. If a handler is mid-write to SQLite
when `registry.close()` runs, the handler raises
`sqlite3.ProgrammingError: Cannot operate on a closed database`, the response
is never sent, and the hook handler client hangs until its TCP timeout.

**Why deferred for v0.1**:
- Requires concurrent hook traffic at the exact moment idle shutdown fires
  (idle threshold is 15 minutes by default, so this needs a session that
  starts a long-running tool right at the boundary).
- Fix requires changes to `CoordinatorHTTPServer` (in-flight semaphore in
  `mark_request`), which would re-test the Unit 4 suite (63 tests).
- Under v0.1 single-developer interactive load, the race window is
  effectively never hit.

**Fix target**: v0.1.1. Add an in-flight counter to `mark_request` (incremented
at handler entry via `_dispatch`, decremented at exit via a `finally`-wrapped
hook). `coordinator.shutdown()` waits on the counter to reach zero before
calling `registry.close()`, with a bounded timeout (e.g. 5s) and a hard
`registry.close()` afterward if drain doesn't complete (the alternative is
worse — wedging the coordinator indefinitely).

Alternative: switch `_ThreadingHTTPServer.daemon_threads = False` and
`block_on_close = True` so the stdlib does the drain bookkeeping. Risk: any
handler that hangs (e.g. SQLite deadlock) wedges shutdown. Re-evaluate when
handler bounds are tightened in v0.1.1.

---

## L3 — 30-process thundering herd may exhaust 3-second retry budget

**Severity**: P2 (env-dependent).

**Scenario**: Default `port_file_retry_attempts = 60 × 50ms = 3000ms`. If 30
Claude sessions in a workspace start simultaneously (e.g. CI test harness
spinning up parallel agents) and the winner's cold-start path takes longer
than 3 seconds (Python interpreter import + transitive `ccs` imports + SQLite
WAL setup under 30-way disk contention), losers exhaust retry and return -1.
Hook handlers degrade to "no coordinator" silently.

**Why deferred for v0.1**:
- v0.1 ships warn-only with private alpha to ~10 hand-picked installers; the
  observed pattern is 1-3 sessions per workspace at most.
- Cold-start measurement requires telemetry that lands in v0.1.1.
- The 3000ms default was bumped from the original 1500ms specifically in
  response to this finding, providing 2x headroom against the previous
  budget.

**Fix targets**:
- **v0.1.1**: instrument cold start; set default budget to 3× measured p99.
  Add `COHERENCE_RETRY_BUDGET_MS` env var so operators can override.
- **v0.2**: the winner should write the port file IMMEDIATELY after `flock`
  acquisition, BEFORE doing any SQLite or import work. Requires refactoring
  `CoordinatorHTTPServer.__init__` to defer SQLite open until after the
  socket is bound. Not worth the v0.1 risk.

---

## L4 — `stop_coordinator` returns False even when idle-loop completed shutdown

**Severity**: P3 (cosmetic — no operational impact).

**Scenario**: `stop_coordinator(workspace)` checks `_SPAWNED_REGISTRY.get(key)`
and returns False if no entry exists. If the idle-shutdown thread already
ran `_shutdown_sequence` and popped the registry, a manual
`stop_coordinator` call returns False — implying "no coordinator was running
in this process", when in fact this process DID spawn one but it was already
cleanly stopped. Misleading return value, but the caller's intent (coordinator
is no longer running) is satisfied either way.

**Why deferred for v0.1**:
- No operational impact — the workspace is correctly shut down in both branches.
- Fix requires a per-coordinator "we did the shutdown" state separate from
  registry membership; not worth the API change for a cosmetic distinction.

**Fix target**: v0.1.1 or later. Track `shutdown_done` for popped entries
in a short-lived "recently stopped" cache so the return distinguishes
"someone in this process did it" from "no one in this process spawned one".

---

## L5 — Wall-clock vs monotonic mixing in idle countdown

**Severity**: P3 (rare — system clock jumps).

**Scenario**: `_idle_shutdown_loop` reads `time.time() - coordinator._last_request_at`
(wall clock). If the system clock jumps forward (e.g. NTP correction after long
hibernation), idle shutdown may fire immediately even if no real idle interval
elapsed. Conversely, a backward jump can postpone shutdown by the jump
magnitude.

**Why deferred for v0.1**:
- NTP corrections are typically sub-second; doesn't cross the 15-minute default
  idle threshold.
- Laptop suspend/resume IS a real source of large jumps, but the side effect
  ("shutdown fires on wake") is benign — coordinator re-spawns lazily on the
  next hook.

**Fix target**: v0.1.1 cleanup. Track `_last_request_at_monotonic` parallel
to `_last_request_at` and use the monotonic value in the idle loop.
`CoordinatorHTTPServer.mark_request` would update both. No external API change.

---

## Composite signal

These items are intentionally documented (not silently deferred) so that:

1. v0.1 alpha installers can recognize the symptoms if they hit them and
   know to file an issue with concrete context.
2. The v0.1.1 design pass has an explicit punch list rather than discovering
   these the hard way during marketplace QA.
3. Reviewers of `src/ccs/adapters/claude_code/lifecycle.py` (open source
   reviewers in particular) can quickly see what was deliberately left for
   later and what the resolution path is.

The pattern matches `2026-05-17-watchdog-races.md` (A6/A7 from Unit 4):
explicit known-issue documents for findings the adversarial review surfaced,
filed before the v0.1.1 design pass touches them.

## Related

- Adversarial subagent finding `#3` (POSIX flock leak via close) was
  **disproven** during synthesis — `fcntl.flock(2)` is per-open-file-description
  on Linux and macOS, not per-process. Same-process double-spawn benignly
  short-circuits via the G3 entry check (`_SPAWNED_REGISTRY` lookup). No
  flock leak. Documented here only because the original review claim is
  cited in the lifecycle commit message.
