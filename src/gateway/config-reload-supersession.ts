import {
  runOutsidePluginLifecycleLease,
  withPluginLifecycleLease,
} from "../plugins/plugin-lifecycle-lease.js";
import type { GatewayConfigReloadTransactionOwnership } from "./config-reload.types.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

export function createReloadRestartPreparation(signal: AbortSignal) {
  return <T>(
    ownership: GatewayConfigReloadTransactionOwnership,
    checkpointOwned: (assertOwned: () => void) => Promise<void>,
    run: (ownership: GatewayConfigReloadTransactionOwnership) => Promise<T>,
  ): Promise<T> =>
    runOutsidePluginLifecycleLease(() =>
      withPluginLifecycleLease({ signal, processBound: true }, async (lease) => {
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
}

export type ReloadTransactionSupersession = {
  /** Aborts once a newer config source provably supersedes the transaction. */
  signal: AbortSignal;
  arm(superseded: () => boolean): void;
};

/** The newest transaction alone observes supersession; a finished one stops observing. */
export function createReloadSupersessionTracker() {
  let current: (() => void) | undefined;
  return {
    observe: () => current?.(),
    async run<T>(
      lifecycle: AbortSignal,
      transaction: (supersession: ReloadTransactionSupersession) => Promise<T>,
    ): Promise<T> {
      const controller = new AbortController();
      let superseded: (() => boolean) | undefined;
      const observe = () => {
        if (!controller.signal.aborted && superseded?.()) {
          controller.abort(new GatewayConfigReloadSupersededError());
        }
      };
      current = observe;
      try {
        return await transaction({
          signal: AbortSignal.any([controller.signal, lifecycle]),
          arm: (check) => {
            superseded = check;
          },
        });
      } finally {
        if (current === observe) {
          current = undefined;
        }
      }
    },
  };
}
