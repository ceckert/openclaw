import { createHash } from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { backupDoctorMigrationDatabases } from "../commands/doctor-migration-backup.js";
import {
  readCronMigration,
  readCronMigrationFence,
  readCronMigrationImport,
  listCronMigrations,
} from "../cron/store/migration-persistence.js";
import {
  assertCronAgentMigrationAdmitted,
  assertCronJobMigrationMutationAdmitted,
  assertCronJobMigrationScratchAdmitted,
  executeCronMigrationInDatabase,
} from "../cron/store/migration.kernel.js";
import { upsertCronJobRow } from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { preflightOpenClawStateDatabasePath } from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  createLegacyCronIdentityFixture,
  legacyCronIdentityBackupPath,
  readLegacyCronIdentityRows,
  runLegacyCronIdentityDoctor,
} from "./openclaw-state-db-cron-identity.test-support.js";
import { assertCurrentStateRuntimeSchema } from "./openclaw-state-db-fast-path.js";
import { installLegacyCronMigrationFixture } from "./openclaw-state-db-schema-v21.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});
const job: CronStoredJob = {
  id: "retained",
  agentId: "alpha",
  name: "retained",
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 2,
  schedule: { kind: "every", everyMs: 60000, anchorMs: 0 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "synthetic" },
  state: { nextRunAtMs: 60000 },
};
const tables = (db: ReturnType<typeof openOpenClawStateDatabase>["db"]) =>
  db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE name IN ('cron_migrations', 'cron_agent_migration_fences') ORDER BY name",
    )
    .all();

it("converts retained cron custody in the same Doctor pass as the native v22 upgrade", async () => {
  const fixture = await createLegacyCronIdentityFixture(
    directories.make("cron-bounded-doctor-"),
    [7n, 30n, 90n],
    12n,
  );
  {
    using db = new DatabaseSync(fixture.pathname);
    db.exec(`DROP INDEX idx_meeting_transcript_sessions_chronology;
      ALTER TABLE meeting_transcript_sessions DROP COLUMN started_at_ms;
      PRAGMA user_version = 22;
      UPDATE schema_meta SET schema_version = 22;
      DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';`);
  }
  const result = await runLegacyCronIdentityDoctor(fixture);
  expect(result.backup.warnings).toEqual([]);
  expect(result.repair.warnings).toEqual([]);
  expect(result.repair.changes).toContain(
    "Replaced retained task indexes with ordered cron history indexes (v24)",
  );
  expect(result.repair.changes).toContain("Preserved retained cron custody in native plugin state");
  expect(readLegacyCronIdentityRows(fixture.pathname)).toEqual(fixture.originals);
  const backupPath = legacyCronIdentityBackupPath(fixture.pathname);
  expect(readLegacyCronIdentityRows(backupPath)).toEqual(fixture.originals);
  {
    using backup = new DatabaseSync(backupPath, { readOnly: true });
    expect(backup.prepare("PRAGMA user_version").get()).toEqual({ user_version: 22 });
  }
  const database = openOpenClawStateDatabase(fixture.options);
  expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
  expect(readCronMigrationImport(database.db)).toBeDefined();
  expect(readCronMigrationFence(database.db, "home", "alpha")?.operation_id).toBe("m-return");
  expect(() => assertCronAgentMigrationAdmitted(database.db, "home", "alpha")).toThrow(/m-return/);
});

function assertNativeStateRuntimeSchema(db: EngineConnection, pathname: string): void {
  if (isPostgresSqlConnection(db)) {
    throw new Error("Cron custody fixtures require a native SQLite state database");
  }
  assertCurrentStateRuntimeSchema(db, pathname);
}

