import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentActivityAppend, AgentActivitySink } from "openclaw/plugin-sdk/channel-outbound";

export type ActivitySpoolFile = {
  path: string;
  byteLength: number;
  sha256: string;
};

export type ActivityOutboxRecord = {
  envelope: AgentActivityAppend["envelope"];
  attachmentFile?: ActivitySpoolFile;
};

type ActivityOutboxClaim = {
  id: string;
  payload: ActivityOutboxRecord;
  attempts: number;
  claim: { token: string; claimedAt?: number };
};

export type ActivityOutboxQueue = {
  enqueue(
    id: string,
    payload: ActivityOutboxRecord,
    options?: { receivedAt?: number; laneKey?: string },
  ): Promise<{
    kind: string;
    duplicate: boolean;
    record?: { id: string; metadata?: unknown };
  }>;
  recoverStaleClaims(options: { staleMs: number }): Promise<number>;
  listClaims(): Promise<ActivityOutboxClaim[]>;
  inspect?: (
    id: string,
  ) => Promise<{ status: "pending" | "claimed" | "completed" | "failed" | "canceled" } | null>;
  claimNext(options?: { ownerId?: string }): Promise<ActivityOutboxClaim | null>;
  complete(
    claim: ActivityOutboxClaim,
    options: { metadata: ActivityDeliveryReceipt },
  ): Promise<boolean>;
  release(claim: ActivityOutboxClaim, options: { lastError: string }): Promise<boolean>;
  fail(claim: ActivityOutboxClaim, options: { reason: string; message: string }): Promise<boolean>;
};

export type ActivityDeliveryReceipt = {
  outcome: "persisted" | "duplicate";
  postIds: string[];
  activityChannelId: string;
};

export type AgentActivityTransportResult =
  | ({ status: 200 } & ActivityDeliveryReceipt & { outcome: "duplicate" })
  | ({ status: 201 } & ActivityDeliveryReceipt & { outcome: "persisted" })
  | { status: number; outcome: "unavailable" | "rejected" };

export type AgentActivityTransport = (
  append: ActivityOutboxRecord,
) => Promise<AgentActivityTransportResult>;

const DEFAULT_STALE_CLAIM_MS = 60_000;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function activityDeliveryReceipt(value: unknown): ActivityDeliveryReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: the guard above rejects null, non-objects, and arrays.
  const record = value as Record<string, unknown>;
  if (
    (record.outcome !== "persisted" && record.outcome !== "duplicate") ||
    !Array.isArray(record.postIds) ||
    !record.postIds.every((postId) => typeof postId === "string") ||
    typeof record.activityChannelId !== "string" ||
    !record.activityChannelId.trim()
  ) {
    return undefined;
  }
  return {
    outcome: record.outcome,
    postIds: record.postIds,
    activityChannelId: record.activityChannelId,
  };
}

