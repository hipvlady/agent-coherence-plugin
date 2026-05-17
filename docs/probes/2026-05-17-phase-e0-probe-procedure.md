# Phase E.0 probe procedure — `claude agents` + `COHERENCE_PORT` propagation

**Status**: probe artifacts ready, awaiting interactive `claude` CLI execution.

**What this answers**:
- **Probe 1** — Do PreToolUse hooks fire on `claude agents` background sessions
  on the current `claude` CLI version? Outcome shapes README/marketplace
  positioning copy (broader vs. narrower coverage claim).
- **Probe 2** — Does the URL-template variable `${COHERENCE_PORT}` in hooks.json
  resolve correctly when our SessionStart hook writes `export COHERENCE_PORT=N`
  to `$CLAUDE_ENV_FILE`? Outcome decides Unit 7's hooks.json shape:
  HTTP-type (current design) vs. command-type fallback.

**Estimated cost**: ~30 min wall time, ~$1 in API calls.

---

## Pre-flight: scaffold fix already applied

The existing `bin/ensure-coordinator` shim previously claimed to write
`export COHERENCE_PORT=<port>` to `$CLAUDE_ENV_FILE` — but
`agent-coherence-coordinator` only prints `port=N` to stdout; nothing
actually appended to the env file. The propagation chain was broken on
our side, independent of any Claude Code platform behavior.

This is **fixed in the same commit as this doc** — the shim now captures
`agent-coherence-coordinator`'s stdout, parses `port=<N>`, validates,
and appends `export COHERENCE_PORT=$port` to `$CLAUDE_ENV_FILE` when
that var is set. With this fix, probe 2A is a clean test of Claude
Code's env-propagation behavior rather than our own bug.

Probe 2B (command-type fallback) bypasses the env-var chain entirely
by reading `.coherence/server.pid` directly — but requires the
`agent-coherence-hook-client` console script, which is **deferred until
probe 2A's result is known**:
- If 2A passes, we never need hook-client; ship as-is.
- If 2A fails, building hook-client becomes a Unit 7 deliverable; the
  user pings me with 2A's failure mode and I land hook-client + 2B
  re-runs.

---

## Probe environment setup

```bash
# 1. Fresh isolated workspace
SMOKE=$(mktemp -d)
cd "$SMOKE"
git init -q
mkdir -p docs/specs
echo "spec v1" > docs/specs/test.md

# 2. Install the library
pip install -e /Users/vladparakhin/projects/agent-coherence

# 3. Confirm the coordinator CLI is on PATH
command -v agent-coherence-coordinator
command -v agent-coherence-status

# 4. Locate the plugin
PLUGIN=/Users/vladparakhin/projects/agent-coherence-plugin
ls "$PLUGIN/.claude-plugin/plugin.json"
ls "$PLUGIN/hooks/hooks.json"
```

---

## Probe 1: `claude agents` background-session hook firing

**Goal**: confirm PreToolUse fires for a Read inside a `claude agents`
background session, against the real plugin.

```bash
# 1. Pre-track the test artifact so the policy matcher is non-empty
agent-coherence-coordinator
agent-coherence-track docs/specs/test.md

# 2. Spawn a background session that reads the tracked file
claude --plugin-dir "$PLUGIN" \
       agents "Read the file docs/specs/test.md and report its content"

# Wait for the agent to finish, then:

# 3. Inspect coordinator state — if PreToolUse fired, the artifact
#    should appear in `agent-coherence-status` as observed (not just
#    policy-eligible).
agent-coherence-status
```

**Decision branches**:

| Outcome | Status output | What it means | Unit 7 / README impact |
|---|---|---|---|
| **A: hooks fire** | Observed artifacts includes `docs/specs/test.md` | `claude agents` triggers PreToolUse | README claims "Agent View, claude agents, multi-terminal" hold |
| **B: hooks don't fire** | Observed artifacts empty | `claude agents` doesn't trigger PreToolUse | README narrows to "Agent View + multi-terminal"; add explicit note in README + marketplace listing; consider opening upstream issue |

---

## Probe 2: `COHERENCE_PORT` propagation via `$CLAUDE_ENV_FILE`

**Goal**: confirm the SessionStart shim's `export COHERENCE_PORT=N` write
reaches subsequent PreToolUse hooks. The current hooks.json uses
`${COHERENCE_PORT}` URL-template expansion which fails silently if the
variable is unset.

