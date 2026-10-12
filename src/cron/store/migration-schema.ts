import type { DatabaseSync } from "node:sqlite";
import { assertSqliteSchemaContains } from "../../infra/sqlite-schema-contract.js";
import { SqliteSchemaMismatchError } from "../../infra/sqlite-schema-issues.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { getOpenClawStateFeatureSchemaSql } from "../../state/openclaw-state-feature-schema.js";

const tables = ["cron_migrations", "cron_agent_migration_fences"] as const;
const schemaSql = tables.map((table) => getOpenClawStateFeatureSchemaSql(table)).join("\n");
const validated = new WeakSet<DatabaseSync>();

export function hasCronMigrationSchema(db: DatabaseSync): boolean {
  const present = tables.map((table) => tableExists(db, table));
  if (present[0] !== present[1]) {
    throw new SqliteSchemaMismatchError(
      "Cron migration journal and admission fences must both be present; refusing incomplete handoff authority.",
    );
  }
  return present[0]!;
}

export function ensureCronMigrationSchema(db: DatabaseSync): void {
  if (!hasCronMigrationSchema(db)) {
    // sqlite-allow-raw -- Grouped feature-local DDL in the migration owner's write transaction.
    db.exec(schemaSql);
  }
  if (!validated.has(db)) {
    assertSqliteSchemaContains(db, "cron migration handoff", schemaSql);
    validated.add(db);
  }
}
