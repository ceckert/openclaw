import type { ChannelConsultIngressBinding } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it, vi } from "vitest";
import { dispatchMattermostInboundTurn } from "./monitor-turn.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

vi.mock("./runtime-api.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createChannelMessageReplyPipeline: () => ({ typingCallbacks: {} }),
}));
vi.mock("./monitor-draft-delivery.js", () => ({
  deliverMattermostReplyWithDraftPreview: async () => ({ visibleReplySent: true }),
}));

function fixture(run: (params: Record<string, any>) => Promise<void>) {
  const route = {
    agentId: "coach",
    accountId: "default",
    sessionKey: "agent:coach:mattermost:group:room",
    mainSessionKey: "agent:coach:main",
  };
  const callbacks: ChannelConsultIngressBinding["callbacks"] = {
    onAgentRunStart: vi.fn(),
    onPartialReply: vi.fn(),
    onAssistantMessageStart: vi.fn(),
    onFinalReply: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
  };
  const monitor = {
    account: { accountId: "default", config: {}, streamingMode: "off" },
    cfg: {},
    client: {},
    runtime: { error: vi.fn() },
    logVerboseMessage: vi.fn(),
    core: { channel: { text: { resolveChunkMode: () => "length" }, inbound: { run } } },
  } as unknown as MattermostMonitorContext;
  const params = {
    post: { id: "post", channel_id: "room", user_id: "builder", message: "news" },
    rawText: "news",
    ctxPayload: { BodyForAgent: "news" },
    eventPlan: {
      channelId: "room",
      kind: "group",
      route,
      senderId: "builder",
      thread: {},
      to: "channel:room",
      createReplyPlan: () => ({
        replyOptions: {},
        replyPipeline: { typing: { start: async () => {} } },
        tableMode: "off",
        textLimit: 4000,
      }),
    },
    historyKey: null,
    historyLimit: 0,
    channelHistories: new Map(),
    pinnedMainDmOwner: null,
    consultIngress: { context: {}, callbacks },
  } as unknown as Parameters<typeof dispatchMattermostInboundTurn>[1];
  return { monitor, params, callbacks };
}

describe("Mattermost native consult turn observation", () => {
  it("reports the exact run and final reply before completing the admitted turn", async () => {
    const f = fixture(async ({ adapter }) => {
      const turn = adapter.resolveTurn();
      turn.replyOptions.onAgentRunStart("actual-native-run");
      await turn.replyOptions.onAssistantMessageStart();
      await turn.replyOptions.onPartialReply({ text: "Reading" });
      await turn.delivery.deliver({ text: "The final briefing" }, { kind: "final" });
      expect(f.callbacks.onComplete).not.toHaveBeenCalled();
    });
    await dispatchMattermostInboundTurn(f.monitor, f.params);
    expect(f.callbacks.onAgentRunStart).toHaveBeenCalledWith("actual-native-run");
    expect(f.callbacks.onAssistantMessageStart).toHaveBeenCalledOnce();
    expect(f.callbacks.onPartialReply).toHaveBeenCalledWith({ text: "Reading" });
    expect(f.callbacks.onFinalReply).toHaveBeenCalledWith({ text: "The final briefing" });
    expect(f.callbacks.onComplete).toHaveBeenCalledOnce();
    expect(f.callbacks.onError).not.toHaveBeenCalled();
  });
  it("reports native turn failure and never completes a failed consult", async () => {
    const error = new Error("native dispatch failed");
    const f = fixture(async () => {
      throw error;
    });
    await expect(dispatchMattermostInboundTurn(f.monitor, f.params)).rejects.toBe(error);
    expect(f.callbacks.onError).toHaveBeenCalledWith(error);
    expect(f.callbacks.onComplete).not.toHaveBeenCalled();
  });
});
