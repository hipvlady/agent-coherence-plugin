/**
 * Shared HTTP body-drain + JSON-parse helper for hook endpoints.
 *
 * Per R21 + KTD-B.3 C1: body cap enforced at server.ts via Content-Length
 * pre-check; this helper enforces a second-pass cap on actually-received
 * bytes (defense-in-depth for the header-lies-about-length case).
 *
 * Error envelope: `{error: "<lowercase phrase>"}` per KTD-B.3 C1.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactRegistry } from "../registry.js";
import type { TrackedArtifactPolicy } from "../policy.js";
import type { SessionRegistry } from "../sessions.js";

export interface HookDeps {
  registry: ArtifactRegistry;
  policy: TrackedArtifactPolicy;
  sessions: SessionRegistry;
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function writeError(res: ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: message });
}

/**
 * Drain request body up to `maxBytes`, parse as JSON object. Writes 400
 * error envelope and returns null on parse failure or oversize. Caller
 * should return immediately if null is returned.
 */
export async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve());
      req.on("error", (err) => reject(err));
    });
  } catch (err) {
    if ((err as Error).message === "body too large") {
      writeError(res, 413, "request body too large");
    } else {
      writeError(res, 400, "could not read request body");
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    writeError(res, 400, "invalid json");
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    writeError(res, 400, "body must be a JSON object");
    return null;
  }
  return parsed as Record<string, unknown>;
}

// ----------------------------------------------------------------------
// Input validators — shared across hook handlers
// ----------------------------------------------------------------------

const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CONTENT_HASH_RE = /^[0-9a-fA-F]{64}$/;

export function isValidSessionId(s: unknown): s is string {
  return typeof s === "string" && SESSION_ID_RE.test(s);
}

export function isValidPath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");
}

export function isValidContentHashOrAbsent(h: unknown): h is string | undefined | null {
  if (h === undefined || h === null) return true;
  return typeof h === "string" && CONTENT_HASH_RE.test(h);
}

export function isValidContentHashRequired(h: unknown): h is string {
  return typeof h === "string" && CONTENT_HASH_RE.test(h);
}
