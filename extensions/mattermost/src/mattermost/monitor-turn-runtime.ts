import {
  createAgentActivityPublisher,
  type AgentActivityRunBinding,
} from "openclaw/plugin-sdk/channel-outbound";
import type { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { buildMattermostAgentRunProps, type MattermostAgentRunRefV3 } from "./agent-run-ref.js";
import type { MattermostPost } from "./client.js";
import { createMattermostDraftStream } from "./draft-stream.js";
import {
  describeActivityStartFailure,
  resolveActivityStartTimeoutMs,
  startMattermostActivityPublisher,
  type MattermostAdmittedDispatch,
} from "./monitor-admission-activity.js";
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
  activityBinding?: AgentActivityRunBinding;
  activityPublisher?: ReturnType<typeof createAgentActivityPublisher>;
  deferredActivityPublisher?: ReturnType<typeof createAgentActivityPublisher>;
  agentRunRef?: MattermostAgentRunRefV3;
  agentRunProps?: Record<string, unknown>;
  reportActivityPublicationFailure: (stage: string, error: unknown) => void;
};

export async function createMattermostTurnActivity(params: {
  monitor: MattermostMonitorContext;
  admitted?: MattermostAdmittedDispatch;
  agentId: string;
  sessionKey: string;
  channelId: string;
  mainRootPostId: string;
}): Promise<MattermostTurnActivity> {
  const { monitor, admitted } = params;
  const { activityRuntime, activityOutbox, mediaMaxBytes, runtime } = monitor;
  let publicationFailureReported = false;
  const reportActivityPublicationFailure = (stage: string, error: unknown): void => {
    if (publicationFailureReported) {
      return;
    }
    publicationFailureReported = true;
    const reason = error instanceof Error ? error.name : "unknown-error";
    runtime.error?.(
      `mattermost: agent Activity ${stage} failed for run ${admitted?.runId ?? "unknown"} (${reason})`,
    );
  };
  if (admitted?.kind !== "turn" || !activityRuntime) {
    return { reportActivityPublicationFailure };
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
    mainRootPostId: params.mainRootPostId,
    inputPostId: input.inputPostId,
    startedAt: Date.now(),
    status: "running",
    live: { phase: "starting", elapsedMs: 0 },
  });
  const bindActivity = (
    activityBinding: AgentActivityRunBinding,
    activityPublisher?: ReturnType<typeof createAgentActivityPublisher>,
  ): MattermostTurnActivity => {
    activityRuntime.bindRunActivity(runId, activityBinding);
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
      mainRootPostId: params.mainRootPostId,
      inputPostId: input.inputPostId,
      activityChannelId: activityBinding.activityChannelId,
      activityRootPostId: activityBinding.activityRootPostId,
      attention: "routine",
    };
    return {
      activityBinding,
      ...(activityPublisher ? { activityPublisher } : {}),
      agentRunRef,
      agentRunProps: buildMattermostAgentRunProps(agentRunRef),
      reportActivityPublicationFailure,
    };
  };
  if (!monitor.nativeActivityPublishingEnabled) {
    return bindActivity({
      activityChannelId: params.channelId,
      activityRootPostId: params.mainRootPostId,
    });
  }
  if (!activityOutbox) {
    return { reportActivityPublicationFailure };
  }
  const publisher = createAgentActivityPublisher({
    ref: {
      conversationId: params.channelId,
      turnId: input.turnId,
      runId,
      ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      origin,
      mainChannelId: params.channelId,
      mainRootPostId: params.mainRootPostId,
      inputPostId: input.inputPostId,
    },
    sink: activityOutbox,
    maxAttachmentBytes: mediaMaxBytes,
  });
  const activityStart = await startMattermostActivityPublisher({
    publisher,
    timeoutMs: resolveActivityStartTimeoutMs(monitor.activityStartTimeoutMs),
  });
  if (activityStart.outcome !== "bound") {
    runtime.error?.(
      `mattermost: agent Activity start ${describeActivityStartFailure(activityStart)} for run ${runId}; continuing in legacy mode`,
    );
    return {
      deferredActivityPublisher: publisher,
      reportActivityPublicationFailure,
    };
  }

  return bindActivity(activityStart.binding, publisher);
}
