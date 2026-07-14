import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentActivityAppend } from "openclaw/plugin-sdk/channel-outbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { createAgentActivityHttpTransport } from "./activity-http-client.js";
import {
  createAgentActivityOutbox,
  type ActivityDeliveryReceipt,
  type ActivityOutboxQueue,
  type ActivityOutboxRecord,
} from "./activity-outbox.js";

const append: AgentActivityAppend = {
  envelope: {
    schemaVersion: 1,
    type: "turn.started",
    eventKey: "abc123",
    emittedAt: "2026-07-11T12:00:00.000Z",
    ref: {
      conversationId: "channel-1",
      turnId: "post-1",
      runId: "run-1",
      agentId: "agent-1",
      sessionKey: "agent:agent-1:mattermost:channel:channel-1",
      origin: "human",
      mainChannelId: "channel-1",
      mainRootPostId: "post-1",
      itemId: "octogee:run-root",
      ordinal: 0,
      semanticVersion: 1,
    },
    redaction: { policy: "octogee-v1", appliedAt: "producer" },
  },
};

function createQueue() {
  const pending: ActivityOutboxRecord[] = [];
  return {
    enqueue: vi.fn(async (_id, payload) => {
      pending.push(payload);
      return { kind: "accepted", duplicate: false };
    }),
    recoverStaleClaims: vi.fn(async () => 0),
    listClaims: vi.fn(async () => []),
    claimNext: vi.fn(async () => {
      const payload = pending.shift();
      return payload
        ? { id: payload.envelope.eventKey, payload, attempts: 0, claim: { token: "claim-1" } }
        : null;
    }),
    complete: vi.fn(async () => true),
    release: vi.fn(async () => true),
    fail: vi.fn(async () => true),
  } satisfies ActivityOutboxQueue;
}

