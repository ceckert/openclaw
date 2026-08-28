import { randomUUID } from "node:crypto";
import type {
  AgentActivitySnapshotAdmission,
  AgentActivityTerminalRun,
} from "./activity-runtime.js";
import { classifyMattermostAdmission } from "./admission-policy.js";
import type {
  AdmissionQueueClaim,
  AdmissionQueueEntry,
  AdmissionQueueInspection,
  MattermostAdmissionActiveRun,
  MattermostAdmissionInput,
  MattermostAdmissionMetadata,
  MattermostAdmissionQueue,
  MattermostIngressRetryResult,
  MattermostIngressState,
  MattermostIngressStatusResult,
  MattermostRetryMarkerPost,
} from "./admission-types.js";
export type {
  MattermostAdmissionCompletedMetadata,
  MattermostAdmissionInput,
  MattermostAdmissionMetadata,
  MattermostAdmissionPolicy,
  MattermostAdmissionQueue,
  MattermostIngressRetryResult,
  MattermostIngressStatusResult,
  MattermostRetryMarkerPost,
} from "./admission-types.js";

const ADMISSION_RETRY_BASE_MS = 250;
const ADMISSION_RETRY_MAX_MS = 30_000;
const RETRY_MARKER_KEYS = [
  "actorMmUserId",
  "agentId",
  "controlId",
  "conversationId",
  "createEventKey",
  "eventKey",
  "kind",
  "mainChannelId",
  "mainRootPostId",
  "origin",
  "retryOfRunId",
  "sessionKey",
  "sourceInputPostId",
  "turnId",
] as const;
const RETRY_MARKER_DIGEST_RE = /^[a-f0-9]{64}$/;
const RETRY_MARKER_CONTROL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;

function statusFromInspection(
  inspection: AdmissionQueueInspection,
): MattermostIngressStatusResult | null {
  const completed = inspection.completedMetadata;
  const metadata = inspection.metadata;
  const conversationId = completed?.conversationId ?? metadata?.conversationId;
  const turnId = completed?.turnId ?? metadata?.turnId;
  if (!conversationId || !turnId) {
    return null;
  }
  const state: MattermostIngressState =
    inspection.status === "completed" ? (completed?.state ?? "completed") : inspection.status;
  return {
    inputPostId: inspection.id,
    conversationId,
    turnId,
    state,
    revision: inspection.revision,
    ...(completed?.runId ? { runId: completed.runId } : {}),
  };
}

