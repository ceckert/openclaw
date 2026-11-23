import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensureCronRunReceiptSchema } from "../cron/store/run-receipt-store.js";
import { resolveClientCredentialStorePath } from "../infra/client-credential-paths.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteSchemaReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { requireNativeSqliteDatabase as nativeDatabase } from "../test-utils/native-sqlite.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION as SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { expectRow, expectRows } from "./openclaw-state-db-fixtures.test-support.js";
import { openOpenClawStateReadOnlyLocation } from "./openclaw-state-db-read-connection.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  installLegacyCronMigrationFixture,
  rewindStateFixtureToV20,
} from "./openclaw-state-db-schema-v21.test-support.js";
import { readStateSchemaContentVersion as readVersion } from "./openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseForTest as closeState,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase as openState,
  repairOpenClawStateDatabaseSchema as repairSchema,
} from "./openclaw-state-db.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  restorePreTemplateStateIdentifiersForTest,
  withStateMigrationBackupForTest,
} from "./openclaw-state-schema.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
});

function observeReads<T>(run: (queries: string[]) => T): T {
  const reads = observeSqliteReadSql(StatementSync.prototype);
  try {
    return run(reads.queries);
  } finally {
    reads.restore();
  }
}

function expectReceipt(db: EngineConnection, expected: Record<string, string>) {
  expectRows(db, `SELECT ${Object.keys(expected).join(", ")} FROM cron_run_receipts`, [expected]);
}

