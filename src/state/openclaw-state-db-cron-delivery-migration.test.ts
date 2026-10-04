import { copyFileSync, renameSync } from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensureCronRunReceiptSchema } from "../cron/store/run-receipt-store.js";
import { runSqliteSchemaReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import {
  openOpenClawStateReadConnection,
  openOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function legacyReceiptDatabase() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("cron-delivery-migration-") } };
  const database = openOpenClawStateDatabase(options);
  ensureCronRunReceiptSchema(database.db);
  const databasePath = database.path;
  closeOpenClawStateDatabaseForTest();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    ALTER TABLE cron_run_receipts DROP COLUMN delivery_attempt_state;
    INSERT INTO cron_run_receipts (
      receipt_id, store_key, job_id, config_revision, agent_id, status,
      owner_pid, owner_start_time, started_at_ms
    ) VALUES ('legacy-receipt', '/fixture/cron', 'legacy-job', 'revision', 'main', 'running', 123, 1, 2);
    PRAGMA user_version = 19;
    UPDATE schema_meta SET schema_version = 19;
  `);
  legacy.close();
  // The fixture represents bytes created by a previous process, outside this load's admission.
  const replacement = `${databasePath}.legacy`;
  copyFileSync(databasePath, replacement);
  renameSync(replacement, databasePath);
  return { options, databasePath };
}

it.each(["managed transaction", "implicit snapshot"] as const)(
  "keeps a reader's %s version until the migrated catalog becomes visible",
  (kind) => {
    const { options, databasePath } = legacyReceiptDatabase();
    openOpenClawStateReadOnlyLocation(databasePath, databasePath).close();
    const reader = openOpenClawStateReadConnection(databasePath, databasePath);
    const { db } = reader.database;
    try {
      const migrateWhileReading = () => {
        expect(db.prepare("SELECT receipt_id FROM cron_run_receipts").get()).toEqual({
          receipt_id: "legacy-receipt",
        });
        const writer = openOpenClawStateDatabase(options);
        expect(readStateSchemaContentVersion(writer.db)).toBe(21);
        const observation = observeSqliteReadSql(StatementSync.prototype);
        try {
          expect(readStateSchemaContentVersion(db)).toBe(19);
          expect(observation.queries).toEqual([]);
        } finally {
          observation.restore();
        }
        expect(() => db.prepare("SELECT delivery_attempt_state FROM cron_run_receipts")).toThrow(
          /no such column/iu,
        );
      };
      if (kind === "managed transaction") {
        runSqliteDeferredTransactionSync(db, migrateWhileReading);
      } else {
        runSqliteSchemaReadSnapshotSync(db, migrateWhileReading);
      }
      const observation = observeSqliteReadSql(StatementSync.prototype);
      try {
        expect(readStateSchemaContentVersion(db)).toBe(21);
        expect(observation.queries).toEqual([]);
      } finally {
        observation.restore();
      }
      expect(db.prepare("SELECT delivery_attempt_state FROM cron_run_receipts").get()).toEqual({
        delivery_attempt_state: "unknown",
      });
    } finally {
      reader.close();
    }
  },
);

function schema20Database(layout: "overlay" | "upstream") {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("cron-layout-20-") } };
  const database = openOpenClawStateDatabase(options);
  ensureCronRunReceiptSchema(database.db);
  const databasePath = database.path;
  closeOpenClawStateDatabaseForTest();
  const previous = new DatabaseSync(databasePath);
  try {
    previous.exec(`
      INSERT INTO cron_jobs (store_key, job_id, sort_order, name, enabled, payload_kind, job_json, state_json, updated_at)
      VALUES ('fixture', 'job', 0, 'retained', 1, 'agentTurn', '{"id":"job","agentId":"alpha"}', '{"lastRunStatus":"ok"}', 1);
      INSERT INTO cron_job_scratch VALUES ('fixture', 'job', 'retained scratch', 3, 'hash', 2);
      INSERT INTO cron_run_receipts (
        receipt_id, store_key, job_id, config_revision, agent_id, status,
        owner_pid, owner_start_time, started_at_ms, finished_at_ms, delivery_attempt_state
      ) VALUES
        ('unknown', 'fixture', 'job', 'r', 'alpha', 'ok', 123, 1, 2, 3, 'unknown'),
        ('not-started', 'fixture', 'job', 'r', 'alpha', 'ok', 123, 1, 4, 5, 'not-started'),
        ('started', 'fixture', 'job', 'r', 'alpha', 'ok', 123, 1, 6, 7, 'started');
      PRAGMA user_version = 20;
      UPDATE schema_meta SET schema_version = 20;
      DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';
    `);
    if (layout === "overlay") {
      previous.exec(`
        ALTER TABLE cron_run_receipts DROP COLUMN delivery_attempt_state;
        INSERT INTO cron_migrations VALUES ('fixture', 'held', '["alpha"]', 'held', '{"jobs":[]}', 'snapshot-hash');
        INSERT INTO cron_agent_migration_fences VALUES ('fixture', 'alpha', 'held');
      `);
    } else {
      previous.exec("DROP TABLE cron_agent_migration_fences; DROP TABLE cron_migrations;");
    }
    return {
      options,
      databasePath,
      jobs: previous.prepare("SELECT * FROM cron_jobs").all(),
      scratch: previous.prepare("SELECT * FROM cron_job_scratch").all(),
    };
  } finally {
    previous.close();
  }
}

it.each([
  { layout: "overlay", entry: "runtime open" },
  { layout: "overlay", entry: "doctor repair" },
  { layout: "upstream", entry: "runtime open" },
  { layout: "upstream", entry: "doctor repair" },
] as const)(
  "upgrades populated $layout schema 20 through $entry without inventing receipt outcomes",
  async ({ layout, entry }) => {
    const { options, jobs, scratch } = schema20Database(layout);
    if (entry === "doctor repair") {
      expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
    }
    const { db } = openOpenClawStateDatabase(options);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 21 });
    expect(db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
      schema_version: 21,
    });
    expect(db.prepare("SELECT * FROM cron_jobs").all()).toEqual(jobs);
    expect(db.prepare("SELECT * FROM cron_job_scratch").all()).toEqual(scratch);
    expect(
      db
        .prepare(
          "SELECT receipt_id, delivery_attempt_state FROM cron_run_receipts ORDER BY receipt_id",
        )
        .all(),
    ).toEqual(
      ["not-started", "started", "unknown"].map((id) => ({
        receipt_id: id,
        delivery_attempt_state: layout === "overlay" ? "unknown" : id,
      })),
    );
    expect(db.prepare("SELECT * FROM cron_migrations").all()).toEqual(
      layout === "overlay"
        ? [
            {
              store_key: "fixture",
              operation_id: "held",
              agent_ids_json: '["alpha"]',
              status: "held",
              snapshot_json: '{"jobs":[]}',
              snapshot_digest: "snapshot-hash",
            },
          ]
        : [],
    );
    expect(db.prepare("SELECT * FROM cron_agent_migration_fences").all()).toEqual(
      layout === "overlay"
        ? [{ store_key: "fixture", agent_id: "alpha", operation_id: "held" }]
        : [],
    );
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    closeOpenClawStateDatabaseForTest();
    const preflight = await preflightOpenClawDatabaseSchemas({
      env: options.env,
      scope: "state",
      supportedVersions: { state: 20, agent: 24 },
    });
    expect(preflight.incompatible).toEqual([
      expect.objectContaining({ kind: "state", foundVersion: 21, supportedVersion: 20 }),
    ]);
  },
);

it.each(["runtime open", "doctor repair"] as const)(
  "%s preserves legacy receipt uncertainty and refuses a schema-19 downgrade",
  async (entry) => {
    const { options } = legacyReceiptDatabase();
    const migration = observeSqliteReadSql(StatementSync.prototype);
    let database: ReturnType<typeof openOpenClawStateDatabase>;
    try {
      if (entry === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      }
      database = openOpenClawStateDatabase(options);
      const integrityChecks = migration.queries.filter((sql) =>
        /^PRAGMA integrity_check\s*;?$/iu.test(sql),
      );
      if (entry === "runtime open") {
        expect(integrityChecks).toHaveLength(1);
      } else {
        expect(integrityChecks.length).toBeGreaterThan(0);
      }
    } finally {
      migration.restore();
    }
    const { db } = database;
    expect(
      db.prepare("SELECT receipt_id, status, delivery_attempt_state FROM cron_run_receipts").all(),
    ).toEqual([
      { receipt_id: "legacy-receipt", status: "running", delivery_attempt_state: "unknown" },
    ]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 21 });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    db.exec("UPDATE cron_run_receipts SET delivery_attempt_state = 'started'");
    closeOpenClawStateDatabaseForTest();
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(
        openOpenClawStateDatabase(options)
          .db.prepare("SELECT delivery_attempt_state FROM cron_run_receipts")
          .get(),
      ).toEqual({ delivery_attempt_state: "started" });
      expect(
        observation.queries.filter((sql) =>
          /(?:sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\bFROM\s+"?schema_meta\b|state\.schema\.contentVersion)/iu.test(
            sql,
          ),
        ),
      ).toEqual([]);
    } finally {
      observation.restore();
    }
    closeOpenClawStateDatabaseForTest();
    const preflight = await preflightOpenClawDatabaseSchemas({
      env: options.env,
      scope: "state",
      supportedVersions: { state: 19, agent: 23 },
    });
    expect(preflight.incompatible).toEqual([
      expect.objectContaining({ kind: "state", foundVersion: 21, supportedVersion: 19 }),
    ]);
  },
);

it("rolls receipt migration back with schema publication failure", () => {
  const { options, databasePath } = legacyReceiptDatabase();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TRIGGER refuse_schema_publication BEFORE UPDATE ON schema_meta
    BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;`);
  legacy.close();
  expect(() => openOpenClawStateDatabase(options)).toThrow("fixture publication refusal");
  const after = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 19 });
    expect(after.prepare("SELECT receipt_id, status FROM cron_run_receipts").all()).toEqual([
      { receipt_id: "legacy-receipt", status: "running" },
    ]);
    expect(
      after
        .prepare(
          "SELECT 1 FROM pragma_table_info('cron_run_receipts') WHERE name = 'delivery_attempt_state'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    after.close();
  }
});
