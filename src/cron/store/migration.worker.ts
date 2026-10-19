import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { executeCronMigrationInDatabase } from "./migration.kernel.js";

export function executeCronMigrationInWorker(
  database: OpenClawStateDatabase,
  input: import("./runtime-worker.types.js").CronRuntimeWorkerOperations["cron.migration"]["input"],
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const result = executeCronMigrationInDatabase(
        db,
        input.storeKey,
        input.request,
        input.defaultAgentId,
      );
      return { outcome: result };
    },
    { database, env: getSqliteWorkerStateContext().environment },
    { operationLabel: `cron.migration.${input.request.phase}` },
  );
}
