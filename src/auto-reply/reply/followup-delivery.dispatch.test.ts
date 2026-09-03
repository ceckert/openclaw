import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import { deliverFollowupDecision } from "./followup-delivery.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";

const deliveryState = vi.hoisted(() => ({
  followupRoute: undefined as { route: "dispatcher" | "origin" | "drop" } | undefined,
  routeReply: vi.fn(),
  runtimeError: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
  getLoadedChannelPlugin: () => undefined,
}));

vi.mock("../../agents/runtime-plan/build.js", () => ({
  buildAgentRuntimeDeliveryPlan: () => ({
    isSilentPayload: () => false,
    resolveFollowupRoute: () => deliveryState.followupRoute,
  }),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: (...args: unknown[]) => deliveryState.runtimeError(...args) },
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) => channel === "discord" || channel === "slack",
  routeReply: (...args: unknown[]) => deliveryState.routeReply(...args),
}));

function createTurn(overrides: Partial<AdmittedFollowupTurn> = {}): AdmittedFollowupTurn {
  return {
    runId: "run-1",
    queued: {
      prompt: "queued",
      enqueuedAt: 1,
      originatingChannel: "discord",
      originatingTo: "channel:C1",
      run: {
        agentId: "agent",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey: "main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        provider: "anthropic",
        model: "claude",
        messageProvider: "discord",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: {} as AdmittedFollowupTurn["operation"],
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => undefined,
      publish: () => undefined,
      adopt: () => undefined,
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
    ...overrides,
  };
}

describe("deliverFollowupDecision", () => {
  const createDefaults = (onBlockReply: (payload: ReplyPayload) => Promise<void>) => ({
    defaultModel: "claude",
    typingMode: "never" as const,
    typing: {
      onReplyStart: vi.fn(async () => {}),
      startTypingLoop: vi.fn(async () => {}),
      startTypingOnText: vi.fn(async () => {}),
      refreshTypingTtl: vi.fn(),
      isActive: vi.fn(() => false),
      markRunComplete: vi.fn(),
      markDispatchIdle: vi.fn(),
      cleanup: vi.fn(),
    },
    opts: { onBlockReply },
  });

  const createQueuedReplyObserver = () => ({
    onAgentRunStart: vi.fn(),
    onAgentRunTerminalOutcome: vi.fn(),
    onFinalReplyStart: vi.fn(),
    onFinalReplyDelivered: vi.fn(),
    onFinalReplyFailed: vi.fn(),
    onDispatcherSettled: vi.fn(),
  });

  it("keeps dispatcher-only delivery out of a routable origin", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.followupRoute = { route: "dispatcher" };
    deliveryState.routeReply.mockReset();

    try {
      await deliverFollowupDecision({
        decision: { kind: "deliver", payloads: [{ text: "dispatcher only" }] },
        turn: createTurn(),
        defaults: createDefaults(onBlockReply),
        runId: "run-1",
        runFollowup: vi.fn(async () => {}),
      });

      expect(onBlockReply).toHaveBeenCalledOnce();
      expect(deliveryState.routeReply).not.toHaveBeenCalled();
    } finally {
      deliveryState.followupRoute = undefined;
    }
  });

  it("keeps a queued WebChat reply bound to its original source dispatcher", async () => {
    const laterDispatcher = vi.fn(async (_payload: ReplyPayload) => {});
    const sourceDispatcher = vi.fn(async () => {});
    const turn = createTurn();
    turn.queued.originatingChannel = "webchat";
    turn.queued.originatingTo = undefined;
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: sourceDispatcher };
    deliveryState.followupRoute = { route: "dispatcher" };
    try {
      await deliverFollowupDecision({
        decision: { kind: "deliver", payloads: [{ text: "one" }, { text: "two" }] },
        turn,
        defaults: createDefaults(laterDispatcher),
        runId: "source-run",
        runFollowup: vi.fn(async () => {}),
      });
      expect(sourceDispatcher).toHaveBeenCalledWith({
        kind: "queued-followup",
        runId: "source-run",
        originatingChannel: "webchat",
        payloads: [{ text: "one" }, { text: "two" }],
      });
      turn.queued.queuedFollowupReplyDisposition = {
        kind: "drop",
        reason: "source-unavailable",
      };
      await deliverFollowupDecision({
        decision: { kind: "deliver", payloads: [{ text: "must stay dropped" }] },
        turn,
        defaults: createDefaults(laterDispatcher),
        runId: "dropped-run",
        runFollowup: vi.fn(async () => {}),
      });
      expect(laterDispatcher).not.toHaveBeenCalled();
    } finally {
      deliveryState.followupRoute = undefined;
    }
  });

  it("reports an exact routed receipt to the queued source observer", async () => {
    const laterDispatcher = vi.fn(async (_payload: ReplyPayload) => {});
    const observer = createQueuedReplyObserver();
    const turn = createTurn();
    turn.queued.queuedFollowupReplyDisposition = { kind: "observe", observer };
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockImplementation(async (params) => {
      await params.onDeliveryResult?.({
        channel: "discord",
        messageId: "answer-1",
        receipt: {
          primaryPlatformMessageId: "answer-1",
          platformMessageIds: ["answer-1", "answer-2"],
          parts: [
            { platformMessageId: "answer-1", kind: "text", index: 0, replyToId: "thread-1" },
            { platformMessageId: "answer-2", kind: "media", index: 1, replyToId: "thread-1" },
          ],
          replyToId: "thread-1",
          sentAt: 123,
        },
      });
      return { ok: true, delivered: true, messageId: "answer-2" };
    });

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "source answer" }] },
      turn,
      defaults: createDefaults(laterDispatcher),
      runId: "source-run",
      runFollowup: vi.fn(async () => {}),
    });

    expect(observer.onFinalReplyStart).toHaveBeenCalledOnce();
    expect(observer.onFinalReplyDelivered).toHaveBeenCalledWith(
      expect.objectContaining({
        visibleReplySent: true,
        messageIds: ["answer-1", "answer-2"],
        receipt: expect.objectContaining({
          replyToId: "thread-1",
          parts: [
            expect.objectContaining({ platformMessageId: "answer-1", kind: "text", index: 0 }),
            expect.objectContaining({ platformMessageId: "answer-2", kind: "media", index: 1 }),
          ],
        }),
      }),
    );
    expect(observer.onFinalReplyFailed).not.toHaveBeenCalled();
    expect(observer.onDispatcherSettled).toHaveBeenCalledOnce();
    expect(laterDispatcher).not.toHaveBeenCalled();
  });

  it("settles a suppressed queued source without starting delivery", async () => {
    const observer = createQueuedReplyObserver();
    const turn = createTurn();
    turn.queued.queuedFollowupReplyDisposition = { kind: "observe", observer };

    await deliverFollowupDecision({
      decision: { kind: "suppress", reason: "silent" },
      turn,
      defaults: createDefaults(vi.fn(async () => {})),
      runId: "source-run",
      runFollowup: vi.fn(async () => {}),
    });

    expect(observer.onFinalReplyStart).not.toHaveBeenCalled();
    expect(observer.onFinalReplyDelivered).toHaveBeenCalledExactlyOnceWith({
      visibleReplySent: false,
      suppression: { reason: "silent" },
    });
    expect(observer.onFinalReplyFailed).not.toHaveBeenCalled();
    expect(observer.onDispatcherSettled).toHaveBeenCalledOnce();
  });

  it("settles a contentless queued source as suppressed", async () => {
    const observer = createQueuedReplyObserver();
    const turn = createTurn();
    turn.queued.queuedFollowupReplyDisposition = { kind: "observe", observer };

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "" }] },
      turn,
      defaults: createDefaults(vi.fn(async () => {})),
      runId: "source-run",
      runFollowup: vi.fn(async () => {}),
    });

    expect(observer.onFinalReplyStart).not.toHaveBeenCalled();
    expect(observer.onFinalReplyDelivered).toHaveBeenCalledExactlyOnceWith({
      visibleReplySent: false,
      suppression: { reason: "queued_followup_suppressed" },
    });
    expect(observer.onFinalReplyFailed).not.toHaveBeenCalled();
    expect(observer.onDispatcherSettled).toHaveBeenCalledOnce();
  });

  it("settles a failed queued source exactly once", async () => {
    const observer = createQueuedReplyObserver();
    const turn = createTurn();
    turn.queued.queuedFollowupReplyDisposition = { kind: "observe", observer };
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockRejectedValue(new Error("offline"));

    await expect(
      deliverFollowupDecision({
        decision: { kind: "deliver", payloads: [{ text: "source answer" }] },
        turn,
        defaults: createDefaults(vi.fn(async () => {})),
        runId: "source-run",
        runFollowup: vi.fn(async () => {}),
      }),
    ).rejects.toThrow("offline");

    expect(observer.onFinalReplyStart).toHaveBeenCalledOnce();
    expect(observer.onFinalReplyDelivered).not.toHaveBeenCalled();
    expect(observer.onFinalReplyFailed).toHaveBeenCalledExactlyOnceWith({
      visibleReplySent: false,
    });
    expect(observer.onDispatcherSettled).toHaveBeenCalledOnce();
  });

  it("allows the latest same-channel dispatcher to recover a route failure", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockResolvedValue({
      ok: false,
      delivered: false,
      error: "offline",
    });
    const turn = createTurn();
    turn.queued.run.messageProvider = "discord";

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "same-channel reply" }] },
      turn,
      defaults: createDefaults(onBlockReply),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "same-channel reply" }),
    );
  });

  it("keeps block-status delivery out of the assistant transcript", async () => {
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockResolvedValue({ ok: true, delivered: true });

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "compacting" }] },
      turn: createTurn(),
      defaults: createDefaults(vi.fn(async (_payload: ReplyPayload) => {})),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
      kind: "block",
    });

    expect(deliveryState.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({ mirror: false, replyKind: "block" }),
    );
  });

  it("reports an origin delivery failure when no dispatcher can recover it", async () => {
    deliveryState.routeReply.mockReset();
    deliveryState.runtimeError.mockReset();
    deliveryState.routeReply.mockResolvedValue({
      ok: false,
      delivered: false,
      error: "offline",
    });

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "undelivered" }] },
      turn: createTurn(),
      defaults: {
        defaultModel: "claude",
        typingMode: "never",
        typing: createDefaults(vi.fn(async (_payload: ReplyPayload) => {})).typing,
      },
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(deliveryState.runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("route-reply failed: offline"),
    );
  });

  it("does not duplicate a follow-up after a partial route failure delivered it", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockResolvedValue({
      ok: false,
      delivered: true,
      error: "later chunk failed",
    });
    const turn = createTurn();
    turn.queued.run.messageProvider = "discord";

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "already delivered" }] },
      turn,
      defaults: createDefaults(onBlockReply),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("does not retry a channel-transform-suppressed routed follow-up", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockResolvedValue({
      ok: true,
      delivered: false,
      suppressed: true,
      reason: "channel_transform",
    });

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "private reply" }] },
      turn: createTurn(),
      defaults: createDefaults(onBlockReply),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });
});
