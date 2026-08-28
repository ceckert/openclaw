export type AgentRunOrigin = "human" | "followup" | "retry" | "scheduled" | "subagent";

export type AgentRunScheduledDelivery = Readonly<
  | {
      kind: "chat";
      channel: string;
      to: string;
      accountId?: string;
      threadId?: string | number;
    }
  | {
      kind: "none" | "webhook" | "invalid";
      channel?: string;
      accountId?: string;
      threadId?: string | number;
    }
>;

export type AgentRunScheduledObservation = Readonly<{
  invocationId: string;
  delivery: AgentRunScheduledDelivery;
}>;

export function createScheduledRunObservation(params: {
  invocationId: string;
  deliveryMode: "announce" | "webhook" | "none";
  resolvedDelivery: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  resolvedDeliveryOk: boolean;
}): AgentRunScheduledObservation {
  const { resolvedDelivery } = params;
  if (params.deliveryMode === "none") {
    return { invocationId: params.invocationId, delivery: { kind: "none" } };
  }
  if (params.deliveryMode === "webhook") {
    return { invocationId: params.invocationId, delivery: { kind: "webhook" } };
  }
  if (params.resolvedDeliveryOk && resolvedDelivery.channel && resolvedDelivery.to) {
    return {
      invocationId: params.invocationId,
      delivery: {
        kind: "chat",
        channel: resolvedDelivery.channel,
        to: resolvedDelivery.to,
        ...(resolvedDelivery.accountId ? { accountId: resolvedDelivery.accountId } : {}),
        ...(resolvedDelivery.threadId !== undefined ? { threadId: resolvedDelivery.threadId } : {}),
      },
    };
  }
  return {
    invocationId: params.invocationId,
    delivery: {
      kind: "invalid",
      ...(resolvedDelivery.channel ? { channel: resolvedDelivery.channel } : {}),
      ...(resolvedDelivery.accountId ? { accountId: resolvedDelivery.accountId } : {}),
      ...(resolvedDelivery.threadId !== undefined ? { threadId: resolvedDelivery.threadId } : {}),
    },
  };
}

export type AgentRunObservationContext = Readonly<{
  origin: AgentRunOrigin;
  parentRunId?: string;
  retryOfRunId?: string;
  scheduled?: AgentRunScheduledObservation;
}>;

export function copyAgentRunObservationContext(
  observation: AgentRunObservationContext,
): AgentRunObservationContext {
  const scheduled = observation.scheduled
    ? Object.freeze({
        ...observation.scheduled,
        delivery: Object.freeze({ ...observation.scheduled.delivery }),
      })
    : undefined;
  return Object.freeze({
    ...observation,
    ...(scheduled ? { scheduled } : {}),
  });
}
