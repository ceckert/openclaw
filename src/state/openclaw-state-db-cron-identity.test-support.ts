import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupDoctorMigrationDatabases } from "../commands/doctor-migration-backup.js";
import type { MigrationRecord } from "../cron/store/migration-persistence.js";
import { installLegacyCronMigrationFixture } from "./openclaw-state-db-schema-v21.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";

export function readLegacyCronIdentityRows(pathname: string) {
  using db = new DatabaseSync(pathname, { readOnly: true });
  return {
    operations: db
      .prepare(
        "SELECT CAST(rowid AS TEXT) AS physical_identity, * FROM cron_migrations ORDER BY rowid",
      )
      .all(),
    fences: db
      .prepare(
        "SELECT CAST(rowid AS TEXT) AS physical_identity, * FROM cron_agent_migration_fences ORDER BY rowid",
      )
      .all(),
  };
}

export async function createLegacyCronIdentityFixture(
  stateDir: string,
  operationIdentities: readonly [bigint, bigint, bigint],
  fenceIdentity: bigint,
) {
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const pathname = openOpenClawStateDatabase(options).path;
  await closeOpenClawStateDatabaseAsync();
  const records: MigrationRecord[] = ["z-older", "a-latest", "m-return"].map(
    (operationId, index) => ({
      store_key: "home",
      operation_id: operationId,
      agent_ids_json: '["alpha"]',
      status: index < 2 ? "retired" : "held",
      snapshot_json: null,
      snapshot_digest:
        index < 2
          ? createHash("sha256")
              .update(
                JSON.stringify({
                  version: 1,
                  operationId,
                  agentIds: ["alpha"],
                  jobs: [],
                  scratch: [],
                  retainedJobIds: [],
                }),
              )
              .digest("hex")
          : null,
    }),
  );
  {
    using db = new DatabaseSync(pathname);
    installLegacyCronMigrationFixture(db, records, [
      { store_key: "home", agent_id: "alpha", operation_id: "m-return" },
    ]);
    for (const [index, row] of records.entries()) {
      db.prepare("UPDATE cron_migrations SET rowid = ? WHERE operation_id = ?").run(
        operationIdentities[index]!,
        row.operation_id,
      );
    }
    db.prepare("UPDATE cron_agent_migration_fences SET rowid = ?").run(fenceIdentity);
  }
  const replacement = `${pathname}.fixture`;
  fs.copyFileSync(pathname, replacement);
  fs.renameSync(replacement, pathname);
  return { options, pathname, originals: readLegacyCronIdentityRows(pathname) };
}

export async function runLegacyCronIdentityDoctor(fixture: {
  options: { env: { OPENCLAW_STATE_DIR: string } };
  pathname: string;
}) {
  await closeOpenClawStateDatabaseAsync();
  return withStateMigrationBackupForTest(fixture.options, async () => {
    const backup = await backupDoctorMigrationDatabases({
      ...fixture.options,
      pendingDatabasePaths: [fixture.pathname],
      databasePaths: [fixture.pathname],
    });
    return { backup, repair: repairOpenClawStateDatabaseSchema(fixture.options) };
  });
}

export function legacyCronIdentityBackupPath(pathname: string): string {
  const names = fs
    .readdirSync(path.dirname(pathname))
    .filter(
      (name) =>
        name.startsWith(`${path.basename(pathname)}.pre-startup-migration-`) &&
        name.endsWith(".bak") &&
        !name.endsWith(".scoped.bak"),
    );
  if (names.length !== 1) {
    throw new Error("Expected one retained cron custody migration backup");
  }
  return path.join(path.dirname(pathname), names[0]!);
}
