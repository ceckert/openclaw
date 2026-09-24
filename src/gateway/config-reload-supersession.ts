import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

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
