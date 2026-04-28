import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import {
  __testing,
  prewarmToolsEffectiveCacheForStartup,
  toolsEffectiveHandlers,
} from "./tools-effective.js";

const runtimeMocks = vi.hoisted(() => ({
  deliveryContextFromSession: vi.fn(() => ({
    channel: "telegram",
    to: "channel-1",
    accountId: "acct-1",
    threadId: "thread-2",
  })),
  listAgentIds: vi.fn(() => ["main"]),
  getRuntimeConfig: vi.fn(() => ({})),
  loadSessionStore: vi.fn(() => ({})),
  resolveAgentMainSessionKey: vi.fn(({ agentId }: { agentId: string }) => `agent:${agentId}:main`),
  resolveAllAgentSessionStoreTargetsSync: vi.fn(
    (): Array<{ agentId: string; storePath: string }> => [],
  ),
  loadSessionEntry: vi.fn(() => ({
    cfg: {},
    canonicalKey: "main:abc",
    entry: {
      sessionId: "session-1",
      updatedAt: 1,
      lastChannel: "telegram",
      lastAccountId: "acct-1",
      lastThreadId: "thread-2",
      lastTo: "channel-1",
      groupId: "group-4",
      groupChannel: "#ops",
      space: "workspace-5",
      chatType: "group",
      modelProvider: "openai",
      model: "gpt-4.1",
    },
  })),
  getActivePluginChannelRegistryVersion: vi.fn(() => 1),
  getActivePluginRegistryVersion: vi.fn(() => 1),
  resolveRuntimeConfigCacheKey: vi.fn(() => "runtime:1:test"),
  resolveEffectiveToolInventory: vi.fn(() => ({
    agentId: "main",
    profile: "coding",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [
          {
            id: "exec",
            label: "Exec",
            description: "Run shell commands",
            rawDescription: "Run shell commands",
            source: "core",
          },
        ],
      },
    ],
  })),
  resolveReplyToMode: vi.fn(() => "first"),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveSessionModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-4.1" })),
}));

vi.mock("./tools-effective.runtime.js", () => runtimeMocks);

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvokeParams(params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await toolsEffectiveHandlers["tools.effective"]({
        params,
        respond: respond as never,
        context: { getRuntimeConfig: () => ({}) } as never,
        client: null,
        req: { type: "req", id: "req-1", method: "tools.effective" },
        isWebchatConnect: () => false,
      }),
  };
}

