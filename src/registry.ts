/**
 * SQLite artifact registry — Node port of the Python coordinator's
 * SqliteArtifactRegistry (src/ccs/coordinator/sqlite_registry.py).
 *
 * v0.1.1 Unit 1 (this commit) lands ONLY the constructor + close():
 * - Open Database at <workspace>/.coherence/state.db
 * - Set PRAGMA journal_mode = WAL (concurrent reader safety)
 * - Set PRAGMA busy_timeout = 1500ms per KTD-K REVISED ordering rule
 *   (busy_timeout is per-lock-acquisition, NOT per-transaction; multi-statement
 *   transactions accumulate budget; 2× lock-acquisitions × 1500ms = 3s ceiling
 *   stays under the 4s handler watchdog with 1s safety margin)
 * - Run pending migrations (empty list in Unit 1; Unit 2 fills)
 * - Provide close() for graceful shutdown
 *
 * NOT in this commit (Unit 2 lands):
 * - register_artifact / fetch / write / commit / invalidate methods
 * - pending_notices table operations
 * - state_log callback wiring
 * - mutation-then-log invariant enforcement (per KTD-A.5 + sqlite_registry.py
 *   "mutation-then-log" docstring)
 *
 * Per KTD-C: state.db lives in the workspace (not ${CLAUDE_PLUGIN_DATA}) because
 * it's per-workspace shared state across coordinator backends, not per-plugin
 * cache. Same path as Python coordinator — KTD-A.5 point 1 mutex + KTD-D
 * forward-compatible schema enable backend coexistence.
 */
import BetterSqlite3, { type Database } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { runPendingMigrations, SCHEMA_USER_VERSION } from "./migrations.js";

/** Per KTD-K REVISED: per-lock-acquisition retry budget, NOT per-transaction. */
export const BUSY_TIMEOUT_MS = 1500;

export interface RegistryStats {
  readonly schemaVersion: number;
  readonly migrationsApplied: number;
}

/**
 * Artifact record returned by registry queries. Mirrors Python core/types.py
 * Artifact dataclass for KTD-B wire-equality contract. `id` is UUID hex
 * (no hyphens, lowercase); `name` is parent-repo-relative path.
 */
export interface Artifact {
  /** UUID hex without hyphens — matches Python `Artifact.id.hex`. */
  readonly id: string;
  /** Parent-repo-relative path. UNIQUE in the artifacts table. */
  readonly name: string;
  /** Monotonic version. Bumps on commit (Unit 2 commit 3). */
  readonly version: number;
  /** SHA-256 hex of content at this version. */
  readonly content_hash: string;
  /** Optional token count for diagnostics; null if unknown. */
  readonly size_tokens: number | null;
  /** UUID hex of last agent to commit; null if never written. */
  readonly last_writer_id: string | null;
  /** Coordinator epoch seconds (Date.now() / 1000) of last write. */
  readonly updated_at: number;
}

/** Internal SQLite row shape. Converted to Artifact via rowToArtifact(). */
interface ArtifactRow {
  id: string;
  name: string;
  version: number;
  content_hash: string;
  size_tokens: number | null;
  last_writer_id: string | null;
  updated_at: number;
}

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    content_hash: row.content_hash,
    size_tokens: row.size_tokens,
    last_writer_id: row.last_writer_id,
    updated_at: row.updated_at,
  };
}

/**
 * UUID hex format used in `artifacts.id`: 32 hex chars, no hyphens, lowercase.
 * Matches Python's `UUID.hex` representation. randomUUID() returns the
 * hyphenated form; we strip + lowercase for storage consistency.
 */
function newArtifactId(): string {
  return randomUUID().replace(/-/g, "").toLowerCase();
}

