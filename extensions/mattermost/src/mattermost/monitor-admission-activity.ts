// Mattermost plugin module wires durable run admission and agent-activity publication.
import path from "node:path";
import type {
  createAgentActivityPublisher,
  AgentActivityRunBinding,
} from "openclaw/plugin-sdk/channel-outbound";
import { registerMattermostActivityRuntime } from "./activity-gateway-runtime.js";
import { createAgentActivityHttpTransport } from "./activity-http-client.js";
import {
  createAgentActivityOutbox,
  type ActivityDeliveryReceipt,
  type ActivityOutboxRecord,
} from "./activity-outbox.js";
import { createAgentActivityRuntime } from "./activity-runtime.js";
import {
  createMattermostAdmissionService,
  type MattermostAdmissionCompletedMetadata,
  type MattermostAdmissionInput,
  type MattermostAdmissionMetadata,
} from "./admission.js";
import { mergeVerifiedMattermostAgentRunProps } from "./agent-run-ref.js";
import { fetchMattermostPost, type MattermostClient } from "./client.js";
import type { MattermostIngressLifecycle, MattermostIngressPost } from "./monitor-ingress.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";

const DEFAULT_ACTIVITY_START_TIMEOUT_MS = 1_500;
const MAX_ACTIVITY_START_TIMEOUT_MS = 15_000;

export type MattermostActivityStartResult =
  | { outcome: "bound"; binding: AgentActivityRunBinding }
  | { outcome: "failed"; error: unknown }
  | { outcome: "timed-out" };

