/**
 * POST /hooks/pre-read handler.
 *
 * Mirrors Python `_handle_pre_read` at
 * `src/ccs/adapters/claude_code/coordinator_server.py:402` — stale-read
 * check + KTD-9 first-observation seeding + pending-notice surfacing.
 *
 * Wire-shape parity with Python per KTD-B:
 * - Request body: `{session_id, path, content_hash?}` (snake_case, KTD-B.3 C3)
 * - Response shapes:
 *   - Fresh: `{status: "fresh"}`
 *   - Fresh with pending notice: `{status: "fresh", hookSpecificOutput: {...}}`
 *   - Stale: `{hookSpecificOutput: {...}, status: "stale", summary: {...}}`
 *   - 400: `{error: "<lowercase phrase>"}` per KTD-B.3 C1
 *
 * H4 mitigation (KTD-N): this handler matches the `Read` tool. Unit 4
 * lands the `Bash` + `Grep` hook coverage that catches `bash cat plan.md`
 * routing.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MESIState } from "../states.js";
import {
  buildStaleResponse,
  buildFreshWithNotice,
  nowUnix,
  preemptionNoticeText,
  type StaleSummary,
} from "../hook_payloads.js";
import {
  type HookDeps,
  writeJson,
  writeError,
  readJsonBody,
  isValidSessionId,
  isValidPath,
  isValidContentHashOrAbsent,
} from "./_common.js";

export type PreReadDeps = HookDeps;

interface PreReadBody {
  session_id?: unknown;
  path?: unknown;
  content_hash?: unknown;
}

export async function handlePreRead(
  body: PreReadBody,
  res: ServerResponse,
  deps: PreReadDeps,
): Promise<void> {
  // Validation. Mirror Python error envelope: lowercase, no trailing punctuation.
  if (!isValidSessionId(body.session_id)) {
    writeError(res, 400, "missing session_id");
    return;
  }
  if (!isValidPath(body.path)) {
    writeError(res, 400, "missing or empty path");
    return;
  }
  if (!isValidContentHashOrAbsent(body.content_hash)) {
    writeError(res, 400, "content_hash must be 64-char hex if provided");
    return;
  }

  const sessionId: string = body.session_id;
  const path: string = body.path;
  const contentHash: string | null = (body.content_hash as string | null | undefined) ?? null;

  // Tracked-policy gate: untracked paths fast-path to {fresh} without
  // touching SQLite (R8 false-positive budget protection).
  if (!deps.policy.isTracked(path)) {
    writeJson(res, 200, { status: "fresh" });
    return;
  }

  const agentId = deps.sessions.registerSession(sessionId);
  const nowTick = Math.floor(Date.now() / 1000);

  // Lookup artifact by path. None → KTD-9 first observation.
  const existingArtifact = deps.registry.getArtifactByName(path);

  if (existingArtifact === null) {
    // First observation per KTD-9 — seed v1 with the on-disk hash if the
    // caller supplied one, else use empty string sentinel (matches Python).
    const seedHash = contentHash ?? "";
    const artifactId = deps.registry.resolveOrRegisterArtifact(path, seedHash);
    // Grant SHARED to the first reader so subsequent reads see themselves as
    // known-fresh.
    deps.registry.grantShared(artifactId, agentId, nowTick, "first_read");
    // Even on first observation, check if THIS session has pending notices
    // from prior interactions on OTHER artifacts.
    const notice = buildAdditionalNoticeText(deps, agentId);
    if (notice !== null) {
      writeJson(res, 200, buildFreshWithNotice(notice));
      return;
    }
    writeJson(res, 200, { status: "fresh" });
    return;
  }

  const artifactId = existingArtifact.id;
  const agentState = deps.registry.getAgentState(artifactId, agentId);

  if (agentState !== null && agentState !== MESIState.INVALID) {
    // Reader has a valid grant (SHARED, EXCLUSIVE, or MODIFIED) on the
    // current version. Fresh.
    const notice = buildAdditionalNoticeText(deps, agentId);
    if (notice !== null) {
      writeJson(res, 200, buildFreshWithNotice(notice));
      return;
    }
    writeJson(res, 200, { status: "fresh" });
    return;
  }

  // Stale: either first time this session sees the artifact OR they were
  // invalidated by a peer commit.
  const priorSeen =
    agentState === MESIState.INVALID
      ? existingArtifact.version > 0
        ? existingArtifact.version - 1
        : 0
      : null;

  // hash_differs: caller's current Read content vs registry's last-recorded hash.
  const hashDiffers =
    contentHash !== null &&
    existingArtifact.content_hash !== "" &&
    contentHash !== existingArtifact.content_hash;

  // Resolve last writer to session_id if known; else "<unknown>" prefix.
  const lastWriterAgentId = existingArtifact.last_writer_id;
  const lastWriterSessionId =
    lastWriterAgentId !== null ? deps.sessions.agentIdToSessionId(lastWriterAgentId) ?? "<unknown>" : "<unknown>";

  const summary: StaleSummary = {
    path,
    current_version: existingArtifact.version,
    prior_version_seen_by_session: priorSeen,
    last_writer_session_id: lastWriterSessionId,
    last_writer_at_unix_ts: existingArtifact.updated_at,
    warning_generated_at_unix_ts: nowUnix(),
    hash_differs: hashDiffers,
  };

  // Re-grant SHARED so this read doesn't re-fire stale on every call.
  deps.registry.grantShared(artifactId, agentId, nowTick, "post_stale_read");

  const resp = buildStaleResponse(summary);
  // A1: if THIS session has pending preemption notices, prepend them to the
  // additionalContext.
  const notice = buildAdditionalNoticeText(deps, agentId);
  if (notice !== null) {
    resp.hookSpecificOutput.additionalContext =
      notice + "\n\n" + resp.hookSpecificOutput.additionalContext;
  }
  writeJson(res, 200, resp);
}

/**
 * Pop pending-preemption notices for the given agent and render them as
 * additional-context prose. Returns null if no notices pending. Mirrors
 * Python `_build_preemption_text`.
 */
function buildAdditionalNoticeText(deps: PreReadDeps, agentId: string): string | null {
  const popped = deps.registry.popPendingNoticesForAgent(agentId);
  if (popped.length === 0) return null;
  // Resolve artifact name + preempter session for each notice. Best-effort
  // — if either is unknown, fall back to "<unknown>".
  const rendered = popped.map((n) => {
    const art = deps.registry.getArtifactById(n.artifactId);
    const preempterSession = deps.sessions.agentIdToSessionId(n.preempterAgentId) ?? "<unknown>";
    return {
      artifactPath: art?.name ?? "<unknown-artifact>",
      preempterSessionShort: preempterSession.slice(0, 8),
      preemptedAtUnixTs: n.preemptedAtUnixTs,
    };
  });
  return preemptionNoticeText(rendered);
}

/** Parse + dispatch helper for use from server.ts. */
export async function preReadRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PreReadDeps,
  maxBytes: number,
): Promise<void> {
  if (req.method !== "POST") {
    writeError(res, 404, "not found");
    return;
  }
  const body = await readJsonBody(req, res, maxBytes);
  if (body === null) return;
  await handlePreRead(body as PreReadBody, res, deps);
}
