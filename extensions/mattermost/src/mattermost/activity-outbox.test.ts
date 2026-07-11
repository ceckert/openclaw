import type { AgentActivityAppend } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import { createAgentActivityOutbox, type ActivityOutboxQueue } from "./activity-outbox.js";

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

function createQueue(): ActivityOutboxQueue {
  const pending: AgentActivityAppend[] = [];
  return {
    enqueue: vi.fn(async (_id, payload) => {
      pending.push(payload);
      return { kind: "accepted", duplicate: false };
    }),
    recoverStaleClaims: vi.fn(async () => 0),
    claimNext: vi.fn(async () => {
      const payload = pending.shift();
      return payload
        ? { id: payload.envelope.eventKey, payload, claim: { token: "claim-1" } }
        : null;
    }),
    complete: vi.fn(async () => true),
    release: vi.fn(async () => true),
    fail: vi.fn(async () => true),
  };
}

describe("createAgentActivityOutbox", () => {
  it("journals the complete envelope before HTTP delivery", async () => {
    const queue = createQueue();
    const order: string[] = [];
    vi.mocked(queue.enqueue).mockImplementation(async () => {
      order.push("journal");
      return { kind: "accepted", duplicate: false };
    });
    vi.mocked(queue.claimNext).mockResolvedValue({
      id: append.envelope.eventKey,
      payload: append,
      claim: { token: "claim-1" },
    });
    const transport = vi.fn(async () => {
      order.push("http");
      return { status: 201, outcome: "persisted" as const, postIds: ["post-a"] };
    });
    const outbox = createAgentActivityOutbox({ queue, transport });

    await outbox.append(append);
    await outbox.drain();

    expect(order).toEqual(["journal", "http"]);
    expect(queue.complete).toHaveBeenCalledWith(
      expect.objectContaining({ id: "abc123", claim: { token: "claim-1" } }),
      { metadata: { outcome: "persisted", postIds: ["post-a"] } },
    );
  });

  it("releases retryable delivery and quarantines non-retryable delivery", async () => {
    const retryQueue = createQueue();
    const retryOutbox = createAgentActivityOutbox({
      queue: retryQueue,
      transport: vi.fn(async () => ({ status: 503, outcome: "unavailable" as const })),
    });
    await retryOutbox.append(append);
    await retryOutbox.drain();
    expect(retryQueue.release).toHaveBeenCalledWith(expect.anything(), {
      lastError: "activity sink unavailable (503)",
    });
    expect(retryQueue.fail).not.toHaveBeenCalled();

    const rejectedQueue = createQueue();
    const onQuarantine = vi.fn();
    const rejectedOutbox = createAgentActivityOutbox({
      queue: rejectedQueue,
      transport: vi.fn(async () => ({ status: 422, outcome: "rejected" as const })),
      onQuarantine,
    });
    await rejectedOutbox.append(append);
    await rejectedOutbox.drain();
    expect(rejectedQueue.fail).toHaveBeenCalledWith(expect.anything(), {
      reason: "non-retryable-http",
      message: "activity sink rejected envelope (422)",
    });
    expect(onQuarantine).toHaveBeenCalledWith("abc123", 422);
  });

  it("recovers stale claims and serializes concurrent drains", async () => {
    const queue = createQueue();
    const transport = vi.fn(async () => ({
      status: 200,
      outcome: "duplicate" as const,
      postIds: [],
    }));
    const outbox = createAgentActivityOutbox({ queue, transport, staleClaimMs: 30_000 });
    await outbox.append(append);

    await Promise.all([outbox.drain(), outbox.drain(), outbox.drain()]);

    expect(queue.recoverStaleClaims).toHaveBeenCalledWith({ staleMs: 30_000 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
