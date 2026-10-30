import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  listCronMigrations,
  readCronMigrationFence,
  readCronMigrationImport,
  type MigrationRecord,
} from "../cron/store/migration-persistence.js";
import { assertCronAgentMigrationAdmitted } from "../cron/store/migration.kernel.js";
import { upsertCronJobRow } from "../cron/store/row-codec.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { preflightOpenClawStateDatabasePath } from "./openclaw-database-preflight.js";
import {
  legacyCronIdentityBackupPath,
  readLegacyCronIdentityRows,
  runLegacyCronIdentityDoctor,
} from "./openclaw-state-db-cron-identity.test-support.js";
import { installLegacyCronMigrationFixture } from "./openclaw-state-db-schema-v21.test-support.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});

async function createRetirementFixture(
  transition: "none" | "resumed" | "aborted" | "activated",
  alphaFence: boolean,
  transitionStore = "home",
  initialStatus: "retired" | "held" = "retired",
) {
  const options = { env: { OPENCLAW_STATE_DIR: directories.make("cron-retirement-") } };
  const pathname = openOpenClawStateDatabase(options).path;
  await closeOpenClawStateDatabaseAsync();
  const records: MigrationRecord[] = [
    {
      store_key: "home",
      operation_id: "z-retired",
      agent_ids_json: '["alpha","beta"]',
      status: initialStatus,
      snapshot_json: null,
      snapshot_digest: null,
    },
  ];
  if (transition !== "none") {
    records.push({
      store_key: transitionStore,
      operation_id: "a-return",
      agent_ids_json: '["alpha"]',
      status: transition,
      snapshot_json: null,
      snapshot_digest: null,
    });
  }
  {
    using db = new DatabaseSync(pathname);
    installLegacyCronMigrationFixture(db, records, [
      { store_key: "home", agent_id: "beta", operation_id: "z-retired" },
      ...(alphaFence ? [{ store_key: "home", agent_id: "alpha", operation_id: "z-retired" }] : []),
    ]);
    upsertCronJobRow(
      db,
      "home",
      {
        id: "retained-on-exit",
        agentId: "alpha",
        name: "retained",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 2,
        schedule: { kind: "on-exit", command: "true" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "synthetic" },
        state: {},
      },
      0,
    );
  }
  const replacement = `${pathname}.fixture`;
  fs.copyFileSync(pathname, replacement);
  fs.renameSync(replacement, pathname);
  using db = new DatabaseSync(pathname, { readOnly: true });
  return {
    options,
    pathname,
    originals: readLegacyCronIdentityRows(pathname),
    jobs: db.prepare("SELECT * FROM cron_jobs").all(),
  };
}

it.each(["none", "resumed", "aborted"] as const)(
  "refuses missing permanent retirement custody after %s without committing native state",
  async (transition) => {
    const fixture = await createRetirementFixture(transition, false);
    const result = await runLegacyCronIdentityDoctor(fixture);
    expect(result.backup.warnings).toEqual([]);
    expect(result.repair.warnings).toEqual([
      expect.stringContaining("Retained cron custody operation is missing its admission fence"),
    ]);
    expect(result.repair.changes).not.toContain(
      "Preserved retained cron custody in native plugin state",
    );
    expect(readLegacyCronIdentityRows(fixture.pathname)).toEqual(fixture.originals);
    expect(readLegacyCronIdentityRows(legacyCronIdentityBackupPath(fixture.pathname))).toEqual(
      fixture.originals,
    );
    {
      using db = new DatabaseSync(fixture.pathname, { readOnly: true });
      expect(listCronMigrations(db, "home")).toEqual([]);
      expect(readCronMigrationFence(db, "home", "alpha")).toBeUndefined();
      expect(readCronMigrationFence(db, "home", "beta")).toBeUndefined();
      expect(readCronMigrationImport(db)).toBeUndefined();
      expect(db.prepare("SELECT * FROM cron_jobs").all()).toEqual(fixture.jobs);
    }
    expect(await preflightOpenClawStateDatabasePath(fixture.pathname)).toMatchObject({
      status: "indeterminate",
    });
    expect(() => openOpenClawStateDatabase(fixture.options)).toThrow(/cron custody.*doctor --fix/);
  },
);

it.each(["none", "resumed", "aborted", "activated"] as const)(
  "preserves per-agent retirement custody after %s through Doctor and restart",
  async (transition) => {
    const activated = transition === "activated";
    const fixture = await createRetirementFixture(transition, !activated);
    const result = await runLegacyCronIdentityDoctor(fixture);
    expect(result.backup.warnings).toEqual([]);
    expect(result.repair.warnings).toEqual([]);
    expect(result.repair.changes).toContain(
      "Preserved retained cron custody in native plugin state",
    );
    expect(readLegacyCronIdentityRows(fixture.pathname)).toEqual(fixture.originals);
    expect(readLegacyCronIdentityRows(legacyCronIdentityBackupPath(fixture.pathname))).toEqual(
      fixture.originals,
    );
    const assertCustody = (db: EngineConnection) => {
      expect(readCronMigrationImport(db)).toBeDefined();
      expect(readCronMigrationFence(db, "home", "beta")?.operation_id).toBe("z-retired");
      expect(() => assertCronAgentMigrationAdmitted(db, "home", "beta")).toThrow(/z-retired/);
      if (activated) {
        expect(readCronMigrationFence(db, "home", "alpha")).toBeUndefined();
        expect(() => assertCronAgentMigrationAdmitted(db, "home", "alpha")).not.toThrow();
      } else {
        expect(readCronMigrationFence(db, "home", "alpha")?.operation_id).toBe("z-retired");
        expect(() => assertCronAgentMigrationAdmitted(db, "home", "alpha")).toThrow(/z-retired/);
      }
      expect(db.prepare("SELECT * FROM cron_jobs").all()).toEqual(fixture.jobs);
    };
    assertCustody(openOpenClawStateDatabase(fixture.options).db);
    await closeOpenClawStateDatabaseAsync();
    assertCustody(openOpenClawStateDatabase(fixture.options).db);
  },
);

it("does not let activation in another store erase source retirement authority", async () => {
  const fixture = await createRetirementFixture("activated", false, "other");
  const result = await runLegacyCronIdentityDoctor(fixture);
  expect(result.backup.warnings).toEqual([]);
  expect(result.repair.warnings).toEqual([
    expect.stringContaining("Retained cron custody operation is missing its admission fence"),
  ]);
  expect(readLegacyCronIdentityRows(fixture.pathname)).toEqual(fixture.originals);
  using db = new DatabaseSync(fixture.pathname, { readOnly: true });
  expect(readCronMigrationImport(db)).toBeUndefined();
});

it("refuses an unfinished hold even when a later operation claims activation", async () => {
  const fixture = await createRetirementFixture("activated", false, "home", "held");
  const result = await runLegacyCronIdentityDoctor(fixture);
  expect(result.backup.warnings).toEqual([]);
  expect(result.repair.warnings).toEqual([
    expect.stringContaining("Retained cron custody operation is missing its admission fence"),
  ]);
  expect(readLegacyCronIdentityRows(fixture.pathname)).toEqual(fixture.originals);
  using db = new DatabaseSync(fixture.pathname, { readOnly: true });
  expect(readCronMigrationImport(db)).toBeUndefined();
});
