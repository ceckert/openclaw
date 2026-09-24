import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { CronMigrationRequest, CronMigrationResult } from "./migration.types.js";
import { runCronRuntimeMutation } from "./service/runtime-mutation.js";
import { noteCronJobsStoreCommit } from "./store.js";
import { cronStoreKey } from "./store/key.js";

export async function runCronMigration(
  storePath: string,
  request: CronMigrationRequest,
  assertCurrent: () => void = () => {},
  defaultAgentId?: string,
) {
  const storeKey = cronStoreKey(storePath);
  let result: CronMigrationResult | undefined;
  await runCronRuntimeMutation({
    context: captureOpenClawStateWorkerContext(),
    type: "cron.migration",
    input: { storeKey, request, ...(defaultAgentId ? { defaultAgentId } : {}) },
    assertCurrent,
    prepare: () => ({ value: {}, assertCurrent }),
    publish: (outcome) => {
      result = outcome;
      noteCronJobsStoreCommit(storeKey);
    },
  });
  if (!result) {
    throw new Error("Cron migration has no committed outcome");
  }
  return result;
}
