# Phase E.0 probe procedure — `claude agents` + `COHERENCE_PORT` propagation

**Status**: **Both probes executed against claude v2.1.131 on 2026-05-17.**
Results section at the bottom. TL;DR:

- **Probe 2A (HTTP-type hooks): HARD FAIL** at hooks.json load-time URL validation.
- **Probe 2B (command-type hooks): PASS** — `agent-coherence-hook-client` built and wired in.
- **Probe 1 (subagent via Task tool): PASS** — hooks fire under the parent's session_id.
- **Unit 7 decision**: ship command-type hooks (`hooks-command.json` becomes `hooks.json`).
- **README claim**: "Agent View, multi-terminal, and Task-tool subagents" (no `claude agents`
  subcommand promise on v2.1.131 — its subcommand is a manager UI, not a spawner).

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

---

## Results (2026-05-17, claude v2.1.131)

### Probe 2A: HTTP-type hooks with `${COHERENCE_PORT}` — HARD FAIL

`hooks.json` (the HTTP variant from this commit) was rejected at LOAD TIME
with `plugin_errors: [{"type": "hook-load-failed", ...}]`. Specifically,
Claude Code's hooks.json schema validator runs strict URL parsing BEFORE
env-var expansion:

```json
{
  "code": "invalid_format",
  "format": "url",
  "path": ["hooks","PreToolUse",0,"hooks",0,"url"],
  "message": "Invalid URL"
}
```

— repeated for PreToolUse/0, PreToolUse/1, PostToolUse/0, Stop/0.

This is not a `$CLAUDE_ENV_FILE` propagation issue — it's a fundamental
constraint of v2.1.131's hooks.json schema. HTTP-type hooks with templated
URLs are not viable. Time wasted debugging env propagation: 0 (the probe
surfaced the actual blocker immediately).

### Probe 2B: command-type hooks via `agent-coherence-hook-client` — PASS

After building `agent-coherence-hook-client` (~30 min, library commit) and
swapping `hooks/hooks-command.json` into `hooks/hooks.json`, the plugin
loaded cleanly (no `plugin_errors`). Running:

```
claude --plugin-dir $PLUGIN --include-hook-events --output-format stream-json \
       --print --model haiku "Read docs/specs/test.md and respond with content"
```

produced these hook responses (filtered from stream-json):

```
PreToolUse:Read → {"status": "fresh"}   ← our hook-client response
Stop            → {"ok": true, "released_artifacts": []}
```

And `agent-coherence-status` after the session showed:

```
Observed artifacts:
  path                version
  ------------------  -------
  docs/specs/test.md        1

Sessions:
  90b1dfd3  claude-session-e1c06ce1-e05b-4a6a-9096-f05dde84f6ac
    docs/specs/test.md  SHARED
```

End-to-end: command-type hook → hook-client stdin parse → port + secret read
from `.coherence/` → POST to coordinator → MESI state set → status sees it.

### Probe 1: subagent via Task tool — PASS (with critical nuance)

`claude agents` subcommand on v2.1.131 is a manager UI, not a spawner (only
`--setting-sources` flag available; no spawn / list / kill / attach). To
test the user-relevant case, the probe used the Task tool to delegate to an
Explore subagent inside a regular session.

Outcome:

```
Agent  (parent)  parent_tool_use_id=None
Read   (sub)     parent_tool_use_id=toolu_01Y9LKSjQPnENzH6FMQtzzh8
```

Both the parent's Agent tool call AND the subagent's Read tool call carry
the same `session_id: 3c14a52f-...`. The subagent's hooks fire under the
parent's session_id.

**Implication**: this is GOOD for phpmac's failure mode. When the subagent
reads a stale CLAUDE.md, our coordinator's stale-read warning fires for the
parent's session — exactly the surfacing we want. The downside (no
per-subagent MESI state isolation) is a v0.2+ concern at most.

### Unit 7 / README impact

| Decision | Outcome |
|---|---|
| `hooks.json` shape | **command-type** (`agent-coherence-hook-client` invocations) |
| New library deliverable | `agent-coherence-hook-client` console script (landed) |
| `bin/ensure-coordinator` env-file write | Still needed for v2.1.138+ if it supports HTTP-type with templated URLs (unverified); kept as belt-and-suspenders |
| README coverage claim | "Agent View, multi-terminal, and Task-tool subagents" |
| `claude agents` (subcommand) mention | OMIT — v2.1.131 doesn't expose a spawner via subcommand |

### What surprised me

1. **CC's hooks.json URL validator runs before env-var expansion.** The
   plan and brainstorm both implied URL templating would work. Probe 2A's
   immediate hard fail at load time was unambiguous — no env-propagation
   ambiguity to debug. Worth flagging in any future plugin design doc.

2. **The plugin load-failure mode is `plugin_errors[]` in `init` event,
   not a stdout/stderr message.** Without `--output-format stream-json`,
   the failure is invisible — claude just runs normally and the user has
   no idea their plugin failed to load. Phase 0 buildability probes
   should ALWAYS include the stream-json flag for any plugin work.

3. **The `claude agents` subcommand on v2.1.131 has no spawner.** Prior
   memory flagged this as `UNTESTED`; now confirmed it's a management UI
   only. Spawning is via `--agent` flag or Task tool. Marketplace copy
   should not reference the `claude agents` subcommand as a coverage area
   on this version.

4. **Subagent hooks under parent's session_id**: design implication is
   beneficial (warnings surface to the parent), but worth documenting so
   v0.2 strict mode design doesn't accidentally assume per-subagent state
   isolation.
