import { copyAgentRunObservationContext } from "../../infra/agent-run-observation-context.js";
import type { QueuedReplyPayloadSendingHook } from "../../infra/outbound/delivery-queue-types.js";
import type {
  DispatchCronDeliveryParams,
  SuccessfulCronDeliveryTarget,
} from "./delivery-dispatch-types.js";

type CronDeliveryReplyHookParams = Pick<
  DispatchCronDeliveryParams,
  "agentId" | "runSessionKey" | "lifecycleRevision" | "runObservation"
>;

type CronDeliveryReplyHookTarget = Pick<
  SuccessfulCronDeliveryTarget,
  "channel" | "accountId" | "to"
>;

export function buildCronDeliveryReplyPayloadSendingHook(
  params: CronDeliveryReplyHookParams,
  delivery: CronDeliveryReplyHookTarget,
): QueuedReplyPayloadSendingHook {
  return {
    kind: "final",
    channel: delivery.channel,
    sessionKey: params.runSessionKey,
    runId: params.lifecycleRevision,
    context: {
      channelId: delivery.channel,
      agentId: params.agentId,
      ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
      conversationId: delivery.to,
      sessionKey: params.runSessionKey,
      runId: params.lifecycleRevision,
      run: copyAgentRunObservationContext(params.runObservation),
    },
  };
}