it("keeps reads non-initializing and persists handoff custody only in native retained state", async () => {
  const options = { env: { OPENCLAW_STATE_DIR: directories.make("cron-first-use-") } };
  const { db } = openOpenClawStateDatabase(options);
  db.exec("DROP TABLE cron_run_receipts");
  upsertCronJobRow(db, "synthetic", job, 0);
  expect(tables(db)).toEqual([]);
  assertCronAgentMigrationAdmitted(db, "synthetic", "alpha");
  assertCronJobMigrationMutationAdmitted(db, "synthetic", job);
  assertCronJobMigrationScratchAdmitted(db, "synthetic", job.id);
  expect(tables(db)).toEqual([]);
  runSqliteImmediateTransactionSync(db, () =>
    executeCronMigrationInDatabase(db, "synthetic", {
      operationId: "held",
      phase: "hold",
      agentIds: ["alpha"],
    }),
  );
  expect(
    runSqliteImmediateTransactionSync(db, () =>
      executeCronMigrationInDatabase(db, "synthetic", {
        operationId: "held",
        phase: "export",
      }),
    ),
  ).toMatchObject({ drained: true, snapshot: { jobs: [job] } });
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name = 'cron_run_receipts'").get(),
  ).toBeUndefined();
  expect(tables(db)).toEqual([]);
  expect(db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
  expect(() => assertCronAgentMigrationAdmitted(db, "synthetic", "alpha")).toThrow(/held/);
  expect(() => assertCronAgentMigrationAdmitted(db, "synthetic", "beta")).not.toThrow();
  await closeOpenClawStateDatabaseAsync();
  const reopened = openOpenClawStateDatabase(options).db;
  expect(readCronMigration(reopened, "synthetic", "held")).toMatchObject({
    operation_id: "held",
    status: "exported",
  });
  expect(() => assertCronAgentMigrationAdmitted(reopened, "synthetic", "alpha")).toThrow(/held/);
  expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it.each(["cron_migrations", "cron_agent_migration_fences"])(
  "refuses a missing %s without initializing or replacing the surviving handoff state",
  async (missing) => {
    const options = {
      env: { OPENCLAW_STATE_DIR: directories.make("cron-incomplete-") },
    };
    const pathname = openOpenClawStateDatabase(options).path;
    await closeOpenClawStateDatabaseAsync();
    const surviving =
      missing === "cron_migrations" ? "cron_agent_migration_fences" : "cron_migrations";
    const readOriginal = (db: DatabaseSync) => ({
      rows: db.prepare(`SELECT rowid, * FROM ${surviving}`).all(),
      tables: tables(db),
      version: db.prepare("PRAGMA user_version").get(),
    });
    let original: ReturnType<typeof readOriginal>;
    {
      using db = new DatabaseSync(pathname);
      installLegacyCronMigrationFixture(
        db,
        [
          {
            store_key: "synthetic",
            operation_id: "held",
            agent_ids_json: '["alpha"]',
            status: "held",
            snapshot_json: null,
            snapshot_digest: null,
          },
        ],
        [{ store_key: "synthetic", agent_id: "alpha", operation_id: "held" }],
      );
      db.exec(`PRAGMA foreign_keys = OFF; DROP TABLE ${missing};`);
      original = readOriginal(db);
    }
    const replacement = `${pathname}.fixture`;
    fs.copyFileSync(pathname, replacement);
    fs.renameSync(replacement, pathname);
    expect(original.tables).toEqual([{ name: surviving }]);
    expect(original.version).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    if (missing === "cron_migrations") {
      expect(await preflightOpenClawStateDatabasePath(pathname)).toMatchObject({
        status: "indeterminate",
        reason: expect.stringMatching(
          /foreign_key_check failed.*cron_agent_migration_fences.*references cron_migrations/,
        ),
      });
    } else {
      expect(await preflightOpenClawStateDatabasePath(pathname)).toMatchObject({
        status: "indeterminate",
        foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        reason: expect.stringMatching(/must both be present/),
      });
    }
    expect(() => openOpenClawStateDatabase(options)).toThrow(/must both be present/);
    using preserved = new DatabaseSync(pathname, { readOnly: true });
    expect(readOriginal(preserved)).toEqual(original);
  },
);

it("requires backed-up Doctor conversion and preserves inherited custody through canonical preflight and restart", async () => {
  const stateDir = directories.make("cron-custody-doctor-");
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const pathname = openOpenClawStateDatabase(options).path;
  await closeOpenClawStateDatabaseAsync();
  const snapshot = JSON.stringify({
    version: 1,
    operationId: "exported",
    agentIds: ["alpha"],
    jobs: [job],
    scratch: [],
  });
  const staged = snapshot.replaceAll("exported", "staged");
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  {
    using legacy = new DatabaseSync(pathname);
    upsertCronJobRow(legacy, "home", { ...job, schedule: { kind: "on-exit", command: "true" } }, 0);
    upsertCronJobRow(legacy, "exported", job, 0);
    upsertCronJobRow(legacy, "staged", job, 0);
    installLegacyCronMigrationFixture(
      legacy,
      [
        {
          store_key: "home",
          operation_id: "z-retired",
          agent_ids_json: '["alpha"]',
          status: "retired",
          snapshot_json: null,
          snapshot_digest: digest(
            JSON.stringify({
              version: 1,
              operationId: "z-retired",
              agentIds: ["alpha"],
              jobs: [],
              scratch: [],
              retainedJobIds: [job.id],
            }),
          ),
        },
        {
          store_key: "home",
          operation_id: "a-return",
          agent_ids_json: '["alpha"]',
          status: "held",
          snapshot_json: null,
          snapshot_digest: null,
        },
        {
          store_key: "held",
          operation_id: "held",
          agent_ids_json: '["alpha"]',
          status: "held",
          snapshot_json: null,
          snapshot_digest: null,
        },
        {
          store_key: "exported",
          operation_id: "exported",
          agent_ids_json: '["alpha"]',
          status: "exported",
          snapshot_json: snapshot,
          snapshot_digest: digest(snapshot),
        },
        {
          store_key: "staged",
          operation_id: "staged",
          agent_ids_json: '["alpha"]',
          status: "staged",
          snapshot_json: staged,
          snapshot_digest: digest(staged),
        },
        {
          store_key: "home",
          operation_id: "early-abort",
          agent_ids_json: "[]",
          status: "aborted",
          snapshot_json: null,
          snapshot_digest: null,
        },
        {
          store_key: "home",
          operation_id: "early-resume",
          agent_ids_json: "[]",
          status: "resumed",
          snapshot_json: null,
          snapshot_digest: null,
        },
      ],
      [
        { store_key: "home", agent_id: "alpha", operation_id: "a-return" },
        { store_key: "held", agent_id: "alpha", operation_id: "held" },
        { store_key: "exported", agent_id: "alpha", operation_id: "exported" },
        { store_key: "staged", agent_id: "alpha", operation_id: "staged" },
      ],
    );
  }
  const replacement = `${pathname}.fixture`;
  fs.copyFileSync(pathname, replacement);
  fs.renameSync(replacement, pathname);
  expect(await preflightOpenClawStateDatabasePath(pathname)).toMatchObject({
    status: "indeterminate",
    foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    reason: expect.stringMatching(/cron custody.*doctor --fix/),
  });
  expect(() => openOpenClawStateDatabase(options)).toThrow(/cron custody.*doctor --fix/);
  await closeOpenClawStateDatabaseAsync();
  const original = (() => {
    using db = new DatabaseSync(pathname, { readOnly: true });
    return {
      operations: db.prepare("SELECT rowid, * FROM cron_migrations ORDER BY rowid").all(),
      fences: db.prepare("SELECT rowid, * FROM cron_agent_migration_fences ORDER BY rowid").all(),
      jobs: db.prepare("SELECT * FROM cron_jobs").all(),
    };
  })();
  await withStateMigrationBackupForTest(options, async () => {
    expect(
      (
        await backupDoctorMigrationDatabases({
          ...options,
          pendingDatabasePaths: [pathname],
          databasePaths: [pathname],
        })
      ).warnings,
    ).toEqual([]);
    expect(repairOpenClawStateDatabaseSchema(options)).toMatchObject({
      warnings: [],
      changes: expect.arrayContaining(["Preserved retained cron custody in native plugin state"]),
    });
  });
  const backupPath = legacyCronIdentityBackupPath(pathname);
  {
    using backup = new DatabaseSync(backupPath, {
      readOnly: true,
    });
    expect(backup.prepare("SELECT rowid, * FROM cron_migrations ORDER BY rowid").all()).toEqual(
      original.operations,
    );
    expect(
      backup.prepare("SELECT rowid, * FROM cron_agent_migration_fences ORDER BY rowid").all(),
    ).toEqual(original.fences);
  }
  expect(await preflightOpenClawStateDatabasePath(pathname)).toMatchObject({ status: "exact" });
  const database = openOpenClawStateDatabase(options);
  assertNativeStateRuntimeSchema(database.db, pathname);
  expect(database.db.prepare("SELECT rowid, * FROM cron_migrations ORDER BY rowid").all()).toEqual(
    original.operations,
  );
  expect(
    database.db.prepare("SELECT rowid, * FROM cron_agent_migration_fences ORDER BY rowid").all(),
  ).toEqual(original.fences);
  expect(database.db.prepare("SELECT * FROM cron_jobs").all()).toEqual(original.jobs);
  expect(listCronMigrations(database.db, "home").map((row) => row.operation_id)).toEqual([
    "z-retired",
    "a-return",
    "early-abort",
    "early-resume",
  ]);
  expect(readCronMigration(database.db, "exported", "exported")?.snapshot_json).toBe(snapshot);
  for (const storeKey of ["home", "held", "exported", "staged"]) {
    expect(() => assertCronAgentMigrationAdmitted(database.db, storeKey, "alpha")).toThrow(
      /migration/,
    );
  }
  runSqliteImmediateTransactionSync(database.db, () =>
    executeCronMigrationInDatabase(database.db, "home", {
      operationId: "a-return",
      phase: "resume",
    }),
  );
  expect(readCronMigrationFence(database.db, "home", "alpha")?.operation_id).toBe("z-retired");
  expect(() =>
    executeCronMigrationInDatabase(database.db, "home", {
      operationId: "early-abort",
      phase: "hold",
      agentIds: ["alpha"],
    }),
  ).toThrow(/aborted/);
  await closeOpenClawStateDatabaseAsync();
  expect(repairOpenClawStateDatabaseSchema(options).changes).not.toContain(
    "Preserved retained cron custody in native plugin state",
  );
  const restarted = openOpenClawStateDatabase(options);
  assertNativeStateRuntimeSchema(restarted.db, pathname);
  expect(() => assertCronAgentMigrationAdmitted(restarted.db, "home", "alpha")).toThrow(
    /z-retired/,
  );
  expect(restarted.db.prepare("SELECT rowid, * FROM cron_migrations ORDER BY rowid").all()).toEqual(
    original.operations,
  );
});

it("preserves signed 64-bit custody identities and numeric retirement order through Doctor and restart", async () => {
  const fixture = await createLegacyCronIdentityFixture(
    directories.make("cron-custody-identity-"),
    [-9223372036854775808n, -9007199254741001n, 9223372036854775806n],
    9223372036854775807n,
  );
  expect(fixture.originals.operations.map((row) => row.physical_identity)).toEqual([
    "-9223372036854775808",
    "-9007199254741001",
    "9223372036854775806",
  ]);
  expect(fixture.originals.fences[0]?.physical_identity).toBe("9223372036854775807");
  const first = await runLegacyCronIdentityDoctor(fixture);
  expect(first.backup.warnings).toEqual([]);
  expect(first.repair).toMatchObject({
    warnings: [],
    changes: expect.arrayContaining(["Preserved retained cron custody in native plugin state"]),
  });
  const backupPath = legacyCronIdentityBackupPath(fixture.pathname);
  expect(readLegacyCronIdentityRows(backupPath)).toEqual(fixture.originals);
  expect(readLegacyCronIdentityRows(fixture.pathname)).toEqual(fixture.originals);
  const database = openOpenClawStateDatabase(fixture.options);
  assertNativeStateRuntimeSchema(database.db, fixture.pathname);
  expect(listCronMigrations(database.db, "home").map((row) => row.operation_id)).toEqual([
    "z-older",
    "a-latest",
    "m-return",
  ]);
  expect(() => assertCronAgentMigrationAdmitted(database.db, "home", "alpha")).toThrow(/m-return/);
  runSqliteImmediateTransactionSync(database.db, () =>
    executeCronMigrationInDatabase(database.db, "home", {
      operationId: "m-return",
      phase: "resume",
    }),
  );
  expect(readCronMigrationFence(database.db, "home", "alpha")?.operation_id).toBe("a-latest");
  await closeOpenClawStateDatabaseAsync();
  const second = await runLegacyCronIdentityDoctor(fixture);
  expect(second.backup.warnings).toEqual([]);
  expect(second.repair.warnings).toEqual([]);
  expect(second.repair.changes).not.toContain(
    "Preserved retained cron custody in native plugin state",
  );
  expect(legacyCronIdentityBackupPath(fixture.pathname)).toBe(backupPath);
  expect(readLegacyCronIdentityRows(backupPath)).toEqual(fixture.originals);
  expect(readLegacyCronIdentityRows(fixture.pathname)).toEqual(fixture.originals);
  const restarted = openOpenClawStateDatabase(fixture.options);
  assertNativeStateRuntimeSchema(restarted.db, fixture.pathname);
  expect(readCronMigrationFence(restarted.db, "home", "alpha")?.operation_id).toBe("a-latest");
  expect(() => assertCronAgentMigrationAdmitted(restarted.db, "home", "alpha")).toThrow(/a-latest/);
});

it.each(["cron_migrations", "cron_agent_migration_fences"] as const)(
  "refuses identity-only changes to converted %s without changing native custody or its original backup",
  async (table) => {
    const fixture = await createLegacyCronIdentityFixture(
      directories.make("cron-custody-identity-change-"),
      [11n, 21n, 31n],
      41n,
    );
    const first = await runLegacyCronIdentityDoctor(fixture);
    expect(first.backup.warnings).toEqual([]);
    expect(first.repair.warnings).toEqual([]);
    const backupPath = legacyCronIdentityBackupPath(fixture.pathname);
    const custody = (db: EngineConnection) => ({
      operations: listCronMigrations(db, "home"),
      fence: readCronMigrationFence(db, "home", "alpha"),
      import: readCronMigrationImport(db),
    });
    const previous = custody(openOpenClawStateDatabase(fixture.options).db);
    await closeOpenClawStateDatabaseAsync();
    {
      using db = new DatabaseSync(fixture.pathname);
      db.prepare(
        `UPDATE ${table} SET rowid = ? WHERE store_key = 'home' AND operation_id = 'm-return'`,
      ).run(101n);
    }
    const changed = readLegacyCronIdentityRows(fixture.pathname);
    const unchangedFields = (rows: typeof changed.operations) =>
      rows.map(({ physical_identity: _identity, ...row }) => row);
    expect(unchangedFields(changed.operations)).toEqual(
      unchangedFields(fixture.originals.operations),
    );
    expect(unchangedFields(changed.fences)).toEqual(unchangedFields(fixture.originals.fences));
    expect(changed).not.toEqual(fixture.originals);
    const refused = await runLegacyCronIdentityDoctor(fixture);
    expect(refused.backup.warnings).toEqual([]);
    expect(refused.repair.warnings).toEqual([
      expect.stringContaining("Retained cron custody source changed after Doctor conversion"),
    ]);
    expect(refused.repair.changes).not.toContain(
      "Preserved retained cron custody in native plugin state",
    );
    expect(custody(openOpenClawStateDatabase(fixture.options).db)).toEqual(previous);
    await closeOpenClawStateDatabaseAsync();
    expect(readLegacyCronIdentityRows(fixture.pathname)).toEqual(changed);
    expect(legacyCronIdentityBackupPath(fixture.pathname)).toBe(backupPath);
    expect(readLegacyCronIdentityRows(backupPath)).toEqual(fixture.originals);
  },
);
