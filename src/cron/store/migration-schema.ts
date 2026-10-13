import type { DatabaseSync } from "node:sqlite";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { assertLegacyCronCustodyConverted } from "./migration-legacy.js";

export function hasCronMigrationSchema(db: DatabaseSync): boolean {
  assertLegacyCronCustodyConverted(db);
  return tableExists(db, "plugin_state_entries");
}

export function ensureCronMigrationSchema(db: DatabaseSync): void {
  if (!hasCronMigrationSchema(db)) {
    throw new Error("Cron custody requires the canonical native plugin-state store");
  }
}