describe("tools.effective handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testing.resetToolsEffectiveCacheForTest();
    __testing.resetToolsEffectiveNowForTest();
    __testing.resetToolsEffectiveSchedulersForTest();
    runtimeMocks.getActivePluginChannelRegistryVersion.mockReturnValue(1);
    runtimeMocks.getActivePluginRegistryVersion.mockReturnValue(1);
    runtimeMocks.loadSessionStore.mockReturnValue({});
    runtimeMocks.resolveAllAgentSessionStoreTargetsSync.mockReturnValue([]);
  });

  it("rejects invalid params", async () => {
    const { respond, invoke } = createInvokeParams({ includePlugins: false });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.effective params");
  });

  it("rejects missing sessionKey", async () => {
    const { respond, invoke } = createInvokeParams({});
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.effective params");
  });

  it("rejects caller-supplied auth context params", async () => {
    const { respond, invoke } = createInvokeParams({ senderIsOwner: true });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.effective params");
  });

  it("rejects unknown agent ids", async () => {
    const { respond, invoke } = createInvokeParams({
      sessionKey: "main:abc",
      agentId: "unknown-agent",
    });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("unknown agent id");
  });

  it("rejects unknown session keys", async () => {
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "missing-session",
      entry: undefined,
      legacyKey: undefined,
      storePath: "/tmp/sessions.json",
    } as never);
    const { respond, invoke } = createInvokeParams({ sessionKey: "missing-session" });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('unknown session key "missing-session"');
  });

  it("returns the effective runtime inventory", async () => {
    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      agentId: "main",
      profile: "coding",
      groups: [
        {
          id: "core",
          source: "core",
          tools: [{ id: "exec", source: "core" }],
        },
      ],
    });
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        senderIsOwner: false,
        currentChannelId: "channel-1",
        currentThreadTs: "thread-2",
        accountId: "acct-1",
        groupId: "group-4",
        groupChannel: "#ops",
        groupSpace: "workspace-5",
        replyToMode: "first",
        messageProvider: "telegram",
        modelProvider: "openai",
        modelId: "gpt-4.1",
      }),
    );
  });

  it("resolves cold cache misses synchronously", async () => {
    const { invoke } = createInvokeParams({ sessionKey: "main:abc" });

    const pending = invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);
    await pending;
  });

  it("prewarms startup cache entries for existing session owner states", async () => {
    runtimeMocks.resolveAllAgentSessionStoreTargetsSync.mockReturnValueOnce([
      { agentId: "main", storePath: "/tmp/sessions.json" },
    ]);
    runtimeMocks.loadSessionStore.mockReturnValueOnce({
      "agent:main:main": { sessionId: "session-main", updatedAt: 2_000 },
    });

    const result = prewarmToolsEffectiveCacheForStartup({ cfg: {} });

    expect(result).toMatchObject({
      sessionCount: 1,
      attempted: 2,
      warmed: 2,
      failed: 0,
      skipped: 0,
    });
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionKey: "agent:main:main", senderIsOwner: true }),
    );
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionKey: "agent:main:main", senderIsOwner: false }),
    );

    const nonAdmin = createInvokeParams({ sessionKey: "agent:main:main" });
    await nonAdmin.invoke();
    const adminRespond = vi.fn();
    await toolsEffectiveHandlers["tools.effective"]({
      params: { sessionKey: "agent:main:main" },
      respond: adminRespond as never,
      context: { getRuntimeConfig: () => ({}) } as never,
      client: {
        connect: { scopes: ["operator.admin"] },
      } as never,
      req: { type: "req", id: "req-1", method: "tools.effective" },
      isWebchatConnect: () => false,
    });

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
    expect((nonAdmin.respond.mock.calls[0] as RespondCall | undefined)?.[0]).toBe(true);
    expect((adminRespond.mock.calls[0] as RespondCall | undefined)?.[0]).toBe(true);
  });

  it("serves repeated requests from the fresh inventory cache", async () => {
    const first = createInvokeParams({ sessionKey: "main:abc" });
    await first.invoke();
    const second = createInvokeParams({ sessionKey: "main:abc" });
    await second.invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);
    expect((first.respond.mock.calls[0] as RespondCall | undefined)?.[0]).toBe(true);
    expect((second.respond.mock.calls[0] as RespondCall | undefined)?.[0]).toBe(true);
  });

  it("invalidates the cache when only the channel registry version changes", async () => {
    const first = createInvokeParams({ sessionKey: "main:abc" });
    await first.invoke();

    runtimeMocks.getActivePluginChannelRegistryVersion.mockReturnValue(2);
    const second = createInvokeParams({ sessionKey: "main:abc" });
    await second.invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
    expect((second.respond.mock.calls[0] as RespondCall | undefined)?.[0]).toBe(true);
  });

  it("coalesces identical cache misses while inventory resolution is pending", async () => {
    const first = createInvokeParams({ sessionKey: "main:abc" });
    const second = createInvokeParams({ sessionKey: "main:abc" });

    await Promise.all([first.invoke(), second.invoke()]);

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);
    expect((first.respond.mock.calls[0] as RespondCall | undefined)?.[0]).toBe(true);
    expect((second.respond.mock.calls[0] as RespondCall | undefined)?.[0]).toBe(true);
  });

  it("returns stale cached inventory immediately while refreshing in the background", async () => {
    let now = 1_000;
    __testing.setToolsEffectiveNowForTest(() => now);
    const stalePayload = {
      agentId: "main",
      profile: "coding",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "read",
              label: "Read",
              description: "Read files",
              rawDescription: "Read files",
              source: "core",
            },
          ],
        },
      ],
    };
    const refreshedPayload = {
      agentId: "main",
      profile: "coding",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "exec",
              label: "Exec",
              description: "Run shell commands",
              rawDescription: "Run shell commands",
              source: "core",
            },
          ],
        },
      ],
    };
    runtimeMocks.resolveEffectiveToolInventory
      .mockReturnValueOnce(stalePayload)
      .mockReturnValueOnce(refreshedPayload);

    const initial = createInvokeParams({ sessionKey: "main:abc" });
    await initial.invoke();
    now += 11_000;

    const stale = createInvokeParams({ sessionKey: "main:abc" });
    await stale.invoke();

    expect((stale.respond.mock.calls[0] as RespondCall | undefined)?.[1]).toBe(stalePayload);
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);

    const fresh = createInvokeParams({ sessionKey: "main:abc" });
    await fresh.invoke();
    expect((fresh.respond.mock.calls[0] as RespondCall | undefined)?.[1]).toBe(refreshedPayload);
  });

  it("falls back to synchronous background refresh when setImmediate is delayed", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    __testing.setToolsEffectiveNowForTest(() => now);
    __testing.setToolsEffectiveImmediateSchedulerForTest(() => () => undefined);
    __testing.setToolsEffectiveRefreshFallbackMsForTest(25);

    try {
      const initial = createInvokeParams({ sessionKey: "main:abc" });
      await initial.invoke();
      now += 11_000;

      const stale = createInvokeParams({ sessionKey: "main:abc" });
      await stale.invoke();

      expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(25);

      expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
      expect((stale.respond.mock.calls[0] as RespondCall | undefined)?.[0]).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to origin.threadId when delivery context omits thread metadata", async () => {
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "main:abc",
      entry: {
        sessionId: "session-origin-thread",
        updatedAt: 1,
        lastChannel: "telegram",
        lastAccountId: "acct-1",
        lastTo: "channel-1",
        origin: {
          provider: "telegram",
          accountId: "acct-1",
          threadId: 42,
        },
        groupId: "group-4",
        groupChannel: "#ops",
        space: "workspace-5",
        chatType: "group",
        modelProvider: "openai",
        model: "gpt-4.1",
      },
    } as never);
    runtimeMocks.deliveryContextFromSession.mockReturnValueOnce({
      channel: "telegram",
      to: "channel-1",
      accountId: "acct-1",
      threadId: "42",
    });

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        currentThreadTs: "42",
      }),
    );
    expect((respond.mock.calls[0] as RespondCall | undefined)?.[0]).toBe(true);
  });

  it("passes senderIsOwner=true for admin-scoped callers", async () => {
    const respond = vi.fn();
    await toolsEffectiveHandlers["tools.effective"]({
      params: { sessionKey: "main:abc" },
      respond: respond as never,
      context: { getRuntimeConfig: () => ({}) } as never,
      client: {
        connect: { scopes: ["operator.admin"] },
      } as never,
      req: { type: "req", id: "req-1", method: "tools.effective" },
      isWebchatConnect: () => false,
    });
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledWith(
      expect.objectContaining({ senderIsOwner: true }),
    );
  });

  it("rejects agent ids that do not match the session agent", async () => {
    const { respond, invoke } = createInvokeParams({
      sessionKey: "main:abc",
      agentId: "other",
    });
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "main:abc",
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
      },
    } as never);
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('unknown agent id "other"');
  });
});
