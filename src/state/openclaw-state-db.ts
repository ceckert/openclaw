// OpenClaw state database manages shared persisted state and migrations.
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  repairCanonicalSqliteUniqueIndexes,
  type CanonicalSqliteUniqueIndex,
} from "../infra/sqlite-index-schema.js";
import {
  assertSqliteIntegrity,
  assertSqliteTableIntegrity,
  isTerminalSqliteIntegrityError,
} from "../infra/sqlite-integrity.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { migrateLegacyCronRunLogsToTaskRuns } from "../infra/state-migrations.cron-run-logs.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { VERSION } from "../version.js";
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";
import { repairAuditEventsSchema } from "./openclaw-state-db-audit-migration.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
  OPENCLAW_STATE_STRICT_SCHEMA_VERSION,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import {
  assertSupportedSchemaVersion,
  createOpenClawDatabaseVerificationError,
  resolveDatabasePath,
} from "./openclaw-state-db-maintenance.js";
import * as operatorApprovalMigration from "./openclaw-state-db-operator-approval-migration.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import { ensureAdditiveStateColumns } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  assertCanonicalStateSchemaShape,
  dropLegacyStateTables,
  markCurrentStateSchemaVersion,
  repairAgentDatabasesCompositePrimaryKey,
  repairLegacyGatewayRestartHandoffsForStrictMigration,
} from "./openclaw-state-db-schema-repair.js";
import * as sessionWatchMigration from "./openclaw-state-db-session-watch-migration.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.generated.js";

export {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
};
export type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
  OpenClawStateDatabaseSchemaMigration,
} from "./openclaw-state-db-contract.js";
export {
  assertOpenClawStateDatabaseForMaintenance,
  createOpenClawDatabaseVerificationError,
} from "./openclaw-state-db-maintenance.js";
export { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
export { detectOpenClawStateDatabaseSchemaMigrations } from "./openclaw-state-db-schema-repair.js";
export { withOpenClawStateStartupMigrationCheckpointDatabase } from "./openclaw-state-db-startup-checkpoint.js";

/**
 * Shared OpenClaw SQLite state database lifecycle and metadata writers.
 *
 * This module owns schema creation, additive migrations for released state
 * tables, private file permissions, cached handles, and audit rows for
 * migrations/backups that operate on local state.
 */
const OPENCLAW_STATE_CANONICAL_UNIQUE_INDEXES = [
  {
    name: "idx_operator_approvals_resolution_ref",
    definition: "ON operator_approvals(resolution_ref)",
  },
  {
    name: "idx_worker_environments_provider_lease",
    definition: `
      ON worker_environments(provider_id, lease_id)
      WHERE lease_id IS NOT NULL
    `,
  },
] as const satisfies readonly CanonicalSqliteUniqueIndex[];

const cachedDatabases = new Map<string, OpenClawStateDatabase>();
const terminalOpenLatch = createSqliteTerminalOpenLatch({
  closeByPath: (pathname) => {
    const cached = cachedDatabases.get(pathname);
    if (!cached) {
      return;
    }
    cached.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(cached.db);
    if (cached.db.isOpen) {
      cached.db.close();
    }
    cachedDatabases.delete(pathname);
  },
});

/** Latch background verification damage so later opens fail without rescanning. */
export function recordOpenClawStateDatabaseOpenFailure(pathname: string, error: Error): void {
  terminalOpenLatch.record(pathname, error);
}

/** Clear a terminal open failure after doctor rewrites the database file. */
export function clearOpenClawStateDatabaseOpenFailure(pathname: string): void {
  terminalOpenLatch.clear(pathname);
}

type OpenClawStateMetadataDatabase = Pick<OpenClawStateKyselyDatabase, "schema_meta">;
const stateDbLog = createSubsystemLogger("state/db");

export function repairOpenClawStateDatabaseSchema(options: OpenClawStateDatabaseOptions = {}): {
  changes: string[];
  warnings: string[];
} {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }
  ensureOpenClawStatePermissions(pathname, env);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  try {
    assertSqliteIntegrity(db, pathname);
    assertSupportedSchemaVersion(db, pathname);
    db.exec("PRAGMA foreign_keys = OFF;");
    const changes = runSqliteImmediateTransactionSync(
      db,
      () => {
        const applied: string[] = [];
        const previousVersion = readSqliteUserVersion(db);
        dropLegacyStateTables(db);
        if (repairAgentDatabasesCompositePrimaryKey(db)) {
          applied.push(`Migrated shared state agent database registry primary key → agent_id,path`);
        }
        if (repairAuditEventsSchema(db)) {
          applied.push(
            `Migrated shared state audit event ledger → versioned message lifecycle schema`,
          );
        }
        applied.push(...operatorApprovalMigration.repairOperatorApprovalSchema(db));
        const needsSessionWatchMigration =
          sessionWatchMigration.needsSessionWatchCursorProvenanceMigration(db, previousVersion);
        const sessionWatchResult = sessionWatchMigration.migrateSessionWatchCursorProvenance(db);
        if (needsSessionWatchMigration) {
          applied.push(
            `Migrated shared state session watch cursors → provenance column (${sessionWatchResult.migratedAmbientWatches} ambient, ${sessionWatchResult.removedLegacySentinels} sentinels removed)`,
          );
        }
        assertCanonicalStateSchemaShape(db, pathname);
        if (tableExists(db, "audit_events")) {
          ensureAdditiveStateColumns(db);
          db.exec(OPENCLAW_STATE_SCHEMA_SQL);
          if (previousVersion < OPENCLAW_STATE_STRICT_SCHEMA_VERSION) {
            repairLegacyGatewayRestartHandoffsForStrictMigration(db);
          }
          const strictMigration = migrateSqliteSchemaToStrictInTransaction(
            db,
            OPENCLAW_STATE_SCHEMA_SQL,
            { databaseLabel: pathname },
          );
          if (strictMigration.migratedTables.length > 0) {
            applied.push(
              `Migrated shared state tables to SQLite STRICT typing (${strictMigration.migratedTables.length})`,
            );
          }
        }
        markCurrentStateSchemaVersion(db);
        return applied;
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: pathname,
        operationLabel: "state.schema.repair",
      },
    );
    const quarantineCleared = clearOpenClawDatabaseQuarantine(pathname, { env });
    clearOpenClawStateDatabaseOpenFailure(pathname);
    return {
      changes,
      warnings: quarantineCleared
        ? []
        : [
            `Persisted quarantine record for ${pathname} could not be cleared; rerun openclaw doctor --fix so the repaired database is not refused again.`,
          ],
    };
  } catch (err) {
    // Reaching this catch inside doctor means repair itself refused or failed,
    // so the runtime asserts' "run openclaw doctor --fix" advice is circular here.
    const reason = String(err).replace(
      /has a legacy ([a-z ]+) schema; run openclaw doctor --fix to migrate it\./u,
      "has a legacy $1 schema; automatic repair refused the unrecognized schema shape.",
    );
    return {
      changes: [],
      warnings: [`Failed migrating shared state database schema at ${pathname}: ${reason}`],
    };
  } finally {
    if (db.isOpen) {
      db.exec("PRAGMA foreign_keys = ON;");
    }
    db.close();
    ensureOpenClawStatePermissions(pathname, env);
  }
}

