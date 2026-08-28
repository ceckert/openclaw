import type { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { buildMattermostAgentRunProps, type MattermostAgentRunRefV3 } from "./agent-run-ref.js";
import type { MattermostPost } from "./client.js";
import { createMattermostDraftStream } from "./draft-stream.js";
import type { MattermostAdmittedDispatch } from "./monitor-admission-activity.js";
import type { MattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostIngressLifecycle } from "./monitor-ingress.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { HistoryEntry } from "./runtime-api.js";

export type MattermostInboundTurnParams = {
  post: MattermostPost;
  rawText: string;
  ctxPayload: ReturnType<typeof finalizeInboundContext>;
  eventPlan: MattermostEventPlan;
  historyKey: string | null;
  historyLimit: number;
  channelHistories: Map<string, HistoryEntry[]>;
  pinnedMainDmOwner: string | null;
  turnAdoptionLifecycle?: MattermostIngressLifecycle;
  admitted?: MattermostAdmittedDispatch;
  sessionKey: string;
};

export function createDisabledMattermostDraftStream(): ReturnType<
  typeof createMattermostDraftStream
> {
  const noopAsync = async () => {};
  return {
    update: () => {},
    updateAssistantText: () => {},
    flush: noopAsync,
    postId: () => undefined,
    clear: noopAsync,
    discardPending: noopAsync,
    seal: noopAsync,
    stop: noopAsync,
    forceNewMessage: noopAsync,
    settleBoundaries: noopAsync,
    resolveFinalText: (text) => ({ kind: "full", text, publishedParts: [] }),
  };
}

type MattermostTurnActivity = {
  agentRunRef?: MattermostAgentRunRefV3;
  agentRunProps?: Record<string, unknown>;
};

export async function createMattermostTurnActivity(params: {
  monitor: MattermostMonitorContext;
  admitted?: MattermostAdmittedDispatch;
  agentId: string;
  sessionKey: string;
  channelId: string;
}): Promise<MattermostTurnActivity> {
  const { monitor, admitted } = params;
  const { activityRuntime } = monitor;
  if (admitted?.kind !== "turn" || !activityRuntime) {
    return {};
  }

  const { input, runId } = admitted;
  const origin = input.origin ?? "human";
  activityRuntime.startRun({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    conversationId: params.channelId,
    turnId: input.turnId,
    runId,
    ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
    origin,
    mainChannelId: params.channelId,
    mainRootPostId: input.turnId,
    inputPostId: input.inputPostId,
    startedAt: Date.now(),
    status: "running",
    live: { phase: "starting", elapsedMs: 0 },
  });
  const agentRunRef: MattermostAgentRunRefV3 = {
    schemaVersion: 3,
    projectionKind: "run",
    conversationId: params.channelId,
    turnId: input.turnId,
    runId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
    origin,
    status: "running",
    mainChannelId: params.channelId,
    mainRootPostId: input.turnId,
    inputPostId: input.inputPostId,
    activityChannelId: params.channelId,
    activityRootPostId: input.turnId,
    attention: "routine",
  };
  return {
    agentRunRef,
    agentRunProps: buildMattermostAgentRunProps(agentRunRef),
  };
}