export function resolveActivityStartTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_ACTIVITY_START_TIMEOUT_MS;
  }
  return Math.min(MAX_ACTIVITY_START_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

export async function startMattermostActivityPublisher(params: {
  publisher: ReturnType<typeof createAgentActivityPublisher>;
  timeoutMs: number;
}): Promise<MattermostActivityStartResult> {
  const started = params.publisher.start().then(
    (binding) => ({ outcome: "bound" as const, binding }),
    (error: unknown) => ({ outcome: "failed" as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<MattermostActivityStartResult>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "timed-out" }), params.timeoutMs);
  });
  try {
    return await Promise.race([started, timedOut]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function describeActivityStartFailure(
  result: Exclude<MattermostActivityStartResult, { outcome: "bound" }>,
): string {
  if (result.outcome === "timed-out") {
    return "timeout";
  }
  return result.error instanceof Error ? result.error.name : "unknown-error";
}

type MattermostAdmissionRawSnapshot = {
  post: MattermostIngressPost;
  payload: MattermostEventPayload;
  messageIds?: string[];
};

export type MattermostAdmittedDispatch =
  | {
      kind: "turn";
      runId: string;
      input: MattermostAdmissionInput;
      waitForAdmissionCommit: Promise<void>;
      onRunStarted: (runId: string) => void;
    }
  | {
      kind: "steer";
      runId: string;
      input: MattermostAdmissionInput;
    };

function readMattermostAdmissionRawSnapshot(
  input: MattermostAdmissionInput,
): MattermostAdmissionRawSnapshot {
  // SAFETY: only post and payload are read; both and the ingress-required user id are checked before return.
  const value = input.post as Partial<MattermostAdmissionRawSnapshot>;
  if (!value.post || typeof value.post.user_id !== "string" || !value.payload) {
    throw new Error(`Mattermost admission ${input.inputPostId} is missing its raw snapshot`);
  }
  return {
    post: value.post,
    payload: value.payload,
    ...(Array.isArray(value.messageIds) ? { messageIds: value.messageIds } : {}),
  };
}

export async function mergeCurrentMattermostRunProps(params: {
  client: MattermostClient;
  postId: string;
  expectedChannelId: string;
  expectedRootId?: string;
  nextProps: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const post = await fetchMattermostPost(params.client, params.postId);
  if (!post) {
    throw new Error("Mattermost run post is unavailable");
  }
  return mergeVerifiedMattermostAgentRunProps({
    post,
    expectedPostId: params.postId,
    expectedChannelId: params.expectedChannelId,
    expectedRootId: params.expectedRootId,
    nextProps: params.nextProps,
  });
}

export type MattermostPostHandler = (
  post: MattermostIngressPost,
  payload: MattermostEventPayload,
  turnAdoptionLifecycle?: MattermostIngressLifecycle,
  messageIds?: string[],
  admitted?: MattermostAdmittedDispatch,
) => Promise<void>;

export type MattermostAdmissionActivityWiring = {
  admissionService: ReturnType<typeof createMattermostAdmissionService>;
  activityRuntime: ReturnType<typeof createAgentActivityRuntime>;
  activityOutbox: ReturnType<typeof createAgentActivityOutbox>;
  unregister: () => void;
};

export async function createMattermostAdmissionActivityWiring(params: {
  monitor: MattermostMonitorContext;
  handlePost: MattermostPostHandler;
}): Promise<MattermostAdmissionActivityWiring> {
  const { monitor, handlePost } = params;
  const { account, client, core, botUserId, mediaMaxBytes, runtime, logVerboseMessage } = monitor;
  const services: {
    admission?: ReturnType<typeof createMattermostAdmissionService>;
  } = {};
  const admissionCommitResolvers = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();

  const stateDir = core.state.resolveStateDir();
  const outboxQueue = core.state.openChannelIngressQueue<
    ActivityOutboxRecord,
    unknown,
    ActivityDeliveryReceipt
  >({
    accountId: `${account.accountId}:agent-activity-outbox`,
  });
  const activityOutbox = createAgentActivityOutbox({
    queue: outboxQueue,
    transport: createAgentActivityHttpTransport({ maxAttachmentBytes: mediaMaxBytes }),
    spoolDir: path.join(stateDir, "mattermost", "activity-outbox", account.accountId),
    maxAttachmentBytes: mediaMaxBytes,
    onQuarantine: (eventKey, status) => {
      runtime.error?.(
        `mattermost: quarantined agent activity event ${eventKey} after HTTP ${status}`,
      );
    },
    onRetryableError: (eventKey, error) => {
      logVerboseMessage(
        `mattermost: retaining agent activity event ${eventKey} for retry (${String(error)})`,
      );
    },
  });
  const admissionQueue = core.state.openChannelIngressQueue<
    MattermostAdmissionInput,
    MattermostAdmissionMetadata,
    MattermostAdmissionCompletedMetadata
  >({
    accountId: `${account.accountId}:agent-admission`,
  });
  const activityRuntime = createAgentActivityRuntime({
    readAdmissions: async () => (await services.admission?.snapshotAdmissions()) ?? [],
    writeTerminal: async (terminalRun) => {
      if (!terminalRun.inputPostId || !services.admission) {
        throw new Error(`Mattermost terminal run ${terminalRun.runId} has no durable admission`);
      }
      const updated = await services.admission.markCompleted({
        inputPostId: terminalRun.inputPostId,
        conversationId: terminalRun.conversationId,
        turnId: terminalRun.turnId,
        runId: terminalRun.runId,
        outcome: terminalRun.outcome,
        terminalRun,
      });
      if (!updated) {
        throw new Error(`Mattermost terminal admission is unavailable for ${terminalRun.runId}`);
      }
    },
    readTerminal: async (runId) => {
      const source = await services.admission?.terminalSource(runId);
      return source?.terminal.terminalRun;
    },
  });
  const admissionService = createMattermostAdmissionService({
    queue: admissionQueue,
    activeRunForConversation: (conversationId) =>
      activityRuntime.activeRunForConversation(conversationId),
    fetchMarkerPost: async (markerPostId) => {
      const marker = await fetchMattermostPost(client, markerPostId);
      return {
        id: marker.id,
        user_id: marker.user_id ?? "",
        channel_id: marker.channel_id ?? "",
        ...(marker.root_id ? { root_id: marker.root_id } : {}),
        ...(typeof marker.create_at === "number" ? { create_at: marker.create_at } : {}),
        ...(marker.props ? { props: marker.props } : {}),
      };
    },
    refetchSourceInput: async (source) => {
      const raw = readMattermostAdmissionRawSnapshot(source);
      const sourcePostId = raw.post.id?.trim();
      if (!sourcePostId) {
        return undefined;
      }
      const freshPost = await fetchMattermostPost(client, sourcePostId);
      return {
        ...source,
        post: { ...raw, post: freshPost },
      };
    },
    botUserId,
    dispatchTurn: async ({ input, runId }) => {
      const raw = readMattermostAdmissionRawSnapshot(input);
      let startSettled = false;
      let resolveStarted!: (value: { accepted: boolean; runId: string }) => void;
      let rejectStarted!: (error: Error) => void;
      const started = new Promise<{ accepted: boolean; runId: string }>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });
      let resolveAdmissionCommit!: () => void;
      let rejectAdmissionCommit!: (error: Error) => void;
      const waitForAdmissionCommit = new Promise<void>((resolve, reject) => {
        resolveAdmissionCommit = resolve;
        rejectAdmissionCommit = reject;
      });
      void waitForAdmissionCommit.catch(() => undefined);
      admissionCommitResolvers.set(runId, {
        resolve: resolveAdmissionCommit,
        reject: rejectAdmissionCommit,
      });
      const admitted: MattermostAdmittedDispatch = {
        kind: "turn",
        runId,
        input,
        waitForAdmissionCommit,
        onRunStarted: (actualRunId) => {
          if (actualRunId !== runId) {
            throw new Error(`Mattermost run id changed from ${runId} to ${actualRunId}`);
          }
          if (!startSettled) {
            startSettled = true;
            resolveStarted({ accepted: true, runId });
          }
        },
      };
      void handlePost(raw.post, raw.payload, undefined, raw.messageIds, admitted).then(
        () => {
          if (!startSettled) {
            startSettled = true;
            admissionCommitResolvers.delete(runId);
            rejectStarted(
              new Error(`Mattermost turn ${input.inputPostId} completed before runner start`),
            );
          }
        },
        (error: unknown) => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          if (!startSettled) {
            startSettled = true;
            admissionCommitResolvers.delete(runId);
            rejectStarted(normalized);
            return;
          }
          runtime.error?.(
            `mattermost: admitted run ${runId} failed after start: ${normalized.message}`,
          );
        },
      );
      return await started;
    },
    dispatchSteer: async ({ input, runId }) => {
      const raw = readMattermostAdmissionRawSnapshot(input);
      await handlePost(raw.post, raw.payload, undefined, raw.messageIds, {
        kind: "steer",
        runId,
        input,
      });
      return { accepted: true };
    },
    onTurnStarted: (_input, runId) => {
      const deferred = admissionCommitResolvers.get(runId);
      admissionCommitResolvers.delete(runId);
      deferred?.resolve();
    },
    onTurnStartFailed: (_input, runId, error) => {
      const deferred = admissionCommitResolvers.get(runId);
      admissionCommitResolvers.delete(runId);
      deferred?.reject(error);
    },
    onDrainError: (error) => {
      runtime.error?.(`mattermost: durable admission drain failed: ${String(error)}`);
    },
  });
  services.admission = admissionService;
  await activityOutbox.drain();
  await admissionService.drain();
  const unregister = registerMattermostActivityRuntime(account.accountId, {
    admission: admissionService,
    activity: activityRuntime,
  });
  return { admissionService, activityRuntime, activityOutbox, unregister };
}
