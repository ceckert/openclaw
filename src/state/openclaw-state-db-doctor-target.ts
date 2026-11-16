import { existsSync } from "node:fs";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateSchemaRepairAllowed } from "./openclaw-state-db-schema-policy.js";
import { resolveDatabasePath } from "./openclaw-state-db.paths.js";

export type DoctorRepairScope = "doctor" | "indexes" | "readability" | "version";
export type DoctorRepairOptions = OpenClawStateDatabaseOptions & {
  integrityCheck?: "quick" | "full";
};

export function resolveDoctorRepairTarget(options: DoctorRepairOptions, scope: DoctorRepairScope) {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  assertOpenClawStateSchemaRepairAllowed(pathname);
  if (!existsSync(pathname)) {
    return undefined;
  }
  if (scope === "readability") {
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  }
  return { pathname, env };
}
