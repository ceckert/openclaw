import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  classifyMattermostAdmission,
  createMattermostAdmissionService,
  type MattermostAdmissionCompletedMetadata,
  type MattermostAdmissionInput,
  type MattermostAdmissionMetadata,
  type MattermostAdmissionQueue,
} from "./admission.js";

function createQueue() {
  return {
    enqueue: vi.fn(async () => ({ kind: "accepted", duplicate: false })),
    listPending: vi.fn(async () => []),
    listClaims: vi.fn(async () => []),
    inspect: vi.fn(async () => null),
    annotatePending: vi.fn(async () => null),
    cancelPending: vi.fn(async () => ({ outcome: "canceled" as const, revision: 2 })),
    claim: vi.fn(async (_id: string) => ({
      id: "post-2",
      payload: input,
      metadata: {
        policy: "steer" as const,
        state: "received" as const,
        revision: 1,
        conversationId: "channel-1",
        turnId: "post-root",
      },
      attempts: 0,
      claim: { token: "claim-1" },
    })),
    claimNext: vi.fn(async () => null),
    recoverStaleClaims: vi.fn(async () => 0),
    complete: vi.fn(async () => true),
    annotateCompleted: vi.fn(async () => null),
    listCompleted: vi.fn(async () => []),
    release: vi.fn(async () => true),
    fail: vi.fn(async () => true),
  } satisfies MattermostAdmissionQueue;
}

const input = {
  inputPostId: "post-2",
  accountId: "alice-coach",
  conversationId: "channel-1",
  turnId: "post-root",
  channelId: "channel-1",
  rootId: "post-root",
  senderId: "mm-alice",
  receivedAt: 100,
  post: { id: "post-2", channel_id: "channel-1", root_id: "post-root", message: "steer" },
};

describe("Mattermost durable admission", () => {
  it("classifies active-root replies as steer and other active input as followup", () => {
    expect(
      classifyMattermostAdmission({
        input: { rootId: "post-root" },
        activeRun: { mainRootPostId: "post-root" },
      }),
    ).toBe("steer");
    expect(
      classifyMattermostAdmission({
        input: { rootId: "different-root" },
        activeRun: { mainRootPostId: "post-root" },
      }),
    ).toBe("followup");
    expect(
      classifyMattermostAdmission({
        input: {},
        activeRun: { mainRootPostId: "post-root" },
      }),
    ).toBe("followup");
  });

  it("journals before dispatch and uses the post id for steer idempotency", async () => {
    const queue = createQueue();
    const dispatchSteer = vi.fn(async () => ({ accepted: true }));
    const service = createMattermostAdmissionService({ queue, dispatchSteer });

    await service.admit(input, { mainRootPostId: "post-root", runId: "run-1" });

    expect(queue.enqueue).toHaveBeenCalledWith("post-2", expect.objectContaining(input), {
      laneKey: "channel-1",
      metadata: expect.objectContaining({ policy: "steer", state: "received", revision: 1 }),
      receivedAt: 100,
    });
    expect(queue.enqueue).toHaveBeenCalledBefore(dispatchSteer);
    expect(queue.claim).toHaveBeenCalledBefore(dispatchSteer);
    expect(dispatchSteer).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "post-2",
        runId: "run-1",
      }),
    );
  });

  it("blocks the 101st pending turn without deleting its durable post", async () => {
    const queue = createQueue();
    vi.mocked(queue.listPending).mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({
        id: `pending-${index}`,
        payload: { ...input, inputPostId: `pending-${index}` },
        metadata: {
          policy: "followup" as const,
          state: "queued" as const,
          revision: 1,
          conversationId: "channel-1",
          turnId: `pending-${index}`,
          queuePosition: index + 1,
        },
      })),
    );
    const service = createMattermostAdmissionService({ queue });

    const result = await service.admit({ ...input, inputPostId: "overflow", rootId: undefined });

    expect(result).toEqual({ outcome: "blocked", inputPostId: "overflow", queuePosition: 101 });
    expect(queue.enqueue).toHaveBeenCalledWith(
      "overflow",
      expect.objectContaining({ inputPostId: "overflow" }),
      expect.objectContaining({ metadata: expect.objectContaining({ state: "blocked" }) }),
    );
  });

  it("journals a stable planned run id before a turn can dispatch", async () => {
    const queue = createQueue();
    const service = createMattermostAdmissionService({ queue });

    await service.admit({ ...input, inputPostId: "post-start", rootId: undefined });

    expect(queue.enqueue).toHaveBeenCalledWith(
      "post-start",
      expect.objectContaining({ plannedRunId: expect.any(String) }),
      expect.anything(),
    );
  });

  it("schedules recovery when startup finds a claim that is not stale yet", async () => {
    const queue = createQueue();
    vi.mocked(queue.listClaims).mockResolvedValue([
      {
        id: "claimed-post",
        payload: { ...input, plannedRunId: "run-claimed" },
        metadata: {
          policy: "start",
          state: "queued",
          revision: 1,
          conversationId: "channel-1",
          turnId: "post-root",
        },
        attempts: 0,
        claim: { token: "claim-1", claimedAt: 100 },
      },
    ]);
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const service = createMattermostAdmissionService({
      queue,
      staleClaimMs: 1_000,
      now: () => 100,
      scheduleRetry: (callback, delayMs) => scheduled.push({ callback, delayMs }),
      dispatchTurn: vi.fn(),
    });

    await service.drain();

    expect(scheduled).toEqual([{ callback: expect.any(Function), delayMs: 1_000 }]);
  });

  it("returns monotonic status and preserves a canceled tombstone", async () => {
    const queue = createQueue();
    vi.mocked(queue.inspect).mockResolvedValue({
      id: "post-2",
      status: "completed",
      revision: 4,
      completedMetadata: {
        state: "started",
        conversationId: "channel-1",
        turnId: "post-root",
        runId: "run-1",
      },
    });
    const service = createMattermostAdmissionService({ queue });

    await expect(service.status("post-2")).resolves.toEqual({
      inputPostId: "post-2",
      conversationId: "channel-1",
      turnId: "post-root",
      state: "started",
      revision: 4,
      runId: "run-1",
    });
    await expect(service.cancel("post-2", "remove:post-2")).resolves.toEqual({
      outcome: "canceled",
      revision: 2,
    });
    expect(queue.cancelPending).toHaveBeenCalledWith("post-2", {
      idempotencyKey: "remove:post-2",
    });
  });
});