function ensureStartupMigrationCheckpointSchema(db: DatabaseSync, pathname: string): void {
  runSqliteImmediateTransactionSync(
    db,
    () => {
      assertSupportedSchemaVersion(db, pathname);
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          agent_id TEXT,
          app_version TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS state_leases (
          scope TEXT NOT NULL,
          lease_key TEXT NOT NULL,
          owner TEXT NOT NULL,
          expires_at INTEGER,
          heartbeat_at INTEGER,
          payload_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, lease_key)
        );
        CREATE INDEX IF NOT EXISTS idx_state_leases_expiry
          ON state_leases(expires_at, scope, lease_key)
          WHERE expires_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_state_leases_owner
          ON state_leases(owner, updated_at DESC);
      `);
      ensureColumn(db, "schema_meta", "app_version TEXT");
    },
    {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      databaseLabel: pathname,
      operationLabel: "state.schema.ensure-startup-checkpoint",
    },
  );
}

export function withOpenClawStateStartupMigrationCheckpointDatabase<T>(
  callback: (db: DatabaseSync) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  ensureOpenClawStatePermissions(pathname, env);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  try {
    assertSqliteIntegrity(db, pathname);
    ensureStartupMigrationCheckpointSchema(db, pathname);
    return callback(db);
  } finally {
    db.close();
    ensureOpenClawStatePermissions(pathname, env);
  }
}

// One-time seed for the ledger footprint aggregates (#100622): estimate rows
// written before the estimated_bytes columns existed, then roll them up per
// session. Zero is a safe "not seeded" sentinel because every real row costs
// at least its 32-byte overhead.
function backfillAcpReplayEstimatedBytes(db: DatabaseSync): void {
  if (
    !tableExists(db, "acp_replay_events") ||
    !tableHasColumn(db, "acp_replay_events", "estimated_bytes")
  ) {
    return;
  }
  const pendingEvent = db
    .prepare("SELECT 1 FROM acp_replay_events WHERE estimated_bytes = 0 LIMIT 1")
    .get();
  const pendingSession = db
    .prepare("SELECT 1 FROM acp_replay_sessions WHERE estimated_bytes = 0 LIMIT 1")
    .get();
  if (!pendingEvent && !pendingSession) {
    return;
  }
  db.exec(`
    UPDATE acp_replay_events
       SET estimated_bytes = length(session_id) + length(session_key) + length(update_json)
             + COALESCE(length(run_id), 0) + 32
     WHERE estimated_bytes = 0;
    UPDATE acp_replay_sessions
       SET estimated_bytes = length(session_id) + length(session_key) + length(cwd) + 32
             + COALESCE((SELECT SUM(e.estimated_bytes) FROM acp_replay_events e
                          WHERE e.session_id = acp_replay_sessions.session_id), 0)
     WHERE estimated_bytes = 0;
  `);
}

function backfillCronRunLogEntryJson(db: DatabaseSync): void {
  if (!tableExists(db, "cron_run_logs") || !tableHasColumn(db, "cron_run_logs", "entry_json")) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT store_key, job_id, seq, ts
         FROM cron_run_logs
        WHERE entry_json = '{}'`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    seq: number | bigint;
    ts: number | bigint;
  }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE cron_run_logs
        SET entry_json = ?
      WHERE store_key = ? AND job_id = ? AND seq = ?`,
  );
  for (const row of rows) {
    update.run(
      JSON.stringify({ ts: Number(row.ts), jobId: row.job_id, action: "finished" }),
      row.store_key,
      row.job_id,
      row.seq,
    );
  }
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonField(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function cronSessionTargetField(record: Record<string, unknown>): string | null {
  const value = textField(record, "sessionTarget");
  if (!value) {
    return null;
  }
  return value === "main" ||
    value === "isolated" ||
    value === "current" ||
    value.startsWith("session:")
    ? value
    : null;
}

function cronWakeModeField(record: Record<string, unknown>): string | null {
  const value = textField(record, "wakeMode");
  return value === "now" || value === "next-heartbeat" ? value : null;
}

function booleanField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

function failureDestinationField(
  record: Record<string, unknown> | null,
  key: "accountId" | "channel" | "mode" | "to",
): string | null {
  if (!record || !Object.hasOwn(record, key)) {
    return null;
  }
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : "";
}

function migrateLegacyCronDeliveryThreadIds(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT store_key, job_id, job_json, delivery_thread_id
         FROM cron_jobs
        WHERE delivery_thread_id_type IS NULL`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    job_json: string;
    delivery_thread_id: string | null;
  }>;
  const update = db.prepare(
    `UPDATE cron_jobs
        SET delivery_thread_id = ?, delivery_thread_id_type = ?
      WHERE store_key = ? AND job_id = ? AND delivery_thread_id_type IS NULL`,
  );
  for (const row of rows) {
    const job = parseJsonRecord(row.job_json);
    const delivery = job ? recordField(job, "delivery") : null;
    const typed = delivery?.threadId;
    if (row.delivery_thread_id === null) {
      // The first normalized cron migration could not project numeric thread IDs.
      // Recover only that known lost shape while this type column is first added.
      if (typeof typed === "number" && Number.isFinite(typed)) {
        update.run(String(typed), "number", row.store_key, row.job_id);
      }
      continue;
    }
    const type =
      typeof typed === "number" &&
      Number.isFinite(typed) &&
      String(typed) === row.delivery_thread_id
        ? "number"
        : "string";
    update.run(row.delivery_thread_id, type, row.store_key, row.job_id);
  }
}

