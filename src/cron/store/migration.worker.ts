import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { executeCronMigrationInDatabase } from "./migration.kernel.js";
import {
  prepareCronRuntimeMutation,
  retainCronRuntimeMutationOutcome,
} from "./runtime-mutation.worker.js";

export function executeCronMigrationInWorker(
  database: OpenClawStateDatabase,
  input: import("./runtime-worker.types.js").CronRuntimeWorkerOperations["cron.migration"]["input"],
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      prepareCronRuntimeMutation("cron.migration", input.nonce, {});
      const result = executeCronMigrationInDatabase(db, input.storeKey, input.request);
      return retainCronRuntimeMutationOutcome("cron.migration", db, input.nonce, result);
    },
    { database, env: getSqliteWorkerStateContext().environment },
    { operationLabel: `cron.migration.${input.request.phase}` },
  );
}
