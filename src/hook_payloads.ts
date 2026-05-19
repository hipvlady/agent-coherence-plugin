/**
 * Hook response builders — Node port of Python `hook_payloads.py`.
 *
 * Produces the exact `hookSpecificOutput` shapes Claude Code injects into
 * the agent's context: stale-read warnings, edit-collision warnings,
 * preemption-notice prose. Per-invocation variation in the text is
 * structural defense for v0.2 strict mode (the §13.5 retry-loop hazard the
 * Phase 0 falsifiability experiment investigated — see
 * docs/probes/2026-05-19-ktd-e-falsifiability/REPORT.md).
 *
 * Per KTD-B.3 C3: the OUTER response keys are snake_case (we own them).
 * Per the same: `hookSpecificOutput` and all keys inside it are camelCase
 * (Claude Code owns the hook-output schema — this is the documented
 * boundary).
 *
 * Per KTD-13: NEVER include content bytes, content hashes, or diff text
 * in the response surface. Stale-read summary is structural metadata only.
 */

export interface StaleSummary {
  path: string;
  current_version: number;
  prior_version_seen_by_session: number | null;
  last_writer_session_id: string;
  last_writer_at_unix_ts: number;
  warning_generated_at_unix_ts: number;
  hash_differs: boolean;
}

export interface HookSpecificOutput {
  hookEventName: "PreToolUse";
  permissionDecision: "allow" | "deny" | "ask";
  additionalContext: string;
  permissionDecisionReason?: string;
}

export interface StaleResponse {
  hookSpecificOutput: HookSpecificOutput;
  status: "stale";
  summary: StaleSummary;
}

export interface CollisionResponse {
  hookSpecificOutput: HookSpecificOutput;
  ok: true;
  collision: true;
}

export interface FreshResponse {
  status: "fresh";
}

export interface FreshWithNoticeResponse {
  status: "fresh";
  hookSpecificOutput: HookSpecificOutput;
}

/** Single source of truth for "now" in unix-seconds; tests can mock later. */
export function nowUnix(): number {
  return Date.now() / 1000;
}

function isoUtc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * Build the stale-read additionalContext text. Per-invocation variation
 * via `warning_generated_at_unix_ts` (handler-time now()) guarantees
 * byte-different text across retries — structural defense for any future
 * strict-mode flip. Matches Python `stale_read_warning` prose pattern.
 */
export function staleReadWarning(summary: StaleSummary): string {
  const lastWriterShort = summary.last_writer_session_id.slice(0, 8);
  const lastWriterTs = isoUtc(summary.last_writer_at_unix_ts);
  const generatedTs = isoUtc(summary.warning_generated_at_unix_ts);

  const priorClause =
    summary.prior_version_seen_by_session !== null
      ? `you previously saw v${summary.prior_version_seen_by_session}`
      : "this is the first time your session has observed this artifact " +
        "(another session in this workspace registered it before you)";

  const divergence = summary.hash_differs
    ? "Your worktree's current content also differs from the coordinator's " +
      "last-recorded hash, which suggests in-flight local edits or a " +
      "different branch checkout."
    : "Your worktree's content matches the last-recorded hash; the divergence " +
      "is purely about version-tracking metadata.";

  return (
    `⚠ Stale read [warning emitted ${generatedTs}]: ${summary.path} was ` +
    `updated by session ${lastWriterShort} at ${lastWriterTs}. ` +
    `Current version is v${summary.current_version}; ${priorClause}. ` +
    `${divergence} ` +
    `Consider re-reading ${summary.path} before acting on stale assumptions.`
  );
}

/**
 * Build the edit-collision additionalContext text. Per-invocation variation
 * via `detected_ts = now()` matches Python's structural defense.
 */
export function editCollisionWarning(
  holderSessionId: string,
  holderAcquiredAtUnixTs: number,
  path: string,
): string {
  const holderShort = holderSessionId.slice(0, 8);
  const holderTs = isoUtc(holderAcquiredAtUnixTs);
  const detectedTs = isoUtc(nowUnix());
  return (
    `⚠ Concurrent edit detected at ${detectedTs} (UTC): another session ` +
    `(${holderShort}) has been editing ${path} since ${holderTs}. ` +
    `Your edit will land in your own worktree, but only one session's ` +
    `commit will be accepted by the coordinator. Consider waiting for the ` +
    `other session to finish or coordinating which one should proceed.`
  );
}

/**
 * Build the preemption-notice additionalContext text for a session whose
 * grant was silently revoked by a peer. Mirrors Python's
 * `_build_preemption_text`.
 */
export function preemptionNoticeText(
  notices: ReadonlyArray<{
    artifactPath: string;
    preempterSessionShort: string;
    preemptedAtUnixTs: number;
  }>,
): string {
  if (notices.length === 0) return "";
  const lines = notices.map(
    (n) =>
      `  • ${n.artifactPath} preempted by session ${n.preempterSessionShort} at ${isoUtc(n.preemptedAtUnixTs)}`,
  );
  const intro =
    notices.length === 1
      ? "⚠ Your EXCLUSIVE grant on this artifact was silently revoked by another session:"
      : `⚠ ${notices.length} of your EXCLUSIVE grants were silently revoked by other sessions:`;
  return `${intro}\n${lines.join("\n")}`;
}

export function buildStaleResponse(summary: StaleSummary): StaleResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow", // v0.1.1 warn-only; v0.2 may flip per KTD-E
      additionalContext: staleReadWarning(summary),
    },
    status: "stale",
    summary,
  };
}

export function buildCollisionResponse(
  holderSessionId: string,
  holderAcquiredAtUnixTs: number,
  path: string,
): CollisionResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: editCollisionWarning(holderSessionId, holderAcquiredAtUnixTs, path),
    },
    ok: true,
    collision: true,
  };
}

export function buildFreshWithNotice(notice: string): FreshWithNoticeResponse {
  return {
    status: "fresh",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: notice,
    },
  };
}
