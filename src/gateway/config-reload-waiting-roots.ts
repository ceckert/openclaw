import type { RuntimeConfigWriteApplicationClaim } from "../config/runtime-write-application.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  createGatewayReloadWaitingRootScope,
  runOutsideGatewayRootWorkAdmission,
  runWithGatewayReloadWaitingRoot,
} from "../process/gateway-work-admission.js";

export function createConfigReloadWaitingRoots() {
  const scope = createGatewayReloadWaitingRootScope();
  return {
    include(application: RuntimeConfigWriteApplicationClaim | null | undefined) {
      if (!application?.withWaitingRoot) {
        return;
      }
      const release = application.withWaitingRoot(scope.includeCurrent);
      const settle = application.settle;
      application.settle = (status) => {
        release();
        settle(status);
      };
    },
    run<T>(run: () => Promise<T>, applications: readonly RuntimeConfigWriteApplicationClaim[]) {
      const invoke =
        captureGatewayRootWorkAdmissionContinuationScope()?.run ??
        runOutsideGatewayRootWorkAdmission;
      let transaction = () => invoke(run);
      for (const application of applications) {
        const continuation = application.runTransaction;
        if (continuation) {
          const next = transaction;
          transaction = () => continuation(() => runWithGatewayReloadWaitingRoot(next));
        }
      }
      return scope.run(transaction);
    },
  };
}