function backfillCronJobsFromJobJson(db: DatabaseSync): void {
  if (
    !tableExists(db, "cron_jobs") ||
    !tableHasColumn(db, "cron_jobs", "job_json") ||
    !tableHasColumn(db, "cron_jobs", "schedule_kind") ||
    !tableHasColumn(db, "cron_jobs", "payload_kind")
  ) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT store_key, job_id, job_json, updated_at
         FROM cron_jobs
        WHERE schedule_kind = 'manual'
           OR payload_kind = 'message'
           OR name = ''`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    job_json: string;
    updated_at: number | bigint;
  }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE cron_jobs
        SET name = ?,
            enabled = ?,
            delete_after_run = ?,
            created_at_ms = ?,
            agent_id = ?,
            session_key = ?,
            schedule_kind = ?,
            schedule_expr = ?,
            schedule_tz = ?,
            every_ms = ?,
            anchor_ms = ?,
            at = ?,
            stagger_ms = ?,
            session_target = ?,
            wake_mode = ?,
            payload_kind = ?,
            payload_message = ?,
            payload_model = ?,
            payload_fallbacks_json = ?,
            payload_thinking = ?,
            payload_timeout_seconds = ?,
            payload_allow_unsafe_external_content = ?,
            payload_external_content_source_json = ?,
            payload_light_context = ?,
            payload_tools_allow_json = ?,
            delivery_mode = ?,
            delivery_channel = ?,
            delivery_to = ?,
            delivery_thread_id = ?,
            delivery_account_id = ?,
            delivery_best_effort = ?,
            delivery_completion_mode = ?,
            delivery_completion_to = ?,
            failure_delivery_mode = ?,
            failure_delivery_channel = ?,
            failure_delivery_to = ?,
            failure_delivery_account_id = ?,
            failure_alert_disabled = ?,
            failure_alert_after = ?,
            failure_alert_channel = ?,
            failure_alert_to = ?,
            failure_alert_cooldown_ms = ?,
            failure_alert_include_skipped = ?,
            failure_alert_mode = ?,
            failure_alert_account_id = ?,
            runtime_updated_at_ms = ?
      WHERE store_key = ?
        AND job_id = ?`,
  );
  for (const row of rows) {
    const job = parseJsonRecord(row.job_json);
    if (!job) {
      continue;
    }
    // Legacy cron rows kept the contract in job_json; columns are a queryable projection of it.
    const schedule = recordField(job, "schedule");
    const payload = recordField(job, "payload");
    const scheduleKind = textField(schedule ?? {}, "kind");
    const payloadKind = textField(payload ?? {}, "kind");
    const isAt = scheduleKind === "at" && textField(schedule ?? {}, "at");
    const isEvery = scheduleKind === "every" && numberField(schedule ?? {}, "everyMs") != null;
    const isCron = scheduleKind === "cron" && textField(schedule ?? {}, "expr");
    const isSystemEvent = payloadKind === "systemEvent" && textField(payload ?? {}, "text");
    const isAgentTurn = payloadKind === "agentTurn" && textField(payload ?? {}, "message");
    if (
      !schedule ||
      !payload ||
      (!isAt && !isEvery && !isCron) ||
      (!isSystemEvent && !isAgentTurn)
    ) {
      continue;
    }
    const fallbackTime = Number(row.updated_at) || 0;
    const delivery = recordField(job, "delivery");
    const completionDestination = delivery ? recordField(delivery, "completionDestination") : null;
    const failureDestination = delivery ? recordField(delivery, "failureDestination") : null;
    const failureAlertValue = job.failureAlert;
    const failureAlert =
      failureAlertValue &&
      typeof failureAlertValue === "object" &&
      !Array.isArray(failureAlertValue)
        ? (failureAlertValue as Record<string, unknown>)
        : null;
    update.run(
      textField(job, "name") ?? row.job_id,
      job.enabled === false ? 0 : 1,
      booleanField(job, "deleteAfterRun"),
      numberField(job, "createdAtMs") ?? fallbackTime,
      textField(job, "agentId"),
      textField(job, "sessionKey"),
      scheduleKind,
      isCron ? textField(schedule, "expr") : null,
      isCron ? textField(schedule, "tz") : null,
      isEvery ? numberField(schedule, "everyMs") : null,
      isEvery ? numberField(schedule, "anchorMs") : null,
      isAt ? textField(schedule, "at") : null,
      isCron ? numberField(schedule, "staggerMs") : null,
      cronSessionTargetField(job) ?? (payloadKind === "agentTurn" ? "isolated" : "main"),
      cronWakeModeField(job) ?? "now",
      payloadKind,
      isSystemEvent ? textField(payload, "text") : textField(payload, "message"),
      isAgentTurn ? textField(payload, "model") : null,
      isAgentTurn ? jsonField(payload.fallbacks) : null,
      isAgentTurn ? textField(payload, "thinking") : null,
      isAgentTurn ? numberField(payload, "timeoutSeconds") : null,
      isAgentTurn && typeof payload.allowUnsafeExternalContent === "boolean"
        ? payload.allowUnsafeExternalContent
          ? 1
          : 0
        : null,
      isAgentTurn ? jsonField(payload.externalContentSource) : null,
      isAgentTurn && typeof payload.lightContext === "boolean"
        ? payload.lightContext
          ? 1
          : 0
        : null,
      isAgentTurn ? jsonField(payload.toolsAllow) : null,
      delivery ? textField(delivery, "mode") : null,
      delivery ? textField(delivery, "channel") : null,
      delivery ? textField(delivery, "to") : null,
      delivery ? textField(delivery, "threadId") : null,
      delivery ? textField(delivery, "accountId") : null,
      delivery && typeof delivery.bestEffort === "boolean" ? (delivery.bestEffort ? 1 : 0) : null,
      completionDestination ? textField(completionDestination, "mode") : null,
      completionDestination ? textField(completionDestination, "to") : null,
      failureDestinationField(failureDestination, "mode"),
      failureDestinationField(failureDestination, "channel"),
      failureDestinationField(failureDestination, "to"),
      failureDestinationField(failureDestination, "accountId"),
      failureAlertValue === false ? 1 : failureAlert ? 0 : null,
      failureAlert ? numberField(failureAlert, "after") : null,
      failureAlert ? textField(failureAlert, "channel") : null,
      failureAlert ? textField(failureAlert, "to") : null,
      failureAlert ? numberField(failureAlert, "cooldownMs") : null,
      failureAlert && typeof failureAlert.includeSkipped === "boolean"
        ? failureAlert.includeSkipped
          ? 1
          : 0
        : null,
      failureAlert ? textField(failureAlert, "mode") : null,
      failureAlert ? textField(failureAlert, "accountId") : null,
      numberField(job, "updatedAtMs") ?? fallbackTime,
      row.store_key,
      row.job_id,
    );
  }
}

