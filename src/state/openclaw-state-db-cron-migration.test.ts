import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const reader = vi.hoisted(() => ({ supportedVersion: 20 }));
vi.mock("./openclaw-state-db-contract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-db-contract.js")>()),
  get OPENCLAW_STATE_SCHEMA_VERSION() {
    return reader.supportedVersion;
  },
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  reader.supportedVersion = 20;
  closeOpenClawStateDatabaseForTest();
});

it("upgrades schema 19 without losing jobs and fences schema 19 readers from held migration state", () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-cron-schema-") } };
  const databasePath = openOpenClawStateDatabase(options).path;
  closeOpenClawStateDatabaseForTest();
  const previous = new DatabaseSync(databasePath);
  try {
    previous.exec(`
      DROP TABLE cron_agent_migration_fences;
      DROP TABLE cron_migrations;
      PRAGMA user_version = 19;
      UPDATE schema_meta SET schema_version = 19;
      DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';
      INSERT INTO cron_jobs (store_key, job_id, sort_order, name, enabled, payload_kind, job_json, state_json, updated_at)
      VALUES ('cron-test', 'retained', 0, 'retained', 1, 'agentTurn', '{"id":"retained","agentId":"alpha"}', '{}', 1);
    `);
  } finally {
    previous.close();
  }
  const upgraded = openOpenClawStateDatabase(options);
  expect(upgraded.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 20 });
  expect(upgraded.db.prepare("SELECT job_id FROM cron_jobs").all()).toEqual([
    { job_id: "retained" },
  ]);
  upgraded.db.exec(`
    INSERT INTO cron_migrations VALUES ('cron-test', 'migration', '["alpha"]', 'held', NULL, NULL);
    INSERT INTO cron_agent_migration_fences VALUES ('cron-test', 'alpha', 'migration');
  `);
  expect(upgraded.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(upgraded.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  reader.supportedVersion = 19;
  expect(() => assertSupportedStateSchemaVersion(upgraded.db, upgraded.path)).toThrow(
    /uses newer schema version 20; this build supports 19/,
  );
  expect(upgraded.db.prepare("SELECT agent_id FROM cron_agent_migration_fences").all()).toEqual([
    { agent_id: "alpha" },
  ]);
});
