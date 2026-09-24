import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import {
  runOutsidePluginLifecycleLease,
  withPluginLifecycleLease,
} from "../plugins/plugin-lifecycle-lease.js";
import type { GatewayReloadPlan } from "./config-reload-plan.js";
import type {
  GatewayConfigReloadTransactionOwnership,
  startGatewayConfigReloader,
} from "./config-reload.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

export function isConfigReloadSuperseded(error: unknown): boolean {
  // Only completed rollback preserves the direct cause. Cleanup failures and
  // published replacements must settle instead of transferring the write.
  const cause =
    error instanceof PluginRuntimeApplicationError && !error.details.committed
      ? error.cause
      : error;
  return cause instanceof GatewayConfigReloadSupersededError;
}

export const withRestartPreparation = <T>(
  signal: AbortSignal,
  ownership: GatewayConfigReloadTransactionOwnership,
  checkpointOwned: (assertOwned: () => void) => Promise<void>,
  run: (ownership: GatewayConfigReloadTransactionOwnership) => Promise<T>,
): Promise<T> =>
  runOutsidePluginLifecycleLease(() =>
    withPluginLifecycleLease({ signal }, async (lease) => {
      // Accepted restart work outlives the requesting mutation. Reacquire exclusion
      // while retaining the same source observation and stopped/superseded checks.
      const current = {
        ...ownership,
        assertInvokerOwned: () => lease.assertOwned(),
        checkpoint: () => checkpointOwned(() => lease.assertOwned()),
      };
      await current.checkpoint();
      const result = await run(current);
      await current.checkpoint();
      return result;
    }),
  );

export async function prepareRestart(
  opts: Pick<Parameters<typeof startGatewayConfigReloader>[0], "onRestart" | "log">,
  plan: GatewayReloadPlan,
  nextConfig: OpenClawConfig,
  ownership: GatewayConfigReloadTransactionOwnership,
  sourceConfig: OpenClawConfig,
): Promise<void> {
  try {
    // Every accepted restart candidate validates inside its config
    // transaction. Only downstream signal delivery may coalesce.
    await opts.onRestart(plan, nextConfig, ownership, sourceConfig);
  } catch (err) {
    if (isConfigReloadSuperseded(err)) {
      opts.log.info(`config restart superseded: ${String(err)}`);
    } else {
      opts.log.error(`config restart failed: ${String(err)}`);
    }
    // Failed restart admission must reject the transaction. Otherwise the
    // persisted snapshot becomes the baseline and the same config cannot retry.
    throw err;
  }
}