function metadataStringField(record: Record<string, unknown>, key: string): string | null {
  return textField(record, key);
}

function backfillDeliveryQueueEntriesFromEntryJson(db: DatabaseSync): void {
  if (
    !tableExists(db, "delivery_queue_entries") ||
    !tableHasColumn(db, "delivery_queue_entries", "entry_json") ||
    !tableHasColumn(db, "delivery_queue_entries", "retry_count")
  ) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT queue_name, id, entry_json
         FROM delivery_queue_entries
        WHERE status <> 'completed'
          AND (retry_count = 0
            OR last_attempt_at IS NULL
            OR last_error IS NULL
            OR recovery_state IS NULL
            OR platform_send_started_at IS NULL
            OR entry_kind IS NULL
            OR session_key IS NULL
            OR channel IS NULL
            OR target IS NULL
            OR account_id IS NULL)`,
    )
    .all() as Array<{ queue_name: string; id: string; entry_json: string }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE delivery_queue_entries
        SET entry_kind = COALESCE(?, entry_kind),
            session_key = COALESCE(?, session_key),
            channel = COALESCE(?, channel),
            target = COALESCE(?, target),
            account_id = COALESCE(?, account_id),
            retry_count = ?,
            last_attempt_at = COALESCE(?, last_attempt_at),
            last_error = COALESCE(?, last_error),
            recovery_state = COALESCE(?, recovery_state),
            platform_send_started_at = COALESCE(?, platform_send_started_at)
      WHERE queue_name = ?
        AND id = ?`,
  );
  for (const row of rows) {
    const entry = parseJsonRecord(row.entry_json);
    if (!entry) {
      continue;
    }
    // Queue metadata is denormalized for recovery queries but entry_json remains source of truth.
    const session = recordField(entry, "session");
    const route = recordField(entry, "route");
    const deliveryContext = recordField(entry, "deliveryContext");
    update.run(
      metadataStringField(entry, "kind"),
      metadataStringField(entry, "sessionKey") ??
        (session ? metadataStringField(session, "key") : null),
      metadataStringField(entry, "channel") ??
        (route ? metadataStringField(route, "channel") : null) ??
        (deliveryContext ? metadataStringField(deliveryContext, "channel") : null),
      metadataStringField(entry, "to") ??
        (route ? metadataStringField(route, "to") : null) ??
        (deliveryContext ? metadataStringField(deliveryContext, "to") : null),
      metadataStringField(entry, "accountId") ??
        (route ? metadataStringField(route, "accountId") : null) ??
        (deliveryContext ? metadataStringField(deliveryContext, "accountId") : null),
      numberField(entry, "retryCount") ?? 0,
      numberField(entry, "lastAttemptAt"),
      metadataStringField(entry, "lastError"),
      metadataStringField(entry, "recoveryState"),
      numberField(entry, "platformSendStartedAt"),
      row.queue_name,
      row.id,
    );
  }
}

