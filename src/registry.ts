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
import { runPendingMigrations, SCHEMA_USER_VERSION } from "./migrations.js";

/** Per KTD-K REVISED: per-lock-acquisition retry budget, NOT per-transaction. */
export const BUSY_TIMEOUT_MS = 1500;

export interface RegistryStats {
  readonly schemaVersion: number;
  readonly migrationsApplied: number;
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

  /**
   * Direct connection access. v0.1.1 Unit 1 exposes this only because no
   * MESI methods exist yet; Unit 2 wraps everything in domain methods and
   * makes the connection private.
   */
  getConnectionForUnitOneSmoke(): Database {
    return this.db;
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
