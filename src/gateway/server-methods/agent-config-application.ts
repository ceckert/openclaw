import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../../config/runtime-write-application.js";
import { redactToolDetail } from "../../logging/redact.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../../process/gateway-work-admission.js";
import type { RespondFn } from "./types.js";

export function createAgentConfigApplication(respond: RespondFn) {
  const application = createRuntimeConfigWriteApplication(
    captureGatewayRootWorkAdmissionContinuationScope()?.run,
  );
  return {
    attach: <T extends object>(options: T) =>
      attachRuntimeConfigWriteApplication(options, application),
    confirm: async (onUnconfirmed?: (message: string) => void) => {
      const outcome = application.claimed ? await application.result : "unclaimed";
      if (outcome === "applied") {
        return true;
      }
      // A busy plugin reload holds every saved change, including ones that need no reload.
      // The reloader retries on its own, so name the wait instead of asking for a restart.
      let failure;
      if (typeof outcome === "object") {
        const deferred = {
          ...outcome,
          reason: redactToolDetail(outcome.reason),
          appliesWhen: redactToolDetail(outcome.appliesWhen),
        };
        failure = errorShape(
          ErrorCodes.UNAVAILABLE,
          `Agent configuration saved but deferred: ${deferred.reason} ${deferred.appliesWhen}`,
          { details: { application: deferred } },
        );
      } else {
        failure = errorShape(
          ErrorCodes.UNAVAILABLE,
          `Agent configuration was saved but its application to the active Gateway was not confirmed (${outcome}); run config.get, then apply the saved config or restart the Gateway.`,
        );
      }
      if (onUnconfirmed) {
        onUnconfirmed(failure.message);
      } else {
        respond(false, undefined, failure);
      }
      return false;
    },
  };
}