describe("createAgentActivityOutbox", () => {
  it("journals the complete envelope before HTTP delivery", async () => {
    const queue = createQueue();
    const order: string[] = [];
    vi.mocked(queue.enqueue).mockImplementation(async () => {
      order.push("journal");
      return { kind: "accepted", duplicate: false };
    });
    vi.mocked(queue.claimNext)
      .mockResolvedValueOnce({
        id: append.envelope.eventKey,
        payload: { envelope: append.envelope },
        attempts: 0,
        claim: { token: "claim-1" },
      })
      .mockResolvedValueOnce(null);
    const transport = vi.fn(async () => {
      order.push("http");
      return {
        status: 201 as const,
        outcome: "persisted" as const,
        postIds: ["post-a"],
        activityChannelId: "activity-channel",
      };
    });
    const outbox = createAgentActivityOutbox({ queue, transport });

    await outbox.append(append);
    await outbox.drain();

    expect(order).toEqual(["journal", "http"]);
    expect(queue.complete).toHaveBeenCalledWith(
      expect.objectContaining({ id: "abc123", claim: { token: "claim-1" } }),
      {
        metadata: {
          outcome: "persisted",
          postIds: ["post-a"],
          activityChannelId: "activity-channel",
        },
      },
    );
  });

  it("returns a completed journal receipt without redelivering", async () => {
    const queue = createQueue();
    vi.mocked(queue.enqueue).mockResolvedValue({
      kind: "completed",
      duplicate: true,
      record: {
        id: "abc123",
        metadata: {
          outcome: "persisted",
          postIds: ["activity-root"],
          activityChannelId: "activity-channel",
        },
      },
    });
    const transport = vi.fn();
    const outbox = createAgentActivityOutbox({ queue, transport });

    await expect(outbox.append(append)).resolves.toEqual({
      outcome: "persisted",
      postIds: ["activity-root"],
      activityChannelId: "activity-channel",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not reap a spool file while its queue insert is in flight", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mm-activity-race-"));
    const detail = "large activity detail";
    const sha256 = createHash("sha256").update(detail).digest("hex");
    const attached: AgentActivityAppend = {
      envelope: {
        ...append.envelope,
        type: "item.completed",
        eventKey: "in-flight-event",
        ref: { ...append.envelope.ref, itemId: "tool-output", ordinal: 1 },
        item: {
          kind: "tool",
          status: "completed",
          summary: "large output",
          attachment: {
            filename: "tool-output.md",
            mediaType: "text/markdown",
            byteLength: Buffer.byteLength(detail),
            sha256,
            multipartField: "detail",
          },
        },
      },
      attachmentBody: detail,
    };
    let finishEnqueue: (() => void) | undefined;
    let queued = false;
    let attachmentPath: string | undefined;
    const queue = createQueue();
    queue.inspect = vi.fn(async () => (queued ? { status: "pending" as const } : null));
    vi.mocked(queue.enqueue).mockImplementation(
      async (_id, record) =>
        await new Promise<{ kind: string; duplicate: boolean }>((resolve) => {
          attachmentPath = record.attachmentFile?.path;
          finishEnqueue = () => {
            queued = true;
            resolve({ kind: "accepted", duplicate: false });
          };
        }),
    );
    const outbox = createAgentActivityOutbox({
      queue,
      transport: vi.fn(),
      spoolDir: path.join(stateDir, "activity-spool"),
    });

    try {
      void outbox.append(attached);
      await vi.waitFor(() => expect(attachmentPath).toBeTruthy());

      await outbox.drain();

      await expect(fs.stat(attachmentPath as string)).resolves.toMatchObject({
        mode: expect.any(Number),
      });
      finishEnqueue?.();
      await vi.waitFor(() => expect(queued).toBe(true));
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("releases retryable delivery and quarantines non-retryable delivery", async () => {
    const retryQueue = createQueue();
    const scheduleRetry = vi.fn();
    const retryOutbox = createAgentActivityOutbox({
      queue: retryQueue,
      transport: vi.fn(async () => ({ status: 503, outcome: "unavailable" as const })),
      scheduleRetry,
    });
    void retryOutbox.append(append);
    await vi.waitFor(() => expect(retryQueue.release).toHaveBeenCalled());
    expect(retryQueue.release).toHaveBeenCalledWith(expect.anything(), {
      lastError: "activity sink unavailable (503)",
    });
    expect(retryQueue.fail).not.toHaveBeenCalled();
    expect(scheduleRetry).toHaveBeenCalledWith(expect.any(Function), 250);

    const rejectedQueue = createQueue();
    const onQuarantine = vi.fn();
    const rejectedOutbox = createAgentActivityOutbox({
      queue: rejectedQueue,
      transport: vi.fn(async () => ({ status: 422, outcome: "rejected" as const })),
      onQuarantine,
    });
    await expect(rejectedOutbox.append(append)).rejects.toThrow(
      "activity sink rejected envelope (422)",
    );
    expect(rejectedQueue.fail).toHaveBeenCalledWith(expect.anything(), {
      reason: "non-retryable-http",
      message: "activity sink rejected envelope (422)",
    });
    expect(onQuarantine).toHaveBeenCalledWith("abc123", 422);
  });

  it("backs off repeated retryable attempts with a bounded exponential delay", async () => {
    const queue = createQueue();
    vi.mocked(queue.claimNext)
      .mockResolvedValueOnce({
        id: "abc123",
        payload: { envelope: append.envelope },
        attempts: 5,
        claim: { token: "claim-1" },
      })
      .mockResolvedValueOnce(null);
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const outbox = createAgentActivityOutbox({
      queue,
      transport: vi.fn(async () => ({ status: 503, outcome: "unavailable" as const })),
      retryBaseMs: 1000,
      retryMaxMs: 10_000,
      scheduleRetry: (callback, delayMs) => scheduled.push({ callback, delayMs }),
    });

    await outbox.drain();

    expect(scheduled).toEqual([{ callback: expect.any(Function), delayMs: 10_000 }]);
  });

  it("recovers stale claims and serializes concurrent drains", async () => {
    const queue = createQueue();
    const transport = vi.fn(async () => ({
      status: 200 as const,
      outcome: "duplicate" as const,
      postIds: ["activity-root"],
      activityChannelId: "activity-channel",
    }));
    const outbox = createAgentActivityOutbox({ queue, transport, staleClaimMs: 30_000 });
    await outbox.append(append);

    await Promise.all([outbox.drain(), outbox.drain(), outbox.drain()]);

    expect(queue.recoverStaleClaims).toHaveBeenCalledWith({ staleMs: 30_000 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("schedules recovery when startup finds a claim that is not stale yet", async () => {
    const queue = createQueue();
    vi.mocked(queue.listClaims).mockResolvedValue([
      {
        id: "claimed-event",
        payload: { envelope: append.envelope },
        attempts: 0,
        claim: { token: "claim-1", claimedAt: 100 },
      },
    ]);
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const outbox = createAgentActivityOutbox({
      queue,
      transport: vi.fn(),
      staleClaimMs: 1_000,
      now: () => 100,
      scheduleRetry: (callback, delayMs) => scheduled.push({ callback, delayMs }),
    });

    await outbox.drain();

    expect(scheduled).toEqual([{ callback: expect.any(Function), delayMs: 1_000 }]);
  });

  it("restarts from the SQLite journal and quarantines a rejected envelope", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mm-activity-outbox-"));
    const queueOptions = {
      channelId: "mattermost-activity",
      accountId: "test",
      stateDir,
    };
    try {
      const firstQueue = createChannelIngressQueueForTests<
        ActivityOutboxRecord,
        unknown,
        ActivityDeliveryReceipt
      >(queueOptions);
      const firstOutbox = createAgentActivityOutbox({
        queue: firstQueue,
        transport: vi.fn(async () => ({ status: 503, outcome: "unavailable" as const })),
        scheduleRetry: vi.fn(),
        spoolDir: path.join(stateDir, "activity-spool"),
      });

      void firstOutbox.append(append);
      await vi.waitFor(async () => {
        expect((await firstQueue.inspect("abc123"))?.status).toBe("pending");
      });
      await expect(firstQueue.inspect("abc123")).resolves.toMatchObject({
        status: "pending",
        payload: { envelope: append.envelope },
        revision: 3,
      });

      closeOpenClawStateDatabaseForTest();
      const restartedQueue = createChannelIngressQueueForTests<
        ActivityOutboxRecord,
        unknown,
        ActivityDeliveryReceipt
      >(queueOptions);
      const restartedOutbox = createAgentActivityOutbox({
        queue: restartedQueue,
        transport: vi.fn(async () => ({
          status: 201 as const,
          outcome: "persisted" as const,
          postIds: ["activity-post"],
          activityChannelId: "activity-channel",
        })),
        spoolDir: path.join(stateDir, "activity-spool"),
      });

      await restartedOutbox.drain();
      await expect(restartedQueue.inspect("abc123")).resolves.toMatchObject({
        status: "completed",
        completedMetadata: {
          outcome: "persisted",
          postIds: ["activity-post"],
          activityChannelId: "activity-channel",
        },
      });

      const rejected = structuredClone(append);
      rejected.envelope.eventKey = "rejected-event";
      const onQuarantine = vi.fn();
      const rejectedOutbox = createAgentActivityOutbox({
        queue: restartedQueue,
        transport: vi.fn(async () => ({ status: 422, outcome: "rejected" as const })),
        onQuarantine,
        spoolDir: path.join(stateDir, "activity-spool"),
      });
      await expect(rejectedOutbox.append(rejected)).rejects.toThrow(
        "activity sink rejected envelope (422)",
      );

      await expect(restartedQueue.inspect("rejected-event")).resolves.toMatchObject({
        status: "failed",
        failedReason: "non-retryable-http",
      });
      expect(onQuarantine).toHaveBeenCalledWith("rejected-event", 422);

      const detail = "x".repeat(64 * 1024);
      const attachmentSha = createHash("sha256").update(detail).digest("hex");
      const attached: AgentActivityAppend = {
        envelope: {
          ...append.envelope,
          type: "item.completed",
          eventKey: "attached-event",
          ref: { ...append.envelope.ref, itemId: "tool-output", ordinal: 1 },
          item: {
            kind: "tool",
            status: "completed",
            summary: "large output",
            attachment: {
              filename: "tool-output.md",
              mediaType: "text/markdown",
              byteLength: Buffer.byteLength(detail),
              sha256: attachmentSha,
              multipartField: "detail",
            },
          },
        },
        attachmentBody: detail,
      };
      const retainedOutbox = createAgentActivityOutbox({
        queue: restartedQueue,
        transport: vi.fn(async () => ({ status: 503, outcome: "unavailable" as const })),
        scheduleRetry: vi.fn(),
        spoolDir: path.join(stateDir, "activity-spool"),
      });
      void retainedOutbox.append(attached);
      await vi.waitFor(async () => {
        expect((await restartedQueue.inspect("attached-event"))?.status).toBe("pending");
      });
      const retained = await restartedQueue.inspect("attached-event");
      expect(JSON.stringify(retained)).not.toContain(detail);
      expect(retained).toMatchObject({
        status: "pending",
        payload: {
          envelope: attached.envelope,
          attachmentFile: { byteLength: Buffer.byteLength(detail), sha256: attachmentSha },
        },
      });
      const attachmentPath = retained?.payload?.attachmentFile?.path;
      expect(attachmentPath).toBeTruthy();
      const mode = (await fs.stat(attachmentPath as string)).mode & 0o777;
      expect(mode).toBe(0o600);

      closeOpenClawStateDatabaseForTest();
      const attachmentQueue = createChannelIngressQueueForTests<
        ActivityOutboxRecord,
        unknown,
        ActivityDeliveryReceipt
      >(queueOptions);
      const attachmentOutbox = createAgentActivityOutbox({
        queue: attachmentQueue,
        transport: vi.fn(async () => ({
          status: 200 as const,
          outcome: "duplicate" as const,
          postIds: [],
          activityChannelId: "activity-channel",
        })),
        spoolDir: path.join(stateDir, "activity-spool"),
      });
      await attachmentOutbox.drain();
      await expect(fs.stat(attachmentPath as string)).rejects.toMatchObject({ code: "ENOENT" });

      const corruptedEventKey = "corrupted-event";
      const corruptedAttachmentPath = path.join(
        stateDir,
        "activity-spool",
        `${corruptedEventKey}-${attachmentSha}.detail`,
      );
      await fs.writeFile(corruptedAttachmentPath, "tampered", { mode: 0o600 });
      await attachmentQueue.enqueue(
        corruptedEventKey,
        {
          envelope: {
            ...attached.envelope,
            eventKey: corruptedEventKey,
          },
          attachmentFile: {
            path: corruptedAttachmentPath,
            byteLength: Buffer.byteLength(detail),
            sha256: attachmentSha,
          },
        },
        { laneKey: "run-1" },
      );
      const fetchImpl = vi.fn();
      const corruptedQuarantine = vi.fn();
      const corruptedOutbox = createAgentActivityOutbox({
        queue: attachmentQueue,
        transport: createAgentActivityHttpTransport({ fetchImpl }),
        onQuarantine: corruptedQuarantine,
        spoolDir: path.join(stateDir, "activity-spool"),
      });

      await corruptedOutbox.drain();

      await expect(attachmentQueue.inspect(corruptedEventKey)).resolves.toMatchObject({
        status: "failed",
        failedReason: "non-retryable-http",
      });
      await expect(fs.stat(corruptedAttachmentPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(corruptedQuarantine).toHaveBeenCalledWith(corruptedEventKey, 422);

      const temporaryOrphanPath = path.join(stateDir, "activity-spool", ".orphan.tmp");
      const finalOrphanPath = path.join(
        stateDir,
        "activity-spool",
        `orphan-${"a".repeat(64)}.detail`,
      );
      await fs.writeFile(temporaryOrphanPath, "orphan", { mode: 0o600 });
      await fs.writeFile(finalOrphanPath, "orphan", { mode: 0o600 });

      await corruptedOutbox.drain();

      await expect(fs.stat(temporaryOrphanPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(finalOrphanPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