async function withAdmissionQueue(
  run: (queue: MattermostAdmissionQueue, setClock: (value: number) => void) => Promise<void>,
): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mm-admission-"));
  let clock = 100;
  const queue = createChannelIngressQueueForTests<
    MattermostAdmissionInput,
    MattermostAdmissionMetadata,
    MattermostAdmissionCompletedMetadata
  >({
    channelId: "mattermost-admission",
    accountId: "test",
    stateDir,
    now: () => clock,
  });
  try {
    await run(queue, (value) => {
      clock = value;
    });
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe.sequential("Mattermost durable admission SQLite recovery", () => {
  it("recovers a released steer with the same post idempotency key", async () => {
    await withAdmissionQueue(async (queue) => {
      const active = { mainRootPostId: "post-root", runId: "active-run" };
      const firstAttempt = createMattermostAdmissionService({
        queue,
        activeRunForConversation: () => active,
        scheduleRetry: vi.fn(),
        dispatchSteer: async () => {
          throw new Error("runner temporarily unavailable");
        },
      });

      await expect(firstAttempt.admit(input, active)).rejects.toThrow(
        "runner temporarily unavailable",
      );
      await expect(firstAttempt.status("post-2")).resolves.toMatchObject({ state: "pending" });

      const acceptedKeys: string[] = [];
      const recovered = createMattermostAdmissionService({
        queue,
        activeRunForConversation: () => active,
        dispatchSteer: async ({ idempotencyKey }) => {
          acceptedKeys.push(idempotencyKey);
          return { accepted: true };
        },
        dispatchTurn: vi.fn(),
      });
      await recovered.drain();

      expect(acceptedKeys).toEqual(["post-2"]);
      await expect(recovered.status("post-2")).resolves.toMatchObject({
        state: "completed",
        runId: "active-run",
      });
    });
  });

  it("holds followups behind the active run and starts them FIFO after each terminal outcome", async () => {
    await withAdmissionQueue(async (queue) => {
      let active: { mainRootPostId: string; runId: string } | undefined = {
        mainRootPostId: "active-root",
        runId: "active-run",
      };
      const dispatched: Array<{ idempotencyKey: string; runId: string }> = [];
      const service = createMattermostAdmissionService({
        queue,
        activeRunForConversation: () => active,
        dispatchTurn: async ({ input: admittedInput, idempotencyKey, runId }) => {
          dispatched.push({ idempotencyKey, runId });
          active = { mainRootPostId: admittedInput.turnId, runId };
          return { accepted: true, runId };
        },
      });
      const first = { ...input, inputPostId: "post-a", rootId: undefined, turnId: "post-a" };
      const second = { ...input, inputPostId: "post-b", rootId: undefined, turnId: "post-b" };

      await service.admit(first, active);
      await service.admit(second, active);
      await service.drain();
      expect(dispatched).toEqual([]);

      active = undefined;
      await service.drain();
      expect(dispatched.map((entry) => entry.idempotencyKey)).toEqual(["post-a"]);
      await expect(service.status("post-a")).resolves.toMatchObject({
        state: "started",
        runId: dispatched[0]?.runId,
      });
      await expect(service.status("post-b")).resolves.toMatchObject({ state: "pending" });

      active = undefined;
      await service.markCompleted({
        inputPostId: "post-a",
        conversationId: "channel-1",
        turnId: "post-a",
        runId: dispatched[0]?.runId ?? "",
        outcome: "completed",
      });
      await service.drain();
      expect(dispatched.map((entry) => entry.idempotencyKey)).toEqual(["post-a", "post-b"]);
    });
  });

  it("resumes a blocked row when capacity returns and exposes the SQLite revision", async () => {
    await withAdmissionQueue(async (queue) => {
      const active = { mainRootPostId: "active-root", runId: "active-run" };
      const service = createMattermostAdmissionService({ queue, maxPending: 1 });

      await service.admit(
        { ...input, inputPostId: "post-a", rootId: undefined, turnId: "post-a" },
        active,
      );
      await service.admit(
        { ...input, inputPostId: "post-b", rootId: undefined, turnId: "post-b" },
        active,
      );
      await expect(service.snapshotAdmissions()).resolves.toEqual([
        expect.objectContaining({ inputPostId: "post-a", status: "queued", revision: 1 }),
        expect.objectContaining({ inputPostId: "post-b", status: "blocked", revision: 1 }),
      ]);

      await service.cancel("post-a", "remove:post-a");
      await expect(service.snapshotAdmissions()).resolves.toEqual([
        expect.objectContaining({ inputPostId: "post-b", status: "queued", revision: 2 }),
      ]);
    });
  });

  it("snapshots the complete durable admission identity without inventing a run id", async () => {
    await withAdmissionQueue(async (queue) => {
      const service = createMattermostAdmissionService({ queue });
      await service.admit(
        {
          ...input,
          inputPostId: "retry-marker-1",
          turnId: "original-turn-1",
          rootId: undefined,
          origin: "retry",
          retryOfRunId: "failed-run-1",
        },
        {
          mainRootPostId: "active-root",
          runId: "active-run",
          activityChannelId: "activity-channel-1",
        },
      );

      await expect(service.snapshotAdmissions()).resolves.toEqual([
        {
          inputPostId: "retry-marker-1",
          conversationId: "channel-1",
          turnId: "original-turn-1",
          mainChannelId: "channel-1",
          activityChannelId: "activity-channel-1",
          origin: "retry",
          retryOfRunId: "failed-run-1",
          status: "queued",
          queuePosition: 1,
          revision: 1,
        },
      ]);
      expect((await service.snapshotAdmissions())[0]).not.toHaveProperty("runId");
    });
  });

  it("recovers a crash after runner acceptance with the same idempotency key", async () => {
    await withAdmissionQueue(async (queue, setClock) => {
      const journal = createMattermostAdmissionService({ queue });
      await journal.admit({ ...input, inputPostId: "post-crash", rootId: undefined });
      const accepted: Array<{ idempotencyKey: string; runId: string }> = [];
      let rejectCompletion = true;
      const crashQueue: MattermostAdmissionQueue = {
        ...queue,
        complete: async (...args) => {
          if (rejectCompletion) {
            rejectCompletion = false;
            return false;
          }
          return await queue.complete(...args);
        },
      };
      const crashed = createMattermostAdmissionService({
        queue: crashQueue,
        staleClaimMs: 10,
        dispatchTurn: async ({ idempotencyKey, runId }) => {
          accepted.push({ idempotencyKey, runId });
          return { accepted: true, runId };
        },
      });
      await expect(crashed.drain()).rejects.toThrow("lost claim ownership");

      setClock(200);
      closeOpenClawStateDatabaseForTest();
      const restarted = createMattermostAdmissionService({
        queue,
        staleClaimMs: 10,
        dispatchTurn: async ({ idempotencyKey, runId }) => {
          accepted.push({ idempotencyKey, runId });
          return { accepted: true, runId };
        },
      });
      await restarted.drain();

      expect(accepted.map((entry) => entry.idempotencyKey)).toEqual(["post-crash", "post-crash"]);
      expect(accepted[0]?.runId).toBe(accepted[1]?.runId);
      await expect(restarted.status("post-crash")).resolves.toMatchObject({
        state: "started",
        runId: accepted[0]?.runId,
      });
    });
  });

  it("retries only from the terminal source snapshot after validating the bot marker", async () => {
    await withAdmissionQueue(async (queue) => {
      const sourceService = createMattermostAdmissionService({ queue });
      const original = {
        ...input,
        inputPostId: "source-post",
        turnId: "source-post",
        rootId: undefined,
        post: { id: "source-post", message: "original trusted prompt", file_ids: ["file-1"] },
      };
      await sourceService.admit(original);
      await sourceService.markStarted({
        inputPostId: "source-post",
        conversationId: "channel-1",
        turnId: "source-post",
        runId: "failed-run",
      });
      await sourceService.markCompleted({
        inputPostId: "source-post",
        conversationId: "channel-1",
        turnId: "source-post",
        runId: "failed-run",
        outcome: "failed",
      });
      const marker = {
        id: "retry-marker",
        user_id: "bot-user",
        channel_id: "channel-1",
        root_id: "source-post",
        create_at: 500,
        props: {
          octogee: {
            origin: "retry",
            turnId: "source-post",
            retryOfRunId: "failed-run",
            actorMmUserId: "actor-user",
            sourceInputPostId: "source-post",
          },
        },
        message: "untrusted replacement prompt",
      };
      const refetchSourceInput = vi.fn(async (source: MattermostAdmissionInput) => ({
        ...source,
        post: {
          ...source.post,
          message: "refetched trusted prompt",
          file_ids: ["file-1", "file-2"],
        },
      }));
      const service = createMattermostAdmissionService({
        queue,
        botUserId: "bot-user",
        fetchMarkerPost: async () => marker,
        refetchSourceInput,
      });
      const forged = createMattermostAdmissionService({
        queue,
        botUserId: "bot-user",
        fetchMarkerPost: async () => ({ ...marker, user_id: "human-user", id: "forged" }),
        refetchSourceInput: async (source) => source,
      });

      await expect(
        forged.retry({
          failedRunId: "failed-run",
          markerPostId: "forged",
          actorMmUserId: "actor-user",
          idempotencyKey: "retry:failed-run",
        }),
      ).rejects.toThrow("failed authoritative correlation");

      await expect(
        service.retry({
          failedRunId: "failed-run",
          markerPostId: "retry-marker",
          actorMmUserId: "actor-user",
          idempotencyKey: "retry:failed-run",
        }),
      ).resolves.toEqual({
        outcome: "accepted",
        inputPostId: "retry-marker",
        turnId: "source-post",
      });
      await expect(queue.inspect("retry-marker")).resolves.toMatchObject({
        status: "pending",
        payload: {
          inputPostId: "retry-marker",
          senderId: "actor-user",
          origin: "retry",
          retryOfRunId: "failed-run",
          post: { message: "refetched trusted prompt", file_ids: ["file-1", "file-2"] },
        },
      });
      expect(refetchSourceInput).toHaveBeenCalledWith(
        expect.objectContaining({ inputPostId: "source-post" }),
      );
      expect(JSON.stringify(await queue.inspect("retry-marker"))).not.toContain(
        "untrusted replacement prompt",
      );
      await expect(
        service.retry({
          failedRunId: "failed-run",
          markerPostId: "different-marker",
          actorMmUserId: "actor-user",
          idempotencyKey: "retry:failed-run",
        }),
      ).resolves.toEqual({
        outcome: "duplicate",
        inputPostId: "retry-marker",
        turnId: "source-post",
      });
    });
  });
});
