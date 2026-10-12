import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertCronAgentMigrationAdmitted,
  assertCronJobMigrationMutationAdmitted,
  assertCronJobMigrationScratchAdmitted,
  executeCronMigrationInDatabase,
} from "../cron/store/migration.kernel.js";
import { upsertCronJobRow } from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

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

it("keeps reads non-initializing and persists first-use handoff fences without changing native schema 21", async () => {
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
  expect(tables(db)).toEqual([
    { name: "cron_agent_migration_fences" },
    { name: "cron_migrations" },
  ]);
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 21 });
  expect(() => assertCronAgentMigrationAdmitted(db, "synthetic", "alpha")).toThrow(/held/);
  expect(() => assertCronAgentMigrationAdmitted(db, "synthetic", "beta")).not.toThrow();
  await closeOpenClawStateDatabaseAsync();
  const reopened = openOpenClawStateDatabase(options).db;
  expect(reopened.prepare("SELECT rowid, operation_id, status FROM cron_migrations").get()).toEqual(
    { rowid: 1, operation_id: "held", status: "exported" },
  );
  expect(() => assertCronAgentMigrationAdmitted(reopened, "synthetic", "alpha")).toThrow(/held/);
  expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it.each(["cron_migrations", "cron_agent_migration_fences"])(
  "refuses a missing %s without initializing or replacing the surviving handoff state",
  (missing) => {
    const { db } = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: directories.make("cron-incomplete-") },
    });
    runSqliteImmediateTransactionSync(db, () =>
      executeCronMigrationInDatabase(db, "synthetic", {
        operationId: "held",
        phase: "hold",
        agentIds: ["alpha"],
      }),
    );
    db.exec(`PRAGMA foreign_keys = OFF; DROP TABLE ${missing};`);
    const surviving =
      missing === "cron_migrations" ? "cron_agent_migration_fences" : "cron_migrations";
    const rows = db.prepare(`SELECT rowid, * FROM ${surviving}`).all();
    expect(() => assertCronAgentMigrationAdmitted(db, "synthetic", "alpha")).toThrow(
      /must both be present/,
    );
    expect(() =>
      executeCronMigrationInDatabase(db, "synthetic", {
        operationId: "new",
        phase: "hold",
        agentIds: ["beta"],
      }),
    ).toThrow(/must both be present/);
    expect(db.prepare(`SELECT rowid, * FROM ${surviving}`).all()).toEqual(rows);
    expect(tables(db)).toEqual([{ name: surviving }]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 21 });
  },
);