// The caller owns the state.schema.ensure transaction so every probe, DDL
// change, and backfill observes one authoritative schema across processes.
function ensureAdditiveStateColumns(db: DatabaseSync): void {
  ensureColumn(db, "worktrees", "provisioned_paths_json TEXT");
  ensureColumn(db, "node_host_config", "gateway_context_path TEXT");
  ensureColumn(db, "node_host_config", "installed_apps_sharing INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "apns_registrations", "relay_origin TEXT");
  ensureColumn(db, "device_pairing_pending", "refreshed_at_ms INTEGER");
  ensureColumn(db, "device_pairing_pending", "browser_origin TEXT");
  ensureColumn(db, "device_pairing_paired", "approved_via TEXT");
  ensureColumn(db, "device_pairing_paired", "browser_origin TEXT");
  ensureColumn(db, "device_pairing_paired", "operator_label TEXT");
  ensureColumn(db, "device_pairing_paired", "node_surface_json TEXT");
  ensureColumn(db, "device_pairing_paired", "pending_node_surface_json TEXT");
  ensureColumn(db, "cron_run_logs", "status TEXT");
  ensureColumn(db, "cron_run_logs", "error TEXT");
  ensureColumn(db, "cron_run_logs", "summary TEXT");
  ensureColumn(db, "cron_run_logs", "diagnostics_summary TEXT");
  ensureColumn(db, "cron_run_logs", "delivery_status TEXT");
  ensureColumn(db, "cron_run_logs", "delivery_error TEXT");
  ensureColumn(db, "cron_run_logs", "delivered INTEGER");
  ensureColumn(db, "cron_run_logs", "session_id TEXT");
  ensureColumn(db, "cron_run_logs", "session_key TEXT");
  ensureColumn(db, "cron_run_logs", "run_id TEXT");
  ensureColumn(db, "cron_run_logs", "run_at_ms INTEGER");
  ensureColumn(db, "cron_run_logs", "duration_ms INTEGER");
  ensureColumn(db, "cron_run_logs", "next_run_at_ms INTEGER");
  ensureColumn(db, "cron_run_logs", "model TEXT");
  ensureColumn(db, "cron_run_logs", "provider TEXT");
  ensureColumn(db, "cron_run_logs", "total_tokens INTEGER");
  ensureColumn(db, "cron_run_logs", "entry_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "cron_run_logs", "created_at INTEGER NOT NULL DEFAULT 0");
  backfillCronRunLogEntryJson(db);
  ensureColumn(db, "acp_replay_events", "estimated_bytes INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "acp_replay_sessions", "estimated_bytes INTEGER NOT NULL DEFAULT 0");
  backfillAcpReplayEstimatedBytes(db);
  ensureColumn(db, "cron_jobs", "description TEXT");
  ensureColumn(db, "cron_jobs", "declaration_key TEXT");
  ensureColumn(db, "cron_jobs", "display_name TEXT");
  ensureColumn(db, "cron_jobs", "owner_agent_id TEXT");
  ensureColumn(db, "cron_jobs", "owner_session_key TEXT");
  ensureColumn(db, "cron_jobs", "name TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "cron_jobs", "enabled INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "cron_jobs", "delete_after_run INTEGER");
  ensureColumn(db, "cron_jobs", "created_at_ms INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "cron_jobs", "agent_id TEXT");
  ensureColumn(db, "cron_jobs", "session_key TEXT");
  ensureColumn(db, "cron_jobs", "schedule_kind TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(db, "cron_jobs", "schedule_expr TEXT");
  ensureColumn(db, "cron_jobs", "schedule_tz TEXT");
  ensureColumn(db, "cron_jobs", "every_ms INTEGER");
  ensureColumn(db, "cron_jobs", "anchor_ms INTEGER");
  ensureColumn(db, "cron_jobs", "at TEXT");
  ensureColumn(db, "cron_jobs", "stagger_ms INTEGER");
  ensureColumn(db, "cron_jobs", "session_target TEXT NOT NULL DEFAULT 'main'");
  ensureColumn(db, "cron_jobs", "wake_mode TEXT NOT NULL DEFAULT 'auto'");
  ensureColumn(db, "cron_jobs", "trigger_script TEXT");
  ensureColumn(db, "cron_jobs", "trigger_once INTEGER");
  ensureColumn(db, "cron_jobs", "payload_kind TEXT NOT NULL DEFAULT 'message'");
  ensureColumn(db, "cron_jobs", "payload_message TEXT");
  ensureColumn(db, "cron_jobs", "payload_model TEXT");
  ensureColumn(db, "cron_jobs", "payload_fallbacks_json TEXT");
  ensureColumn(db, "cron_jobs", "payload_thinking TEXT");
  ensureColumn(db, "cron_jobs", "payload_timeout_seconds INTEGER");
  ensureColumn(db, "cron_jobs", "payload_allow_unsafe_external_content INTEGER");
  ensureColumn(db, "cron_jobs", "payload_external_content_source_json TEXT");
  ensureColumn(db, "cron_jobs", "payload_light_context INTEGER");
  ensureColumn(db, "cron_jobs", "payload_tools_allow_json TEXT");
  ensureColumn(db, "cron_jobs", "payload_tools_allow_is_default INTEGER");
  ensureColumn(db, "cron_jobs", "delivery_mode TEXT");
  ensureColumn(db, "cron_jobs", "delivery_channel TEXT");
  ensureColumn(db, "cron_jobs", "delivery_to TEXT");
  ensureColumn(db, "cron_jobs", "delivery_thread_id TEXT");
  ensureColumn(db, "cron_jobs", "delivery_account_id TEXT");
  ensureColumn(db, "cron_jobs", "delivery_best_effort INTEGER");
  ensureColumn(db, "cron_jobs", "delivery_completion_mode TEXT");
  ensureColumn(db, "cron_jobs", "delivery_completion_to TEXT");
  ensureColumn(db, "cron_jobs", "failure_delivery_mode TEXT");
  ensureColumn(db, "cron_jobs", "failure_delivery_channel TEXT");
  ensureColumn(db, "cron_jobs", "failure_delivery_to TEXT");
  ensureColumn(db, "cron_jobs", "failure_delivery_account_id TEXT");
  ensureColumn(db, "cron_jobs", "failure_alert_disabled INTEGER");
  ensureColumn(db, "cron_jobs", "failure_alert_after INTEGER");
  ensureColumn(db, "cron_jobs", "failure_alert_channel TEXT");
  ensureColumn(db, "cron_jobs", "failure_alert_to TEXT");
  ensureColumn(db, "cron_jobs", "failure_alert_cooldown_ms INTEGER");
  ensureColumn(db, "cron_jobs", "failure_alert_include_skipped INTEGER");
  ensureColumn(db, "cron_jobs", "failure_alert_mode TEXT");
  ensureColumn(db, "cron_jobs", "failure_alert_account_id TEXT");
  ensureColumn(db, "cron_jobs", "next_run_at_ms INTEGER");
  ensureColumn(db, "cron_jobs", "running_at_ms INTEGER");
  ensureColumn(db, "cron_jobs", "last_run_at_ms INTEGER");
  ensureColumn(db, "cron_jobs", "last_run_status TEXT");
  ensureColumn(db, "cron_jobs", "last_error TEXT");
  ensureColumn(db, "cron_jobs", "last_duration_ms INTEGER");
  ensureColumn(db, "cron_jobs", "consecutive_errors INTEGER");
  ensureColumn(db, "cron_jobs", "consecutive_skipped INTEGER");
  ensureColumn(db, "cron_jobs", "schedule_error_count INTEGER");
  ensureColumn(db, "cron_jobs", "last_delivery_status TEXT");
  ensureColumn(db, "cron_jobs", "last_delivery_error TEXT");
  ensureColumn(db, "cron_jobs", "last_delivered INTEGER");
  ensureColumn(db, "cron_jobs", "last_failure_alert_at_ms INTEGER");
  ensureColumn(db, "cron_jobs", "state_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "cron_jobs", "runtime_updated_at_ms INTEGER");
  ensureColumn(db, "cron_jobs", "schedule_identity TEXT");
  ensureColumn(db, "cron_jobs", "sort_order INTEGER NOT NULL DEFAULT 0");
  backfillCronJobsFromJobJson(db);
  const addedDeliveryThreadIdType = ensureColumn(db, "cron_jobs", "delivery_thread_id_type TEXT");
  if (addedDeliveryThreadIdType) {
    migrateLegacyCronDeliveryThreadIds(db);
  }
  ensureColumn(db, "sandbox_registry_entries", "session_key TEXT");
  ensureColumn(db, "sandbox_registry_entries", "backend_id TEXT");
  ensureColumn(db, "sandbox_registry_entries", "runtime_label TEXT");
  ensureColumn(db, "sandbox_registry_entries", "image TEXT");
  ensureColumn(db, "sandbox_registry_entries", "created_at_ms INTEGER");
  ensureColumn(db, "sandbox_registry_entries", "last_used_at_ms INTEGER");
  ensureColumn(db, "sandbox_registry_entries", "config_label_kind TEXT");
  ensureColumn(db, "sandbox_registry_entries", "config_hash TEXT");
  ensureColumn(db, "sandbox_registry_entries", "cdp_port INTEGER");
  ensureColumn(db, "sandbox_registry_entries", "no_vnc_port INTEGER");
  ensureColumn(db, "delivery_queue_entries", "entry_kind TEXT");
  ensureColumn(db, "delivery_queue_entries", "session_key TEXT");
  ensureColumn(db, "delivery_queue_entries", "channel TEXT");
  ensureColumn(db, "delivery_queue_entries", "target TEXT");
  ensureColumn(db, "delivery_queue_entries", "account_id TEXT");
  ensureColumn(db, "delivery_queue_entries", "retry_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "delivery_queue_entries", "last_attempt_at INTEGER");
  ensureColumn(db, "delivery_queue_entries", "last_error TEXT");
  ensureColumn(db, "delivery_queue_entries", "recovery_state TEXT");
  ensureColumn(db, "delivery_queue_entries", "platform_send_started_at INTEGER");
  backfillDeliveryQueueEntriesFromEntryJson(db);
  ensureColumn(db, "commitments", "account_id TEXT");
  ensureColumn(db, "commitments", "recipient_id TEXT");
  ensureColumn(db, "commitments", "thread_id TEXT");
  ensureColumn(db, "commitments", "sender_id TEXT");
  ensureColumn(db, "commitments", "kind TEXT NOT NULL DEFAULT 'followup'");
  ensureColumn(db, "commitments", "sensitivity TEXT NOT NULL DEFAULT 'normal'");
  ensureColumn(db, "commitments", "source TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(db, "commitments", "reason TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "commitments", "suggested_text TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "commitments", "dedupe_key TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "commitments", "confidence REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "commitments", "due_timezone TEXT NOT NULL DEFAULT 'UTC'");
  ensureColumn(db, "commitments", "source_message_id TEXT");
  ensureColumn(db, "commitments", "source_run_id TEXT");
  ensureColumn(db, "commitments", "created_at_ms INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "commitments", "attempts INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "commitments", "last_attempt_at_ms INTEGER");
  ensureColumn(db, "commitments", "sent_at_ms INTEGER");
  ensureColumn(db, "commitments", "dismissed_at_ms INTEGER");
  ensureColumn(db, "commitments", "snoozed_until_ms INTEGER");
  ensureColumn(db, "commitments", "expired_at_ms INTEGER");
  // The shipped JSON runtime predeclared this table but never populated it.
  // Add required typed columns before Doctor or runtime can insert canonical rows.
  ensureColumn(db, "managed_outgoing_image_records", "original_media_root TEXT NOT NULL");
  ensureColumn(db, "managed_outgoing_image_records", "agent_id TEXT");
  ensureColumn(
    db,
    "managed_outgoing_image_records",
    "cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0, 1))",
  );
  ensureColumn(db, "current_conversation_bindings", "target_agent_id TEXT NOT NULL DEFAULT 'main'");
  ensureColumn(db, "current_conversation_bindings", "target_session_id TEXT");
  ensureColumn(
    db,
    "current_conversation_bindings",
    "conversation_kind TEXT NOT NULL DEFAULT 'channel'",
  );
  ensureColumn(db, "device_bootstrap_tokens", "pending_profile_json TEXT");
  ensureColumn(db, "gateway_restart_handoff", "restart_trace_started_at INTEGER");
  ensureColumn(db, "gateway_restart_handoff", "restart_trace_last_at INTEGER");
  ensureColumn(db, "gateway_restart_intent", "reason TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "delivery_channel TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "delivery_to TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "delivery_account_id TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "message TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "continuation_json TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "doctor_hint TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "stats_json TEXT");
  ensureColumn(db, "gateway_boot_lifecycle", "startup_reason TEXT");
  ensureColumn(db, "official_external_plugin_catalog_snapshots", "trust_mode TEXT");
  ensureColumn(db, "official_external_plugin_catalog_snapshots", "trust_key_id TEXT");
  ensureColumn(db, "official_external_plugin_catalog_snapshots", "trust_signature_count INTEGER");
  ensureColumn(db, "official_external_plugin_catalog_snapshots", "trust_threshold INTEGER");
  ensureColumn(db, "official_external_plugin_catalog_snapshots", "trust_verified_at TEXT");
  const addedTaskRequesterAgentId = ensureColumn(db, "task_runs", "requester_agent_id TEXT");
  if (addedTaskRequesterAgentId) {
    repairLegacyTaskAgentAttribution(db);
  }
  repairLegacyTaskDeliveryStatuses(db);
  ensureColumn(db, "task_runs", "tool_use_count INTEGER");
  ensureColumn(db, "task_runs", "last_tool_name TEXT");
  ensureColumn(db, "task_runs", "detail_json TEXT");
  ensureColumn(db, "subagent_runs", "task_name TEXT");
  ensureColumn(db, "subagent_runs", "requester_settle_wake_status TEXT");
  ensureColumn(db, "subagent_runs", "requester_settle_wake_attempt_count INTEGER");
  ensureColumn(db, "subagent_runs", "requester_settle_wake_replay_count INTEGER");
  ensureColumn(db, "subagent_runs", "requester_settle_wake_next_attempt_at INTEGER");
  ensureColumn(db, "subagent_runs", "requester_settle_wake_batch_run_ids_json TEXT");
  ensureColumn(db, "subagent_runs", "requester_settle_wake_last_error TEXT");
  ensureColumn(db, "subagent_runs", "requester_settle_wake_retire_after INTEGER");
  ensureColumn(db, "worker_environments", "bootstrap_bundle_hash TEXT");
  ensureColumn(db, "worker_environments", "bootstrap_openclaw_version TEXT");
  ensureColumn(db, "worker_environments", "bootstrap_protocol_features_json TEXT");
  ensureColumn(
    db,
    "worker_environments",
    "owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0)",
  );
  ensureColumn(db, "worker_environments", "ssh_host_key TEXT");
  ensureColumn(
    db,
    "worker_environments",
    "teardown_terminal_state TEXT CHECK (teardown_terminal_state IN ('destroyed', 'failed'))",
  );
  ensureOperatorApprovalResolutionRefs(db);
  ensureColumn(db, "channel_ingress_events", "revision INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "channel_ingress_events", "canceled_at INTEGER");
  ensureColumn(db, "channel_ingress_events", "canceled_metadata_json TEXT");
}

function ensureSchema(db: DatabaseSync, pathname: string): void {
  const now = Date.now();
  const kysely = getNodeSqliteKysely<OpenClawStateMetadataDatabase>(db);
  // Rebuilding referenced tables requires disabling FK enforcement before BEGIN.
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runSqliteImmediateTransactionSync(
      db,
      () => {
        assertSupportedSchemaVersion(db, pathname);
        const previousVersion = readSqliteUserVersion(db);
        dropLegacyStateTables(db);
        ensureAdditiveStateColumns(db);
        sessionWatchMigration.migrateSessionWatchCursorProvenance(db);
        assertCanonicalStateSchemaShape(db, pathname);
        db.exec(OPENCLAW_STATE_SCHEMA_SQL);
        migrateLegacyCronRunLogsToTaskRuns(db);
        if (previousVersion < OPENCLAW_STATE_STRICT_SCHEMA_VERSION) {
          repairLegacyGatewayRestartHandoffsForStrictMigration(db);
          migrateSqliteSchemaToStrictInTransaction(db, OPENCLAW_STATE_SCHEMA_SQL, {
            databaseLabel: pathname,
          });
        }
        repairCanonicalSqliteUniqueIndexes(db, pathname, OPENCLAW_STATE_CANONICAL_UNIQUE_INDEXES);
        db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
        executeSqliteQuerySync(
          db,
          kysely
            .insertInto("schema_meta")
            .values({
              meta_key: "primary",
              role: "global",
              schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
              agent_id: null,
              app_version: VERSION,
              created_at: now,
              updated_at: now,
            })
            .onConflict((conflict) =>
              conflict.column("meta_key").doUpdateSet({
                role: "global",
                schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
                agent_id: null,
                app_version: VERSION,
                updated_at: now,
              }),
            ),
        );
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: pathname,
        operationLabel: "state.schema.ensure",
      },
    );
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/** Open existing shared state without creating, migrating, chmodding, or configuring it. */
export function openExistingOpenClawStateDatabaseReadOnly(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabase | undefined {
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return undefined;
  }
  const sqlite = requireNodeSqlite();
  const hasWalSidecars = existsSync(`${pathname}-wal`) || existsSync(`${pathname}-shm`);
  const uri = `${pathToFileURL(pathname).href}?mode=ro&immutable=1`;
  const db = new sqlite.DatabaseSync(hasWalSidecars ? pathname : uri, { readOnly: true });
  try {
    assertSupportedSchemaVersion(db, pathname);
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    db,
    path: pathname,
    walMaintenance: {
      checkpoint: () => false,
      close: () => {
        if (!db.isOpen) {
          return false;
        }
        db.close();
        return true;
      },
    },
  };
}
function assertStateDatabaseIntegrityBeforeMutation(
  database: DatabaseSync,
  pathname: string,
): void {
  database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  const userVersion = readSqliteUserVersion(database);
  const hasApplicationSchema = database
    .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  if (
    (userVersion === 0 && hasApplicationSchema) ||
    (userVersion > 0 && userVersion < OPENCLAW_STATE_SCHEMA_VERSION)
  ) {
    // Migration rewrites the schema; prove the whole file before that mutation.
    // Only a truly empty v0 file may skip; legacy v0 files need the same proof.
    stateDbLog.info("state database schema migration pending; verifying integrity first", {
      fromVersion: userVersion,
      path: pathname,
      toVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    assertSqliteIntegrity(database, pathname);
    return;
  }
  if (tableExists(database, "schema_meta")) {
    assertSqliteTableIntegrity(database, pathname, "schema_meta");
  }
}

/** Open or return a cached shared state database after schema and migration checks. */

export function openOpenClawStateDatabase(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabase {
  if (options.database) {
    return options.database;
  }
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  // Latched paths are quarantined: the recorder closed any live handle, and
  // every open fails fast here until doctor repairs the file and clears it.
  const terminalFailure = terminalOpenLatch.get(pathname);
  if (terminalFailure) {
    throw terminalFailure;
  }
  const cached = cachedDatabases.get(pathname);
  if (cached?.db.isOpen) {
    return cached;
  }
  if (cached) {
    // A closed handle can leave Kysely and WAL helpers cached; clear both before reopening.
    cached.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(cached.db);
    cachedDatabases.delete(pathname);
  }
  let quarantineFailure: Error | undefined;
  try {
    const quarantine = readOpenClawDatabaseQuarantine(pathname, { env });
    if (quarantine) {
      quarantineFailure = createOpenClawDatabaseVerificationError(
        "state",
        pathname,
        quarantine.reason,
      );
    }
  } catch {
    // A broken quarantine store must not brick every state open.
    // The process latch and daily verifier still cover known damage.
  }
  if (quarantineFailure) {
    throw quarantineFailure;
  }
  ensureOpenClawStatePermissions(pathname, env);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  const walMaintenance = (() => {
    let maintenance: SqliteWalMaintenance | undefined;
    try {
      db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
      assertSupportedSchemaVersion(db, pathname);
      assertStateDatabaseIntegrityBeforeMutation(db, pathname);
      configureSqlitePreSchemaPragmas(db, {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      });
      maintenance = configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "openclaw-state",
        databasePath: pathname,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
      ensureSchema(db, pathname);
      return maintenance;
    } catch (err) {
      maintenance?.close();
      db.close();
      if (
        err instanceof Error &&
        (err.name === "SqliteSchemaVersionError" || isTerminalSqliteIntegrityError(err))
      ) {
        recordOpenClawStateDatabaseOpenFailure(pathname, err);
      }
      throw err;
    }
  })();
  ensureOpenClawStatePermissions(pathname, env);
  const database = { db, path: pathname, walMaintenance };
  cachedDatabases.set(pathname, database);
  terminalOpenLatch.clear(pathname);
  return database;
}

/** Run a synchronous immediate transaction against the shared state database. */
export function runOpenClawStateWriteTransaction<T>(
  operation: (database: OpenClawStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
  transactionOptions: Pick<
    SqliteTransactionOptions,
    "busyTimeoutMs" | "operationLabel" | "slowTransactionHoldMs"
  > = {},
): T {
  const database = openOpenClawStateDatabase(options);
  const result = runSqliteImmediateTransactionSync(database.db, () => operation(database), {
    busyTimeoutMs: transactionOptions.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    databaseLabel: database.path,
    ...transactionOptions,
    operationLabel: transactionOptions.operationLabel ?? "state.write",
  });
  try {
    ensureOpenClawStatePermissions(database.path, options.env ?? process.env);
  } catch {
    // The write already committed; permission hardening is best-effort here so
    // callers never retry an operation that is durable in SQLite.
  }
  return result;
}

/** Close all cached shared state database handles. */
export function closeOpenClawStateDatabase(): void {
  for (const database of cachedDatabases.values()) {
    database.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(database.db);
    if (database.db.isOpen) {
      database.db.close();
    }
  }
  cachedDatabases.clear();
}

/** Test whether any cached shared state database handle is still open. */
export function isOpenClawStateDatabaseOpen(): boolean {
  return Array.from(cachedDatabases.values()).some((database) => database.db.isOpen);
}

/** Close shared state handles and clear terminal failure latches for test isolation. */
export function closeOpenClawStateDatabaseForTest(): void {
  closeOpenClawStateDatabase();
  terminalOpenLatch.clearAll();
}