export class ArtifactRegistry {
  private readonly db: Database;
  private readonly stats: RegistryStats;
  private closed = false;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });

    this.db = new BetterSqlite3(databasePath, { fileMustExist: false });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // foreign_keys = ON matches Python coordinator's _apply_v1_schema setup.
    this.db.pragma("foreign_keys = ON");

    const result = runPendingMigrations(this.db);
    this.stats = {
      schemaVersion: result.current,
      migrationsApplied: result.applied.length,
    };
  }

  /** Stats from constructor migration run; surfaces in /status diagnostics. */
  getStats(): RegistryStats {
    return this.stats;
  }

  // ------------------------------------------------------------------
  // Artifact registration + lookup (Unit 2 commit 2)
  // ------------------------------------------------------------------

  /**
   * KTD-9 first-observation seeding. Mirrors Python `resolve_or_register`
   * (sqlite_registry.py:818).
   *
   * Atomically: SELECT artifact by name → if found, return its id; otherwise
   * INSERT new artifact at version=1 with the given content_hash. Concurrent
   * first-Reads from two sessions on the same fresh path converge to ONE row:
   * BEGIN IMMEDIATE + UNIQUE constraint on `artifacts.name` absorbs the race;
   * the loser's INSERT raises SqliteError code SQLITE_CONSTRAINT_UNIQUE, which
   * we catch + re-fetch.
   *
   * Returns the artifact's UUID hex id (32 chars, no hyphens, lowercase).
   */
  resolveOrRegisterArtifact(name: string, contentHash: string): string {
    const select = this.db.prepare(`SELECT id FROM artifacts WHERE name = ?`);
    const insert = this.db.prepare(`
      INSERT INTO artifacts (id, name, version, content_hash, size_tokens, last_writer_id, updated_at)
      VALUES (?, ?, 1, ?, NULL, NULL, ?)
    `);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = select.get(name) as { id: string } | undefined;
      if (existing !== undefined) {
        this.db.exec("COMMIT");
        return existing.id;
      }
      const newId = newArtifactId();
      insert.run(newId, name, contentHash, Date.now() / 1000);
      this.db.exec("COMMIT");
      return newId;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      // UNIQUE-on-name race: another caller inserted between our SELECT and
      // INSERT. Re-fetch the winning row. better-sqlite3 surfaces the
      // constraint violation as SqliteError with `code === "SQLITE_CONSTRAINT_UNIQUE"`.
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        const existing = select.get(name) as { id: string } | undefined;
        if (existing !== undefined) {
          return existing.id;
        }
        // Genuine UNIQUE violation that's NOT our name race; re-throw.
      }
      throw err;
    }
  }

  /** Return artifact metadata by id, or null if unknown. */
  getArtifactById(id: string): Artifact | null {
    const row = this.db
      .prepare(`SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts WHERE id = ?`)
      .get(id) as ArtifactRow | undefined;
    return row === undefined ? null : rowToArtifact(row);
  }

  /** Return artifact metadata by name (parent-repo-relative path), or null. */
  getArtifactByName(name: string): Artifact | null {
    const row = this.db
      .prepare(`SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts WHERE name = ?`)
      .get(name) as ArtifactRow | undefined;
    return row === undefined ? null : rowToArtifact(row);
  }

  /** Cheap existence check; cheaper than getArtifactById when only presence matters. */
  hasArtifact(id: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM artifacts WHERE id = ?`).get(id);
    return row !== undefined;
  }

  /** Return all known artifact ids (UUID hex). Order is unspecified. */
  listArtifactIds(): string[] {
    const rows = this.db.prepare(`SELECT id FROM artifacts`).all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Return all known artifacts. Order is unspecified. */
  listArtifacts(): Artifact[] {
    const rows = this.db
      .prepare(`SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts`)
      .all() as ArtifactRow[];
    return rows.map(rowToArtifact);
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    // Better-sqlite3 doesn't expose a checkpoint primitive directly; WAL
    // checkpoint happens automatically on close per the binding's docs.
    this.db.close();
    this.closed = true;
  }
}

export { SCHEMA_USER_VERSION };
