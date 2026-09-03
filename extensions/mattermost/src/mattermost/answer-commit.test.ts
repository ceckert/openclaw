import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { MessageReceipt } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import { createMattermostAnswerCommitController } from "./answer-commit.js";

const identity = {
  conversationId: "channel-1",
  turnId: "input-1",
  agentId: "main",
  sessionKey: "agent:main:mattermost:group:channel-1",
  origin: "human" as const,
  mainChannelId: "channel-1",
  mainRootPostId: "input-1",
  inputPostId: "input-1",
};

function receipt(ids: string[], kind: "text" | "media" | "preview" = "text"): MessageReceipt {
  return {
    primaryPlatformMessageId: ids[0],
    platformMessageIds: ids,
    parts: ids.map((platformMessageId, index) => ({
      platformMessageId,
      kind,
      index,
      replyToId: "input-1",
      threadId: "input-1",
    })),
    replyToId: "input-1",
    threadId: "input-1",
    sentAt: 123,
  };
}

describe("Mattermost answer commit controller", () => {
  it("binds the exact run early and commits ordered settled receipts only after terminal and dispatcher settlement", () => {
    const emit = vi.fn();
    const controller = createMattermostAnswerCommitController({ identity, emit });

    controller.start("run-1");
    controller.beginFinalDelivery();
    controller.beginFinalDelivery();
    controller.terminal("completed");
    controller.settleQueuedDispatcher();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenNthCalledWith(1, {
      runId: "run-1",
      agentId: "main",
      sessionKey: identity.sessionKey,
      stream: "delivery",
      data: {
        schemaVersion: 1,
        kind: "mattermost-turn-binding",
        ...identity,
        runId: "run-1",
      },
    });

    controller.settleFinalDelivery({
      visibleReplySent: true,
      receipt: receipt(["preview-1", "text-1"], "preview"),
    });
    controller.settleFinalDelivery({
      visibleReplySent: true,
      receipt: receipt(["text-1", "media-1"], "media"),
    });

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(2, {
      runId: "run-1",
      agentId: "main",
      sessionKey: identity.sessionKey,
      stream: "delivery",
      data: {
        schemaVersion: 1,
        kind: "answer-commit",
        ...identity,
        runId: "run-1",
        terminalOutcome: "completed",
        deliveryOutcome: "delivered",
        postIds: ["preview-1", "text-1", "media-1"],
        parts: [
          {
            postId: "preview-1",
            kind: "preview",
            index: 0,
            rootPostId: "input-1",
            threadId: "input-1",
          },
          {
            postId: "text-1",
            kind: "preview",
            index: 1,
            rootPostId: "input-1",
            threadId: "input-1",
          },
          {
            postId: "media-1",
            kind: "media",
            index: 2,
            rootPostId: "input-1",
            threadId: "input-1",
          },
        ],
      },
    });
  });

  it("preserves accepted ids as a partial outcome when final settlement fails", () => {
    const emit = vi.fn();
    const controller = createMattermostAnswerCommitController({ identity, emit });
    controller.start("run-2");
    controller.beginFinalDelivery();
    controller.terminal("failed");
    controller.failFinalDelivery(
      createChannelPartialDeliveryError(new Error("later send failed"), {
        visibleReplySent: true,
        receipt: receipt(["text-1", "media-1"]),
      }),
    );
    controller.settleDispatcher();

    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({
      stream: "delivery",
      data: {
        kind: "answer-commit",
        terminalOutcome: "failed",
        deliveryOutcome: "partial",
        postIds: ["text-1", "media-1"],
      },
    });
  });

  it("reports suppressed, unattempted, and receipt-less visible delivery explicitly", () => {
    const events: unknown[] = [];
    const make = () =>
      createMattermostAnswerCommitController({
        identity,
        emit: (event) => events.push(event),
      });

    const suppressed = make();
    suppressed.start("suppressed");
    suppressed.terminal("completed");
    suppressed.settleFinalDelivery({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
    suppressed.settleDispatcher();

    const unattempted = make();
    unattempted.start("unattempted");
    unattempted.settleDispatcher();

    const unknown = make();
    unknown.start("unknown");
    unknown.beginFinalDelivery();
    unknown.terminal("completed");
    unknown.settleFinalDelivery({ visibleReplySent: true });
    unknown.settleDispatcher();

    const commits = events
      .map((event) => event as { data: Record<string, unknown> })
      .filter((event) => event.data.kind === "answer-commit")
      .map((event) => event.data);
    expect(commits).toEqual([
      expect.objectContaining({ deliveryOutcome: "suppressed", postIds: [], parts: [] }),
      expect.objectContaining({ deliveryOutcome: "not-attempted", postIds: [], parts: [] }),
      expect.objectContaining({ deliveryOutcome: "failed", postIds: [], parts: [] }),
    ]);
  });

  it("does not emit an answer commit before an actual run starts", () => {
    const emit = vi.fn();
    const controller = createMattermostAnswerCommitController({ identity, emit });
    controller.terminal("failed");
    controller.settleDispatcher();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not commit a settled queued delivery before its run is terminal", () => {
    const emit = vi.fn();
    const controller = createMattermostAnswerCommitController({ identity, emit });
    controller.start("run-queued");
    controller.beginFinalDelivery();
    controller.settleFinalDelivery({
      visibleReplySent: true,
      receipt: receipt(["answer-queued"]),
    });
    controller.settleQueuedDispatcher();

    expect(emit).toHaveBeenCalledTimes(1);

    controller.terminal("completed");

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({
      runId: "run-queued",
      data: {
        kind: "answer-commit",
        terminalOutcome: "completed",
        deliveryOutcome: "delivered",
        postIds: ["answer-queued"],
      },
    });
  });

  it("binds a nested human follow-up to its existing turn root and exact child input", () => {
    const emit = vi.fn();
    const controller = createMattermostAnswerCommitController({
      identity: {
        ...identity,
        inputPostId: "input-child-2",
      },
      emit,
    });

    controller.start("run-child");

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "mattermost-turn-binding",
          turnId: "input-1",
          mainRootPostId: "input-1",
          inputPostId: "input-child-2",
        }),
      }),
    );
  });
});
