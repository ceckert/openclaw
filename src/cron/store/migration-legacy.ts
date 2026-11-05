import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { assertSqliteSchemaContains } from "../../infra/sqlite-schema-contract.js";
import { SqliteSchemaMismatchError } from "../../infra/sqlite-schema-issues.js";
import { StartupMaintenanceRequiredError } from "../../infra/startup-maintenance-required.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { parseCronMigrationScope } from "../migration-snapshot.js";
import {
  readCronMigration,
  readCronMigrationFence,
  readCronMigrationImport,
  writeCronMigration,
  writeCronMigrationFence,
  writeCronMigrationImport,
  type MigrationFence,
  type MigrationRecord,
} from "./migration-persistence.js";

export const LEGACY_CRON_MIGRATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cron_migrations (
  store_key TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  agent_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held', 'exported', 'staged', 'activated', 'resumed', 'retired', 'aborted')),
  snapshot_json TEXT,
  snapshot_digest TEXT,
  PRIMARY KEY (store_key, operation_id)
) STRICT;
CREATE TABLE IF NOT EXISTS cron_agent_migration_fences (
  store_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  PRIMARY KEY (store_key, agent_id),
  FOREIGN KEY (store_key, operation_id) REFERENCES cron_migrations(store_key, operation_id)
) STRICT;
`;

function hasLegacyPair(db: DatabaseSync): boolean {
  const journal = tableExists(db, "cron_migrations");
  const fences = tableExists(db, "cron_agent_migration_fences");
  if (journal !== fences) {
    throw new SqliteSchemaMismatchError(
      "Cron migration journal and admission fences must both be present; refusing incomplete handoff authority.",
    );
  }
  return journal;
}

export function hasLegacyCronMigrationCustody(db: DatabaseSync): boolean {
  return (
    hasLegacyPair(db) &&
    (!tableExists(db, "plugin_state_entries") || readCronMigrationImport(db) === undefined)
  );
}

export function assertLegacyCronCustodyConverted(
  db: DatabaseSync,
  pathname = "shared state",
): void {
  if (hasLegacyCronMigrationCustody(db)) {
    throw new StartupMaintenanceRequiredError(
      "state-migrations",
      `Retained cron custody at ${pathname} requires conversion through openclaw doctor --fix before scheduling.`,
    );
  }
}

export function migrateLegacyCronMigrationCustody(db: DatabaseSync, pathname: string): boolean {
  if (!hasLegacyPair(db)) {
    return false;
  }
  assertSqliteSchemaContains(db, pathname, LEGACY_CRON_MIGRATION_SCHEMA_SQL);
  const source = getNodeSqliteKysely<{
    cron_migrations: MigrationRecord;
    cron_agent_migration_fences: MigrationFence;
  }>(db);
  const operations = executeSqliteQuerySync(
    db,
    source
      .selectFrom("cron_migrations")
      .selectAll()
      .select((eb) => eb.cast<string>(sql`rowid`, "text").as("physical_identity"))
      .orderBy(sql`rowid`, "asc"),
  ).rows;
  const fences = executeSqliteQuerySync(
    db,
    source
      .selectFrom("cron_agent_migration_fences")
      .selectAll()
      .select((eb) => eb.cast<string>(sql`rowid`, "text").as("physical_identity"))
      .orderBy(sql`rowid`, "asc"),
  ).rows;
  const sourceDigest = createHash("sha256")
    .update(JSON.stringify({ operations, fences }))
    .digest("hex");
  const imported = readCronMigrationImport(db);
  if (imported !== undefined) {
    if (!isDeepStrictEqual(imported, { sourceDigest })) {
      throw new Error("Retained cron custody source changed after Doctor conversion");
    }
    return false;
  }
  const scopes = new Map<string, string[]>();
  for (const [index, { physical_identity: _identity, ...row }] of operations.entries()) {
    const ids: unknown = JSON.parse(row.agent_ids_json);
    const agentIds =
      Array.isArray(ids) && ids.length === 0 && ["resumed", "aborted"].includes(row.status)
        ? []
        : parseCronMigrationScope(ids);
    if (agentIds.length) {
      if (!isDeepStrictEqual(ids, agentIds)) {
        throw new Error("Retained cron custody scope is not canonical");
      }
    }
    scopes.set(JSON.stringify([row.store_key, row.operation_id]), agentIds);
    const existing = readCronMigration(db, row.store_key, row.operation_id);
    if (existing && !isDeepStrictEqual(existing, row)) {
      throw new Error("Retained cron custody operation conflicts with native plugin state");
    }
    writeCronMigration(db, row, index + 1);
  }
  for (const { physical_identity: _identity, ...fence } of fences) {
    const operation = operations.find(
      (row) => row.store_key === fence.store_key && row.operation_id === fence.operation_id,
    );
    if (
      !operation ||
      !scopes.get(JSON.stringify([fence.store_key, fence.operation_id]))?.includes(fence.agent_id)
    ) {
      throw new Error("Retained cron custody fence has no matching operation scope");
    }
    const existing = readCronMigrationFence(db, fence.store_key, fence.agent_id);
    if (existing && !isDeepStrictEqual(existing, fence)) {
      throw new Error("Retained cron custody fence conflicts with native plugin state");
    }
    writeCronMigrationFence(db, fence);
  }
  const latestOwnership = new Map<string, string>();
  for (const row of operations) {
    if (["resumed", "aborted"].includes(row.status)) {
      continue;
    }
    const agentIds = scopes.get(JSON.stringify([row.store_key, row.operation_id]))!;
    for (const agentId of agentIds) {
      const key = JSON.stringify([row.store_key, agentId]);
      latestOwnership.set(key, row.operation_id);
    }
  }
  for (const row of operations) {
    if (!["held", "exported", "staged", "retired"].includes(row.status)) {
      continue;
    }
    const agentIds = scopes.get(JSON.stringify([row.store_key, row.operation_id]))!;
    if (
      agentIds.some(
        (agentId) =>
          (row.status !== "retired" ||
            latestOwnership.get(JSON.stringify([row.store_key, agentId])) === row.operation_id) &&
          !fences.some(
            (fence) =>
              fence.store_key === row.store_key &&
              fence.agent_id === agentId &&
              fence.operation_id === row.operation_id,
          ),
      )
    ) {
      throw new Error("Retained cron custody operation is missing its admission fence");
    }
  }
  writeCronMigrationImport(db, { sourceDigest });
  return true;
}
