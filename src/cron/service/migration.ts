import { hasActiveCronJobsForAgent } from "../active-jobs.js";
import { runCronMigration } from "../migration.js";
import type { CronMigrationRequest } from "../migration.types.js";
import { getSuspensionVisibleCronTaskRunCount } from "./active-run-cancellation.js";
import { hasPendingCronSessionCleanupForAgent, locked } from "./locked.js";
import type { CronServiceState } from "./state.js";
import { ensureLoaded } from "./store.js";
import { armTimer } from "./timer.js";

export async function migrateCronAgents(
  state: CronServiceState,
  request: CronMigrationRequest,
  assertCurrent?: () => void,
) {
  return await locked(state, async () => {
    if (request.phase === "export") {
      const held = await runCronMigration(
        state.deps.storePath,
        { ...request, phase: "hold" },
        assertCurrent,
      );
      if (
        held.agentIds.some(
          (agentId) =>
            hasActiveCronJobsForAgent(agentId) ||
            getSuspensionVisibleCronTaskRunCount({ agentId }) > 0 ||
            hasPendingCronSessionCleanupForAgent(agentId),
        )
      ) {
        return { ...held, phase: request.phase, drained: false };
      }
    }
    const result = await runCronMigration(state.deps.storePath, request, assertCurrent);
    await ensureLoaded(state, { forceReload: true });
    armTimer(state);
    if (
      request.phase === "hold" &&
      result.agentIds.some(
        (agentId) =>
          hasActiveCronJobsForAgent(agentId) ||
          getSuspensionVisibleCronTaskRunCount({ agentId }) > 0 ||
          hasPendingCronSessionCleanupForAgent(agentId),
      )
    ) {
      return { ...result, drained: false };
    }
    return result;
  });
}
