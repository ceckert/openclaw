import type { AgentActivityTerminalRun } from "./activity-runtime.js";

export type MattermostAdmissionPolicy = "start" | "steer" | "followup";

export type MattermostIngressState =
  | "pending"
  | "claimed"
  | "started"
  | "completed"
  | "failed"
  | "canceled";

export type MattermostAdmissionInput = {
  inputPostId: string;
  accountId: string;
  conversationId: string;
  turnId: string;
  channelId: string;
  rootId?: string;
  senderId: string;
  receivedAt: number;
  post: Record<string, unknown>;
  origin?: "human" | "followup" | "retry" | "scheduled";
  retryOfRunId?: string;
  activityChannelId?: string;
  plannedRunId?: string;
};

export type MattermostAdmissionMetadata = {
  policy: MattermostAdmissionPolicy;
  state: "received" | "queued" | "blocked";
  revision: number;
  conversationId: string;
  turnId: string;
  targetRunId?: string;
  queuePosition?: number;
};

export type MattermostAdmissionCompletedMetadata = {
  state: "started" | "completed";
  conversationId: string;
  turnId: string;
  runId?: string;
  outcome?: "completed" | "failed" | "stopped";
  terminalRun?: AgentActivityTerminalRun;
};

export type AdmissionQueueEntry = {
  id: string;
  payload?: MattermostAdmissionInput;
  metadata?: MattermostAdmissionMetadata;
  claim?: { token: string; claimedAt?: number };
};

export type AdmissionQueueClaim = AdmissionQueueEntry & {
  payload: MattermostAdmissionInput;
  attempts: number;
  claim: { token: string };
};

type AdmissionQueueCompletedEntry = {
  id: string;
  metadata?: MattermostAdmissionCompletedMetadata;
};

export type AdmissionQueueInspection = {
  id: string;
  status: "pending" | "claimed" | "completed" | "failed" | "canceled";
  revision: number;
  payload?: MattermostAdmissionInput;
  metadata?: MattermostAdmissionMetadata;
  completedMetadata?: MattermostAdmissionCompletedMetadata;
  failedReason?: string;
  canceledMetadata?: { idempotencyKey: string };
};

export type MattermostAdmissionQueue = {
  enqueue(
    id: string,
    payload: MattermostAdmissionInput,
    options: {
      laneKey: string;
      metadata: MattermostAdmissionMetadata;
      receivedAt: number;
    },
  ): Promise<{ kind: string; duplicate: boolean; record?: { id: string } }>;
  listPending(options?: { limit?: number | "all" }): Promise<AdmissionQueueEntry[]>;
  listClaims(): Promise<AdmissionQueueClaim[]>;
  listCompleted(): Promise<AdmissionQueueCompletedEntry[]>;
  inspect(id: string): Promise<AdmissionQueueInspection | null>;
  annotatePending(
    id: string,
    metadata: MattermostAdmissionMetadata,
  ): Promise<AdmissionQueueInspection | null>;
  cancelPending(
    id: string,
    options: { idempotencyKey: string },
  ): Promise<
    | { outcome: "canceled" | "already-canceled"; revision: number }
    | { outcome: "already-started"; revision: number; runId?: string }
    | { outcome: "not-found" }
  >;
  claim(id: string, options?: { ownerId?: string }): Promise<AdmissionQueueClaim | null>;
  claimNext(options?: {
    ownerId?: string;
    blockedLaneKeys?: Iterable<string>;
    candidateIds?: Iterable<string>;
  }): Promise<AdmissionQueueClaim | null>;
  recoverStaleClaims(options: { staleMs: number }): Promise<number>;
  complete(
    idOrClaim: string | AdmissionQueueClaim,
    options: { metadata: MattermostAdmissionCompletedMetadata; retainPayload?: boolean },
  ): Promise<boolean>;
  annotateCompleted(
    id: string,
    metadata: MattermostAdmissionCompletedMetadata,
  ): Promise<AdmissionQueueInspection | null>;
  release(claim: AdmissionQueueClaim, options: { lastError: string }): Promise<boolean>;
  fail(claim: AdmissionQueueClaim, options: { reason: string; message: string }): Promise<boolean>;
};

export type MattermostIngressStatusResult = {
  inputPostId: string;
  conversationId: string;
  turnId: string;
  state: MattermostIngressState;
  revision: number;
  runId?: string;
};

export type MattermostRetryMarkerPost = {
  id: string;
  user_id: string;
  channel_id: string;
  root_id?: string;
  create_at?: number;
  props?: Record<string, unknown>;
};

export type MattermostIngressRetryResult =
  | {
      outcome: "accepted" | "duplicate";
      inputPostId: string;
      turnId: string;
      runId?: string;
    }
  | { outcome: "not-terminal" | "source-missing" };

export type MattermostAdmissionActiveRun = {
  mainRootPostId: string;
  runId: string;
  activityChannelId?: string;
};