async function legacyReceiptDatabase() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("cron-delivery-migration-") } };
  const database = openState(options);
  ensureCronRunReceiptSchema(database.db);
  const databasePath = database.path;
  await closeOpenClawStateDatabaseAsync();
  const legacy = new DatabaseSync(databasePath);
  restorePreTemplateStateIdentifiersForTest(legacy);
  addPreCutoverClientCredentialTablesForTest(legacy);
  legacy.exec(`
    ALTER TABLE cron_run_receipts DROP COLUMN delivery_attempt_state;
    INSERT INTO cron_run_receipts (
      cursor_id, receipt_id, store_key, job_id, config_revision, agent_id, status,
      owner_pid, owner_start_time, started_at_ms
    ) VALUES (1, 'legacy-receipt', '/fixture/cron', 'legacy-job', 'revision', 'main', 'running', 123, 1, 2);
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
  async (kind) => {
    const { options, databasePath } = await legacyReceiptDatabase();
    await withStateMigrationBackupForTest(options, () => {
      const reader = openOpenClawStateReadOnlyLocation(databasePath, databasePath);
      const { db } = reader.database;
      try {
        const migrateWhileReading = () => {
          expectRow(db, "SELECT receipt_id FROM cron_run_receipts", {
            receipt_id: "legacy-receipt",
          });
          expect(readVersion(db)).toBe(19);
          const writer = openState(options);
          expect(readVersion(writer.db)).toBe(SCHEMA_VERSION);
          observeReads((queries) => {
            expect(readVersion(db)).toBe(19);
            // Managed reads qualify the retained catalog once after sibling DDL.
            const qualificationQueries =
              kind === "managed transaction"
                ? [
                    "PRAGMA schema_version",
                    "PRAGMA user_version",
                    "SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE type IN ('table', 'view', 'index', 'trigger')",
                    'select "value_json" from "config_machine_state" where "state_key" = ?',
                  ]
                : [];
            expect(queries).toEqual(qualificationQueries);
            expect(readVersion(db)).toBe(19);
            expect(queries).toEqual(qualificationQueries);
          });
          expect(() => db.prepare("SELECT delivery_attempt_state FROM cron_run_receipts")).toThrow(
            /no such column/iu,
          );
        };
        if (kind === "managed transaction") {
          runSqliteDeferredTransactionSync(db, migrateWhileReading);
        } else {
          runSqliteSchemaReadSnapshotSync(nativeDatabase(db), migrateWhileReading);
        }
        observeReads((queries) => {
          expect(readVersion(db)).toBe(SCHEMA_VERSION);
          expect(queries).toEqual([]);
        });
        expectReceipt(db, { delivery_attempt_state: "unknown" });
      } finally {
        reader.close();
      }
    });
  },
);

async function schema20Database(layout: "overlay" | "upstream") {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("cron-layout-20-") } };
  const database = openState(options);
  ensureCronRunReceiptSchema(database.db);
  const databasePath = database.path;
  await closeOpenClawStateDatabaseAsync();
  const previous = new DatabaseSync(databasePath);
  try {
    rewindStateFixtureToV20(previous);
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
      previous.exec("ALTER TABLE cron_run_receipts DROP COLUMN delivery_attempt_state");
      installLegacyCronMigrationFixture(
        previous,
        [
          {
            store_key: "fixture",
            operation_id: "held",
            agent_ids_json: '["alpha"]',
            status: "held",
            snapshot_json: '{"jobs":[]}',
            snapshot_digest: "snapshot-hash",
          },
        ],
        [{ store_key: "fixture", agent_id: "alpha", operation_id: "held" }],
      );
    }
    return {
      options,
      databasePath,
      jobs: previous.prepare("SELECT * FROM cron_jobs").all(),
      scratch: previous.prepare("SELECT * FROM cron_job_scratch").all(),
    };
  } finally {
    previous.close();
    const replacement = `${databasePath}.legacy`;
    copyFileSync(databasePath, replacement);
    renameSync(replacement, databasePath);
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
    const { options, jobs, scratch } = await schema20Database(layout);
    if (layout === "overlay" && entry === "runtime open") {
      expect(() => openState(options)).toThrow(/cron custody.*doctor --fix/);
      await closeOpenClawStateDatabaseAsync();
    }
    await withStateMigrationBackupForTest(options, () => {
      if (entry === "doctor repair" || layout === "overlay") {
        expect(repairSchema(options).warnings).toEqual([]);
      }
      openState(options);
    });
    const { db } = openState(options);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: SCHEMA_VERSION,
    });
    expect(db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
      schema_version: SCHEMA_VERSION,
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
    expect(tableExists(db, "cron_migrations")).toBe(layout === "overlay");
    expect(tableExists(db, "cron_agent_migration_fences")).toBe(layout === "overlay");
    expect(
      tableExists(db, "cron_migrations") ? db.prepare("SELECT * FROM cron_migrations").all() : [],
    ).toEqual(
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
    expect(
      tableExists(db, "cron_agent_migration_fences")
        ? db.prepare("SELECT * FROM cron_agent_migration_fences").all()
        : [],
    ).toEqual(
      layout === "overlay"
        ? [{ store_key: "fixture", agent_id: "alpha", operation_id: "held" }]
        : [],
    );
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    closeState();
    const preflight = await preflightOpenClawDatabaseSchemas({
      env: options.env,
      scope: "state",
      supportedVersions: { state: 20, agent: 24 },
    });
    expect(preflight.incompatible).toEqual([
      expect.objectContaining({
        kind: "state",
        foundVersion: SCHEMA_VERSION,
        supportedVersion: 20,
      }),
    ]);
  },
);

it.each(["runtime open", "doctor repair"] as const)(
  "captured %s preserves legacy receipt uncertainty and refuses a schema-19 downgrade",
  async (entry) => {
    const { options, databasePath } = await legacyReceiptDatabase();
    const queries: string[] = [];
    const migration = observeHostDataSql((sql, database) => {
      if (database?.location() === databasePath) {
        queries.push(sql);
      }
    });
    try {
      await withStateMigrationBackupForTest(options, () => {
        if (entry === "doctor repair") {
          expect(repairSchema(options).warnings).toEqual([]);
        }
        openState(options);
      });
      const integrityChecks = queries.filter((sql) => /^PRAGMA integrity_check\s*;?$/iu.test(sql));
      expect(integrityChecks).toHaveLength(entry === "runtime open" ? 1 : 0);
      if (entry === "doctor repair") {
        expect(queries).toContain("PRAGMA quick_check;");
      }
    } finally {
      migration.restore();
    }
    const database = openState(options);
    const { db } = database;
    expectReceipt(db, {
      receipt_id: "legacy-receipt",
      status: "running",
      delivery_attempt_state: "unknown",
    });
    expectRow(db, "PRAGMA user_version", { user_version: SCHEMA_VERSION });
    expectRow(db, "PRAGMA integrity_check", { integrity_check: "ok" });
    db.exec("UPDATE cron_run_receipts SET delivery_attempt_state = 'started'");
    // Reuse remains valid while a sibling is live; final close requires readmission.
    const survivingReader = openOpenClawStateReadOnlyLocation(database.path, database.path);
    closeState();
    // Final close retires admission; the cold reopen precedes the warm-borrow observation.
    openState(options);
    try {
      observeReads((readQueries) => {
        expectReceipt(openState(options).db, { delivery_attempt_state: "started" });
        expect(
          readQueries.filter((sql) =>
            /(?:sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\bFROM\s+"?schema_meta\b|state\.schema\.contentVersion)/iu.test(
              sql,
            ),
          ),
        ).toEqual([]);
      });
    } finally {
      survivingReader.close();
    }
    closeState();
    const preflight = await preflightOpenClawDatabaseSchemas({
      env: options.env,
      scope: "state",
      supportedVersions: { state: 19, agent: 23 },
    });
    expect(preflight.incompatible).toMatchObject([
      { kind: "state", foundVersion: SCHEMA_VERSION, supportedVersion: 19 },
    ]);
  },
);

it("rolls receipt migration back with schema publication failure", async () => {
  const { options, databasePath } = await legacyReceiptDatabase();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TRIGGER refuse_schema_publication BEFORE UPDATE ON schema_meta
    BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;`);
  legacy.close();
  await expect(withStateMigrationBackupForTest(options, () => openState(options))).rejects.toThrow(
    "fixture publication refusal",
  );
  using after = new DatabaseSync(databasePath, { readOnly: true });
  expectRow(after, "PRAGMA user_version", { user_version: 19 });
  expectReceipt(after, { receipt_id: "legacy-receipt", status: "running" });
  expectRow(
    after,
    "SELECT 1 FROM pragma_table_info('cron_run_receipts') WHERE name = 'delivery_attempt_state'",
    undefined,
  );
});