function pendingMetadataMatches(
  left: MattermostAdmissionMetadata,
  right: MattermostAdmissionMetadata,
): boolean {
  return (
    left.policy === right.policy &&
    left.state === right.state &&
    left.conversationId === right.conversationId &&
    left.turnId === right.turnId &&
    left.targetRunId === right.targetRunId &&
    left.queuePosition === right.queuePosition
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function markerCorrelation(marker: MattermostRetryMarkerPost): Record<string, unknown> | undefined {
  const correlation = marker.props?.octogee;
  return isUnknownRecord(correlation) ? correlation : undefined;
}

function assertRetryMarker(params: {
  marker: MattermostRetryMarkerPost;
  botUserId: string;
  source: MattermostAdmissionInput;
  terminalRun: AgentActivityTerminalRun;
  failedRunId: string;
  actorMmUserId: string;
}): void {
  const correlation = markerCorrelation(params.marker);
  const expected = {
    kind: "chat.retry-marker",
    origin: "retry",
    conversationId: params.source.conversationId,
    turnId: params.source.turnId,
    retryOfRunId: params.failedRunId,
    agentId: params.terminalRun.agentId,
    sessionKey: params.terminalRun.sessionKey,
    mainChannelId: params.terminalRun.mainChannelId,
    mainRootPostId: params.terminalRun.mainRootPostId,
    actorMmUserId: params.actorMmUserId,
    sourceInputPostId: params.source.inputPostId,
  };
  const expectedEntries = Object.entries(expected);
  if (
    params.marker.user_id !== params.botUserId ||
    params.marker.channel_id !== params.terminalRun.mainChannelId ||
    params.marker.root_id !== params.terminalRun.mainRootPostId ||
    params.terminalRun.runId !== params.failedRunId ||
    params.terminalRun.conversationId !== params.source.conversationId ||
    params.terminalRun.turnId !== params.source.turnId ||
    params.terminalRun.mainChannelId !== params.source.channelId ||
    (params.terminalRun.inputPostId !== undefined &&
      params.terminalRun.inputPostId !== params.source.inputPostId) ||
    !correlation ||
    JSON.stringify(Object.keys(correlation).toSorted()) !== JSON.stringify(RETRY_MARKER_KEYS) ||
    typeof correlation.eventKey !== "string" ||
    !RETRY_MARKER_DIGEST_RE.test(correlation.eventKey) ||
    typeof correlation.createEventKey !== "string" ||
    !RETRY_MARKER_DIGEST_RE.test(correlation.createEventKey) ||
    typeof correlation.controlId !== "string" ||
    !RETRY_MARKER_CONTROL_ID_RE.test(correlation.controlId) ||
    expectedEntries.some(([key, value]) => correlation[key] !== value)
  ) {
    throw new Error("Mattermost retry marker failed authoritative correlation");
  }
}

export function createMattermostAdmissionService(params: {
  queue: MattermostAdmissionQueue;
  maxPending?: number;
  staleClaimMs?: number;
  ownerId?: string;
  now?: () => number;
  scheduleRetry?: (callback: () => void, delayMs: number) => void;
  activeRunForConversation?: (
    conversationId: string,
  ) => Promise<MattermostAdmissionActiveRun | undefined> | MattermostAdmissionActiveRun | undefined;
  dispatchSteer?: (params: {
    input: MattermostAdmissionInput;
    runId: string;
    idempotencyKey: string;
  }) => Promise<{ accepted: boolean }>;
  dispatchTurn?: (params: {
    input: MattermostAdmissionInput;
    idempotencyKey: string;
    runId: string;
    queueModeOverride: "followup";
  }) => Promise<{ accepted: boolean; runId?: string }>;
  onTurnStarted?: (input: MattermostAdmissionInput, runId: string) => Promise<void> | void;
  onTurnStartFailed?: (
    input: MattermostAdmissionInput,
    runId: string,
    error: Error,
  ) => Promise<void> | void;
  fetchMarkerPost?: (markerPostId: string) => Promise<MattermostRetryMarkerPost | undefined>;
  refetchSourceInput?: (
    source: MattermostAdmissionInput,
  ) => Promise<MattermostAdmissionInput | undefined>;
  botUserId?: string;
  onDrainError?: (error: unknown) => void;
}) {
  const maxPending = Math.max(1, Math.floor(params.maxPending ?? 100));
  const staleClaimMs = Math.max(0, Math.floor(params.staleClaimMs ?? 60_000));
  const ownerId = params.ownerId ?? `mattermost-admission-${process.pid}`;
  const now = params.now ?? Date.now;
  let activeDrain: Promise<void> | undefined;
  let staleRecoveryScheduled = false;
  let dispatchRetryScheduled = false;

  const activeRunForConversation = async (conversationId: string) =>
    await params.activeRunForConversation?.(conversationId);

  const scheduleStaleRecovery = (claims: AdmissionQueueClaim[]): void => {
    if (staleRecoveryScheduled || claims.length === 0) {
      return;
    }
    staleRecoveryScheduled = true;
    const currentTime = now();
    const delayMs = Math.max(
      1,
      Math.min(
        ...claims.map((claim) =>
          claim.claim.claimedAt === undefined
            ? staleClaimMs
            : staleClaimMs - Math.max(0, currentTime - claim.claim.claimedAt),
        ),
      ),
    );
    const callback = () => {
      staleRecoveryScheduled = false;
      scheduleDrain();
    };
    if (params.scheduleRetry) {
      params.scheduleRetry(callback, delayMs);
      return;
    }
    const timer = setTimeout(callback, delayMs);
    timer.unref();
  };

  const scheduleDispatchRetry = (attempts: number): void => {
    if (dispatchRetryScheduled) {
      return;
    }
    dispatchRetryScheduled = true;
    const delayMs = Math.min(
      ADMISSION_RETRY_MAX_MS,
      ADMISSION_RETRY_BASE_MS * 2 ** Math.min(attempts, 16),
    );
    const callback = () => {
      dispatchRetryScheduled = false;
      scheduleDrain();
    };
    if (params.scheduleRetry) {
      params.scheduleRetry(callback, delayMs);
      return;
    }
    const timer = setTimeout(callback, delayMs);
    timer.unref();
  };

  const acceptSteer = async (claim: AdmissionQueueClaim, runId: string): Promise<void> => {
    if (!params.dispatchSteer) {
      throw new Error("Mattermost steer dispatcher is unavailable");
    }
    try {
      const accepted = await params.dispatchSteer({
        input: claim.payload,
        runId,
        idempotencyKey: claim.id,
      });
      if (!accepted.accepted) {
        throw new Error(`Mattermost steer was not accepted for ${claim.id}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await params.queue.release(claim, { lastError: message });
      scheduleDispatchRetry(claim.attempts);
      throw error;
    }
    const completed = await params.queue.complete(claim, {
      retainPayload: true,
      metadata: {
        state: "completed",
        conversationId: claim.payload.conversationId,
        turnId: claim.payload.turnId,
        runId,
      },
    });
    if (!completed) {
      throw new Error(`Mattermost steer lost claim ownership for ${claim.id}`);
    }
  };

  const normalizeCapacity = async (): Promise<AdmissionQueueEntry[]> => {
    const pending = await params.queue.listPending({ limit: "all" });
    const positions = new Map<string, number>();
    for (const entry of pending) {
      const metadata = entry.metadata;
      if (!metadata || metadata.policy === "steer") {
        continue;
      }
      const position = (positions.get(metadata.conversationId) ?? 0) + 1;
      positions.set(metadata.conversationId, position);
      const state: MattermostAdmissionMetadata["state"] =
        position > maxPending ? "blocked" : "queued";
      const desired: MattermostAdmissionMetadata = { ...metadata, state, queuePosition: position };
      if (!pendingMetadataMatches(metadata, desired)) {
        const updated = await params.queue.annotatePending(entry.id, desired);
        if (updated?.metadata) {
          entry.metadata = updated.metadata;
        }
      }
    }
    return pending;
  };

  const runDrain = async (): Promise<void> => {
    await params.queue.recoverStaleClaims({ staleMs: staleClaimMs });
    const startedConversations = new Set<string>();
    while (params.dispatchTurn || params.dispatchSteer) {
      const pending = await normalizeCapacity();
      const claims = await params.queue.listClaims();
      const pendingSteer = pending.find((entry) => entry.metadata?.policy === "steer");
      if (pendingSteer?.payload && pendingSteer.metadata) {
        const activeRun = await activeRunForConversation(pendingSteer.payload.conversationId);
        if (
          activeRun &&
          activeRun.runId === pendingSteer.metadata.targetRunId &&
          params.dispatchSteer
        ) {
          const claim = await params.queue.claim(pendingSteer.id, { ownerId });
          if (!claim) {
            continue;
          }
          try {
            await acceptSteer(claim, activeRun.runId);
          } catch {
            return;
          }
          continue;
        }
        if (!params.dispatchTurn) {
          return;
        }
        await params.queue.annotatePending(pendingSteer.id, {
          ...pendingSteer.metadata,
          policy: "followup",
          state: "queued",
          targetRunId: undefined,
          queuePosition: undefined,
        });
        continue;
      }
      if (!params.dispatchTurn) {
        scheduleStaleRecovery(claims);
        return;
      }
      const blockedLaneKeys = new Set(
        claims.map((claim) => claim.payload.conversationId).filter(Boolean),
      );
      const candidates: string[] = [];
      for (const entry of pending) {
        const input = entry.payload;
        const metadata = entry.metadata;
        if (!input || !metadata || metadata.policy === "steer" || metadata.state === "blocked") {
          continue;
        }
        if (
          startedConversations.has(input.conversationId) ||
          blockedLaneKeys.has(input.conversationId) ||
          (await activeRunForConversation(input.conversationId))
        ) {
          blockedLaneKeys.add(input.conversationId);
          continue;
        }
        candidates.push(entry.id);
      }
      if (candidates.length === 0) {
        scheduleStaleRecovery(claims);
        return;
      }
      const claim = await params.queue.claimNext({
        ownerId,
        blockedLaneKeys,
        candidateIds: candidates,
      });
      if (!claim) {
        scheduleStaleRecovery(claims);
        return;
      }
      const runId = claim.payload.plannedRunId;
      if (!runId) {
        await params.queue.fail(claim, {
          reason: "invalid-admission",
          message: "Mattermost admission has no planned run id",
        });
        continue;
      }
      let accepted: { accepted: boolean; runId?: string };
      try {
        accepted = await params.dispatchTurn({
          input: claim.payload,
          idempotencyKey: claim.id,
          runId,
          queueModeOverride: "followup",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await params.queue.release(claim, { lastError: message });
        scheduleDispatchRetry(claim.attempts);
        return;
      }
      if (!accepted.accepted || accepted.runId !== runId) {
        await params.queue.release(claim, {
          lastError: "Mattermost turn dispatcher did not accept the planned run id",
        });
        scheduleDispatchRetry(claim.attempts);
        return;
      }
      const completed = await params.queue
        .complete(claim, {
          retainPayload: true,
          metadata: {
            state: "started",
            conversationId: claim.payload.conversationId,
            turnId: claim.payload.turnId,
            runId,
          },
        })
        .catch(async (error: unknown) => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          await params.onTurnStartFailed?.(claim.payload, runId, normalized);
          throw normalized;
        });
      if (!completed) {
        const error = new Error(`Mattermost admission lost claim ownership for ${claim.id}`);
        await params.onTurnStartFailed?.(claim.payload, runId, error);
        throw error;
      }
      await params.onTurnStarted?.(claim.payload, runId);
      startedConversations.add(claim.payload.conversationId);
    }
  };

  const drain = (): Promise<void> => {
    activeDrain ??= runDrain().finally(() => {
      activeDrain = undefined;
    });
    return activeDrain;
  };

  const scheduleDrain = (): void => {
    void drain().catch((error: unknown) => {
      params.onDrainError?.(error);
    });
  };

  const admit = async (
    input: MattermostAdmissionInput,
    activeRun?: MattermostAdmissionActiveRun,
  ) => {
    const policy = classifyMattermostAdmission({ input, activeRun });
    const admittedInput: MattermostAdmissionInput = {
      ...input,
      origin: input.origin ?? (policy === "followup" ? "followup" : "human"),
      plannedRunId: input.plannedRunId ?? randomUUID(),
    };
    const [pending, claims] = await Promise.all([
      params.queue.listPending({ limit: "all" }),
      params.queue.listClaims(),
    ]);
    const inConversation = [...pending, ...claims].filter(
      (entry) =>
        entry.payload?.conversationId === input.conversationId &&
        entry.metadata?.policy !== "steer",
    ).length;
    const queuePosition = inConversation + 1;
    const blocked = policy !== "steer" && queuePosition > maxPending;
    const metadata: MattermostAdmissionMetadata = {
      policy,
      state: blocked ? "blocked" : policy === "steer" ? "received" : "queued",
      revision: 1,
      conversationId: input.conversationId,
      turnId: input.turnId,
      ...(policy === "steer" && activeRun ? { targetRunId: activeRun.runId } : {}),
      ...(policy === "steer" ? {} : { queuePosition }),
    };
    const enqueued = await params.queue.enqueue(input.inputPostId, admittedInput, {
      laneKey: input.conversationId,
      metadata,
      receivedAt: input.receivedAt,
    });
    if (enqueued.duplicate) {
      if (params.dispatchTurn || params.dispatchSteer) {
        scheduleDrain();
      }
      return { outcome: "duplicate" as const, inputPostId: input.inputPostId, queuePosition };
    }
    if (blocked) {
      return { outcome: "blocked" as const, inputPostId: input.inputPostId, queuePosition };
    }
    if (policy === "steer" && activeRun) {
      if (!params.dispatchSteer) {
        throw new Error("Mattermost steer dispatcher is unavailable");
      }
      const claim = await params.queue.claim(input.inputPostId, { ownerId });
      if (!claim) {
        return { outcome: "duplicate" as const, inputPostId: input.inputPostId, queuePosition };
      }
      await acceptSteer(claim, activeRun.runId);
      return { outcome: "steered" as const, inputPostId: input.inputPostId };
    }
    if (params.dispatchTurn) {
      scheduleDrain();
    }
    return { outcome: "queued" as const, inputPostId: input.inputPostId, queuePosition };
  };

  const status = async (inputPostId: string): Promise<MattermostIngressStatusResult | null> => {
    const inspection = await params.queue.inspect(inputPostId);
    return inspection ? statusFromInspection(inspection) : null;
  };

  const cancel = async (inputPostId: string, idempotencyKey: string) => {
    const result = await params.queue.cancelPending(inputPostId, { idempotencyKey });
    if (result.outcome === "canceled" && params.dispatchTurn) {
      scheduleDrain();
    }
    return result;
  };

  const markStarted = async (paramsLocal: {
    inputPostId: string;
    conversationId: string;
    turnId: string;
    runId: string;
  }): Promise<boolean> =>
    params.queue.complete(paramsLocal.inputPostId, {
      retainPayload: true,
      metadata: {
        state: "started",
        conversationId: paramsLocal.conversationId,
        turnId: paramsLocal.turnId,
        runId: paramsLocal.runId,
      },
    });

  const markCompleted = async (paramsLocal: {
    inputPostId: string;
    conversationId: string;
    turnId: string;
    runId: string;
    outcome: "completed" | "failed" | "stopped";
    terminalRun?: AgentActivityTerminalRun;
  }) => {
    const updated = await params.queue.annotateCompleted(paramsLocal.inputPostId, {
      state: "completed",
      conversationId: paramsLocal.conversationId,
      turnId: paramsLocal.turnId,
      runId: paramsLocal.runId,
      outcome: paramsLocal.outcome,
      ...(paramsLocal.terminalRun ? { terminalRun: paramsLocal.terminalRun } : {}),
    });
    if (params.dispatchTurn) {
      scheduleDrain();
    }
    return updated;
  };

  const terminalSource = async (runId: string) => {
    const completed = (await params.queue.listCompleted()).find(
      (entry) => entry.metadata?.runId === runId,
    );
    if (!completed?.metadata?.outcome) {
      return undefined;
    }
    const inspection = await params.queue.inspect(completed.id);
    return inspection?.payload
      ? { input: inspection.payload, terminal: completed.metadata }
      : undefined;
  };

  const existingRetryAdmission = async (
    failedRunId: string,
  ): Promise<
    | Exclude<MattermostIngressRetryResult, { outcome: "not-terminal" | "source-missing" }>
    | undefined
  > => {
    const [pending, claims, completed] = await Promise.all([
      params.queue.listPending({ limit: "all" }),
      params.queue.listClaims(),
      params.queue.listCompleted(),
    ]);
    const live = [...pending, ...claims].find(
      (entry) => entry.payload?.retryOfRunId === failedRunId,
    );
    if (live?.payload) {
      return {
        outcome: "duplicate",
        inputPostId: live.id,
        turnId: live.payload.turnId,
      };
    }
    for (const entry of completed) {
      const inspection = await params.queue.inspect(entry.id);
      if (inspection?.payload?.retryOfRunId !== failedRunId) {
        continue;
      }
      return {
        outcome: "duplicate",
        inputPostId: entry.id,
        turnId: inspection.payload.turnId,
        ...(entry.metadata?.runId ? { runId: entry.metadata.runId } : {}),
      };
    }
    return undefined;
  };

  const retry = async (retryParams: {
    failedRunId: string;
    markerPostId: string;
    actorMmUserId: string;
    idempotencyKey: string;
  }): Promise<MattermostIngressRetryResult> => {
    if (retryParams.idempotencyKey !== `retry:${retryParams.failedRunId}`) {
      throw new Error("Mattermost retry idempotency key does not match failed run");
    }
    const existing = await existingRetryAdmission(retryParams.failedRunId);
    if (existing) {
      return existing;
    }
    const completed = (await params.queue.listCompleted()).find(
      (entry) => entry.metadata?.runId === retryParams.failedRunId,
    );
    if (!completed) {
      return { outcome: "source-missing" };
    }
    if (!completed.metadata?.outcome) {
      return { outcome: "not-terminal" };
    }
    if (completed.metadata.outcome === "completed") {
      return { outcome: "not-terminal" };
    }
    const terminalRun = completed.metadata.terminalRun;
    if (!terminalRun) {
      throw new Error("Mattermost retry source is missing authoritative terminal run identity");
    }
    const sourceInspection = await params.queue.inspect(completed.id);
    const retainedSource = sourceInspection?.payload;
    if (
      !retainedSource ||
      !params.fetchMarkerPost ||
      !params.refetchSourceInput ||
      !params.botUserId
    ) {
      return { outcome: "source-missing" };
    }
    const source = await params.refetchSourceInput(retainedSource);
    if (!source) {
      return { outcome: "source-missing" };
    }
    const marker = await params.fetchMarkerPost(retryParams.markerPostId);
    if (!marker || marker.id !== retryParams.markerPostId) {
      return { outcome: "source-missing" };
    }
    assertRetryMarker({
      marker,
      botUserId: params.botUserId,
      source,
      terminalRun,
      failedRunId: retryParams.failedRunId,
      actorMmUserId: retryParams.actorMmUserId,
    });
    const retryInput: MattermostAdmissionInput = {
      ...source,
      inputPostId: marker.id,
      senderId: retryParams.actorMmUserId,
      receivedAt: marker.create_at ?? Date.now(),
      origin: "retry",
      retryOfRunId: retryParams.failedRunId,
      plannedRunId: randomUUID(),
    };
    const activeRun = await activeRunForConversation(source.conversationId);
    const admitted = await admit(retryInput, activeRun);
    return {
      outcome: admitted.outcome === "duplicate" ? "duplicate" : "accepted",
      inputPostId: marker.id,
      turnId: source.turnId,
    };
  };

  const snapshotAdmissions = async () => {
    const [pending, claims] = await Promise.all([normalizeCapacity(), params.queue.listClaims()]);
    const entries = pending.concat(claims);
    return await Promise.all(
      entries.map(async (entry, index): Promise<AgentActivitySnapshotAdmission> => {
        const metadata = entry.metadata;
        const payload = entry.payload;
        if (!metadata || !payload || !payload.origin) {
          throw new Error(`Mattermost admission ${entry.id} is missing durable snapshot identity`);
        }
        const inspection = await params.queue.inspect(entry.id);
        const snapshot: AgentActivitySnapshotAdmission = {
          inputPostId: entry.id,
          conversationId: metadata.conversationId,
          turnId: metadata.turnId,
          mainChannelId: payload.channelId,
          activityChannelId: payload.channelId,
          origin: payload.origin,
          status: metadata.state,
          queuePosition: metadata.queuePosition ?? index + 1,
          revision: inspection?.revision ?? metadata.revision,
        };
        if (payload.retryOfRunId) {
          snapshot.retryOfRunId = payload.retryOfRunId;
        }
        return snapshot;
      }),
    );
  };

  return {
    admit,
    drain,
    status,
    cancel,
    retry,
    markStarted,
    markCompleted,
    terminalSource,
    snapshotAdmissions,
  };
}

export type MattermostAdmissionService = ReturnType<typeof createMattermostAdmissionService>;