### Variant A — current HTTP-type design

```bash
# 1. Clean workspace state
cd "$SMOKE"
rm -rf .coherence/

# 2. Apply the bin/ensure-coordinator fix from pre-flight above
# (one-line patch to write CLAUDE_ENV_FILE)

# 3. Run a session that should trigger a tracked Read
claude --plugin-dir "$PLUGIN" \
       --include-hook-events --output-format stream-json \
       "Read docs/specs/test.md and tell me what's in it" > /tmp/probe2a.log 2>&1

# 4. Check whether the PreToolUse hook actually fired the URL
grep -E 'pre-read|COHERENCE_PORT|hook' /tmp/probe2a.log | head -20

# 5. Check coordinator observed the read
agent-coherence-status
```

**Pass criteria**: `agent-coherence-status` shows `docs/specs/test.md`
as an observed artifact (v1 after the read). The hook URL was resolved
correctly because `$COHERENCE_PORT` propagated.

**Fail criteria**: Observed artifacts empty AND `/tmp/probe2a.log` shows
URL like `http://127.0.0.1:/hooks/pre-read` (empty port) OR connection
errors. Means `${COHERENCE_PORT}` URL templating doesn't get the
SessionStart shim's write — `$CLAUDE_ENV_FILE` propagation is broken
or untimely.

### Variant B — command-type fallback (deferred until 2A result is known)

If variant A fails, the planned fallback is `hooks/hooks-command.json`
(already staged in this commit). It invokes a thin Python client —
`agent-coherence-hook-client` — that reads `.coherence/server.pid` and
`.coherence/hook.secret` directly, then posts the hook payload via HTTP.
This bypasses the `$COHERENCE_PORT` env chain entirely.

**Status**: `agent-coherence-hook-client` is NOT yet implemented in
the library — it's a Unit 7 contingent deliverable. If 2A fails,
ping back with the failure mode (empty URL? wrong port? hook never
fires?) and I'll land hook-client as a small targeted PR. Then
re-run 2B with the swap:

```bash
cp "$PLUGIN/hooks/hooks-command.json" "$PLUGIN/hooks/hooks.json"
# Re-run step 3 of variant A
```

**Pass criteria for B**: same as A — status shows the observed artifact.

### Variant B fallback rationale

Command-type hooks invoke a thin Python client that:
1. Reads `<workspace>/.coherence/server.pid` to get the port
2. Reads `<workspace>/.coherence/hook.secret` for the Bearer token
3. POSTs the hook payload to the coordinator's HTTP endpoint

This avoids any dependency on Claude Code env-var propagation. Trade-off:
adds ~50ms per hook (Python startup + import) vs. HTTP-type's direct
URL templating. Acceptable for v0.1 if A fails.

---

## Decision matrix → Unit 7 hooks.json shape

| Probe 1 | Probe 2A (HTTP) | Probe 2B (command) | Unit 7 shape | README claim |
|---|---|---|---|---|
| Pass | Pass | (not run) | **HTTP-type as designed** + bin/ensure-coordinator env-file fix | "Agent View, claude agents, multi-terminal" |
| Pass | Fail | Pass | **Command-type fallback** (Python client) | Same — coverage unchanged |
| Pass | Fail | Fail | **HARD BLOCK** — neither path works; design pause | TBD until path found |
| Fail | Pass | (not run) | HTTP-type but README narrows | "Agent View + multi-terminal" |
| Fail | Fail | Pass | Command-type, README narrows | "Agent View + multi-terminal" |
| Fail | Fail | Fail | **HARD BLOCK** | TBD |

The hard-block branches mean the v0.1 ship date pauses while we either
file an upstream Claude Code issue or design a fundamentally different
delivery model (e.g., hosted MCP path).

---

## What to report back

After running both probes, paste:
1. **Probe 1 outcome**: A (hooks fire) or B (don't fire), with the
   `agent-coherence-status` output as evidence.
2. **Probe 2A outcome**: pass / fail. If fail, paste the line from
   `/tmp/probe2a.log` showing the resolved URL.
3. **Probe 2B outcome** (only if 2A failed): pass / fail.
4. Any unexpected output, errors, or surprises.

I'll fold the outcome into Unit 7's `hooks.json` shape decision and
the README's coverage claim before any Unit 7 implementation lands.