it("refuses an unversioned cron-only catalog without adopting its data", () => {
  const stateDir = tempDirs.make("early-cron-migration-");
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  const jobJson = JSON.stringify({
    id: "legacy-job",
    name: "Legacy job",
    enabled: true,
    deleteAfterRun: true,
    createdAtMs: 123,
    updatedAtMs: 456,
    agentId: "agent-a",
    sessionKey: "agent:agent-a:main",
    schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 0 },
    payload: { kind: "agentTurn", message: "hello", model: "anthropic/claude-sonnet-4-6" },
    delivery: {
      mode: "announce",
      channel: "telegram",
      to: "chat-1",
      accountId: "acct-1",
      bestEffort: true,
      failureDestination: { to: "https://example.invalid/hook" },
    },
    failureAlert: { mode: "announce", channel: "discord", to: "ops", after: 2 },
  });
  const projectedJobJson = JSON.stringify({ delivery: { threadId: 1008013 } });
  db.exec(`
    CREATE TABLE cron_jobs (
      store_key TEXT NOT NULL, job_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      schedule_kind TEXT NOT NULL DEFAULT 'manual',
      payload_kind TEXT NOT NULL DEFAULT 'message',
      delivery_thread_id TEXT, job_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (store_key, job_id)
    );
  `);
  db.prepare(
    "INSERT INTO cron_jobs (store_key, job_id, job_json, updated_at) VALUES (?, ?, ?, ?)",
  ).run(path.join(stateDir, "cron", "jobs.json"), "legacy-job", jobJson, 456);
  db.prepare("INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    path.join(stateDir, "cron", "jobs.json"),
    "already-projected-job",
    "Already projected",
    "every",
    "agentTurn",
    null,
    projectedJobJson,
    456,
  );
  const rows = db.prepare("SELECT * FROM cron_jobs ORDER BY job_id").all();
  const catalogSql = "SELECT type,name,sql FROM sqlite_schema ORDER BY type,name";
  const catalog = db.prepare(catalogSql).all();
  db.close();
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  expect(() => openState(options)).toThrow(/Unrecognized native bootstrap database/);
  using preserved = new DatabaseSync(databasePath, { readOnly: true });
  expectRow(preserved, "PRAGMA user_version", { user_version: 0 });
  expectRows(preserved, "SELECT * FROM cron_jobs ORDER BY job_id", rows);
  expectRows(preserved, catalogSql, catalog);
  expect(existsSync(resolveClientCredentialStorePath(options.env))).toBe(false);
});