/** SQLite-backed serialized outbox for the loopback Activity sink. */
export function createAgentActivityOutbox(params: {
  queue: ActivityOutboxQueue;
  transport: AgentActivityTransport;
  staleClaimMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  ownerId?: string;
  spoolDir?: string;
  maxAttachmentBytes?: number;
  now?: () => number;
  scheduleRetry?: (callback: () => void, delayMs: number) => void;
  onQuarantine?: (eventKey: string, status: number) => void;
  onRetryableError?: (eventKey: string, error: unknown) => void;
}): AgentActivitySink & { drain(): Promise<void> } {
  const staleClaimMs = Math.max(0, Math.floor(params.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS));
  const retryBaseMs = Math.max(1, Math.floor(params.retryBaseMs ?? DEFAULT_RETRY_BASE_MS));
  const retryMaxMs = Math.max(retryBaseMs, Math.floor(params.retryMaxMs ?? DEFAULT_RETRY_MAX_MS));
  const ownerId = params.ownerId ?? `mattermost-activity-${process.pid}`;
  const now = params.now ?? Date.now;
  const maxAttachmentBytes = Math.max(
    1,
    Math.floor(params.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES),
  );
  let activeDrain: Promise<void> | undefined;
  let retryScheduled = false;
  let staleRecoveryScheduled = false;
  const spoolProtection = new Map<string, number>();
  const waiters = new Map<
    string,
    Set<{
      resolve: (receipt: ActivityDeliveryReceipt) => void;
      reject: (error: Error) => void;
    }>
  >();

  const protectSpoolPath = (filePath: string): void => {
    spoolProtection.set(filePath, (spoolProtection.get(filePath) ?? 0) + 1);
  };

  const unprotectSpoolPath = (filePath: string): void => {
    const count = spoolProtection.get(filePath) ?? 0;
    if (count <= 1) {
      spoolProtection.delete(filePath);
      return;
    }
    spoolProtection.set(filePath, count - 1);
  };

  const settleWaiters = (
    eventKey: string,
    outcome: { receipt: ActivityDeliveryReceipt } | { error: Error },
  ): void => {
    const pending = waiters.get(eventKey);
    if (!pending) {
      return;
    }
    waiters.delete(eventKey);
    for (const waiter of pending) {
      if ("receipt" in outcome) {
        waiter.resolve(outcome.receipt);
      } else {
        waiter.reject(outcome.error);
      }
    }
  };

  const deleteAttachmentFile = async (record: ActivityOutboxRecord): Promise<void> => {
    if (!record.attachmentFile) {
      return;
    }
    await fs.rm(record.attachmentFile.path, { force: true });
  };

  const cleanupSpool = async (): Promise<void> => {
    if (!params.spoolDir) {
      return;
    }
    const entries = await fs
      .readdir(params.spoolDir, { withFileTypes: true })
      .catch((error: unknown) => {
        // SAFETY: readdir rejects with a Node system error carrying an optional code.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = path.join(params.spoolDir, entry.name);
      if (spoolProtection.has(filePath)) {
        continue;
      }
      if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
        await fs.rm(filePath, { force: true });
        continue;
      }
      const match = entry.name.match(/^(.*)-[a-f0-9]{64}\.detail$/u);
      if (!match?.[1] || !params.queue.inspect) {
        continue;
      }
      const row = await params.queue.inspect(match[1]);
      if (!row || ["completed", "failed", "canceled"].includes(row.status)) {
        await fs.rm(filePath, { force: true });
      }
    }
  };

  const spoolAttachment = async (item: AgentActivityAppend): Promise<ActivityOutboxRecord> => {
    if (item.attachmentBody === undefined) {
      return { envelope: item.envelope };
    }
    const attachment =
      item.envelope.type === "item.completed" ? item.envelope.item.attachment : undefined;
    if (!attachment) {
      throw new Error("activity attachment body requires attachment metadata");
    }
    if (!params.spoolDir) {
      throw new Error("activity attachment spool directory is unavailable");
    }
    const bodyBytes = Buffer.byteLength(item.attachmentBody, "utf8");
    const bodySha256 = createHash("sha256").update(item.attachmentBody).digest("hex");
    if (bodyBytes > maxAttachmentBytes) {
      throw new Error(`activity detail exceeds ${maxAttachmentBytes} bytes`);
    }
    if (bodyBytes !== attachment.byteLength || bodySha256 !== attachment.sha256) {
      throw new Error("activity attachment body does not match attachment metadata");
    }
    const spoolDir = path.resolve(params.spoolDir);
    await fs.mkdir(spoolDir, { recursive: true, mode: 0o700 });
    const safeEventKey = item.envelope.eventKey.replace(/[^a-zA-Z0-9_-]/g, "-");
    const filename = `${safeEventKey}-${attachment.sha256}.detail`;
    const finalPath = path.join(spoolDir, filename);
    const temporaryPath = path.join(spoolDir, `.${filename}.${randomUUID()}.tmp`);
    protectSpoolPath(temporaryPath);
    protectSpoolPath(finalPath);
    let completed = false;
    try {
      await fs.writeFile(temporaryPath, item.attachmentBody, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      try {
        await fs.rename(temporaryPath, finalPath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true });
        const existing = await fs.stat(finalPath).catch(() => undefined);
        if (!existing?.isFile()) {
          throw error;
        }
      }
      await fs.chmod(finalPath, 0o600);
      completed = true;
      return {
        envelope: item.envelope,
        attachmentFile: {
          path: finalPath,
          byteLength: attachment.byteLength,
          sha256: attachment.sha256,
        },
      };
    } finally {
      unprotectSpoolPath(temporaryPath);
      if (!completed) {
        unprotectSpoolPath(finalPath);
        await fs.rm(temporaryPath, { force: true });
      }
    }
  };

  const scheduleRetry = (attempts: number): void => {
    if (retryScheduled) {
      return;
    }
    retryScheduled = true;
    const delayMs = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempts, 16));
    const callback = () => {
      retryScheduled = false;
      void drain();
    };
    if (params.scheduleRetry) {
      params.scheduleRetry(callback, delayMs);
      return;
    }
    const timer = setTimeout(callback, delayMs);
    timer.unref();
  };

  const scheduleStaleRecovery = (claims: ActivityOutboxClaim[]): void => {
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
      void drain();
    };
    if (params.scheduleRetry) {
      params.scheduleRetry(callback, delayMs);
      return;
    }
    const timer = setTimeout(callback, delayMs);
    timer.unref();
  };

  const runDrain = async (): Promise<void> => {
    await cleanupSpool();
    await params.queue.recoverStaleClaims({ staleMs: staleClaimMs });
    while (true) {
      const claim = await params.queue.claimNext({ ownerId });
      if (!claim) {
        scheduleStaleRecovery(await params.queue.listClaims());
        return;
      }
      let result: AgentActivityTransportResult;
      try {
        result = await params.transport(claim.payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await params.queue.release(claim, { lastError: `activity transport failed: ${message}` });
        params.onRetryableError?.(claim.id, error);
        scheduleRetry(claim.attempts);
        return;
      }
      if (
        (result.status === 200 && result.outcome === "duplicate") ||
        (result.status === 201 && result.outcome === "persisted")
      ) {
        const receipt: ActivityDeliveryReceipt = {
          outcome: result.outcome,
          postIds: result.postIds,
          activityChannelId: result.activityChannelId,
        };
        const completed = await params.queue.complete(claim, { metadata: receipt });
        if (!completed) {
          throw new Error(`activity outbox lost claim ownership for ${claim.id}`);
        }
        await deleteAttachmentFile(claim.payload);
        settleWaiters(claim.id, { receipt });
        continue;
      }
      if (result.status === 503) {
        await params.queue.release(claim, {
          lastError: "activity sink unavailable (503)",
        });
        params.onRetryableError?.(claim.id, new Error("activity sink unavailable (503)"));
        scheduleRetry(claim.attempts);
        return;
      }
      await params.queue.fail(claim, {
        reason: "non-retryable-http",
        message: `activity sink rejected envelope (${result.status})`,
      });
      await deleteAttachmentFile(claim.payload);
      settleWaiters(claim.id, {
        error: new Error(`activity sink rejected envelope (${result.status})`),
      });
      params.onQuarantine?.(claim.id, result.status);
    }
  };

  const drain = (): Promise<void> => {
    activeDrain ??= runDrain().finally(() => {
      activeDrain = undefined;
    });
    return activeDrain;
  };

  return {
    append: async (item) => {
      const record = await spoolAttachment(item);
      let enqueued: Awaited<ReturnType<ActivityOutboxQueue["enqueue"]>>;
      try {
        enqueued = await params.queue.enqueue(item.envelope.eventKey, record, {
          laneKey: item.envelope.ref.runId,
          receivedAt: Date.parse(item.envelope.emittedAt),
        });
      } catch (error) {
        await deleteAttachmentFile(record);
        throw error;
      } finally {
        if (record.attachmentFile) {
          unprotectSpoolPath(record.attachmentFile.path);
        }
      }
      const completedReceipt = activityDeliveryReceipt(enqueued.record?.metadata);
      if (enqueued.kind === "completed" && completedReceipt) {
        await deleteAttachmentFile(record);
        return completedReceipt;
      }
      if (enqueued.duplicate && !["pending", "claimed"].includes(enqueued.kind)) {
        await deleteAttachmentFile(record);
        throw new Error(`activity event ${item.envelope.eventKey} is ${enqueued.kind}`);
      }
      const delivered = new Promise<ActivityDeliveryReceipt>((resolve, reject) => {
        const pending = waiters.get(item.envelope.eventKey) ?? new Set();
        pending.add({ resolve, reject });
        waiters.set(item.envelope.eventKey, pending);
      });
      void drain();
      return await delivered;
    },
    drain,
  };
}
