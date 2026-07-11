import { describe, expect, it, vi } from "vitest";
import {
  classifyMattermostAdmission,
  createMattermostAdmissionService,
  type MattermostAdmissionQueue,
} from "./admission.js";

function createQueue(): MattermostAdmissionQueue {
  return {
    enqueue: vi.fn(async () => ({ kind: "accepted", duplicate: false })),
    listPending: vi.fn(async () => []),
    listClaims: vi.fn(async () => []),
    inspect: vi.fn(async () => null),
    cancelPending: vi.fn(async () => ({ outcome: "canceled", revision: 2 })),
    claim: vi.fn(async () => null),
    complete: vi.fn(async () => true),
    annotateCompleted: vi.fn(async () => null),
    listCompleted: vi.fn(async () => []),
  };
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
      Array.from({ length: 100 }, (_, index) => ({ id: `pending-${index}` })),
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
