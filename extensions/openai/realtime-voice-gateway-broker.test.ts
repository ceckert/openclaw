import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const transport = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; headers: unknown; maxPayload: unknown }>,
  resolveAuth: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  resolveProviderAuthProfileApiKey: transport.resolveAuth,
}));
vi.mock("./realtime-quicksilver-socket.js", async (importOriginal) => {
  const { fakeQuicksilverMediaSocket } =
    await import("./realtime-quicksilver-socket.test-support.js");
  const { FakeSocket, emitSideband } = await import("./realtime-quicksilver.test-helpers.js");
  return {
    ...(await importOriginal<typeof import("./realtime-quicksilver-socket.js")>()),
    OpenAIQuicksilverWorkerSocket: {
      create: fakeQuicksilverMediaSocket((url, options) => {
        transport.requests.push({ url, headers: options.headers, maxPayload: options.maxPayload });
        const socket = new FakeSocket("manual");
        const send = socket.send.bind(socket);
        socket.send = (payload) => {
          send(payload);
          const event = JSON.parse(payload) as { type: string };
          if (event.type === "session.start") {
            queueMicrotask(() => emitSideband(socket, { type: "session.started", session: {} }));
          } else if (event.type === "session.close") {
            queueMicrotask(() =>
              emitSideband(socket, { type: "session.closed", reason: "close_requested" }),
            );
          }
        };
        queueMicrotask(() => {
          socket.readyState = 1;
          socket.emit("open");
        });
        return socket;
      }),
    },
  };
});

function request() {
  return {
    providerConfig: { model: "gpt-live-1", voice: "marin" },
    agentId: "coach-a",
    runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    onReady: vi.fn(),
  } satisfies RealtimeVoiceBridgeCreateRequest;
}

function brokerConnection() {
  return {
    url: "wss://broker.example.test/internal/voice/live",
    headers: { "x-tenant-token": "synthetic-tenant-token" },
    maxPayloadBytes: 512 * 1024,
  };
}

describe("native voice gateway broker transport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("OPENAI_API_KEY", "");
    transport.requests.length = 0;
    transport.resolveAuth.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("uses the native media owner with broker auth without obtaining a provider key", async () => {
    const source = request();
    const gatewayRelayTransport = vi.fn(async () => brokerConnection());
    const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
      ...source,
      gatewayRelayTransport,
    });
    try {
      await bridge.connect();
      expect(gatewayRelayTransport).toHaveBeenCalledExactlyOnceWith({
        providerId: "openai",
        agentId: "coach-a",
        model: "gpt-live-1",
        url: "wss://api.openai.com/v1/live/sessions",
        signal: expect.any(AbortSignal),
      });
      expect(transport.requests).toEqual([
        {
          url: brokerConnection().url,
          headers: brokerConnection().headers,
          maxPayload: 512 * 1024,
        },
      ]);
      expect(transport.resolveAuth).not.toHaveBeenCalled();
      expect(source.onReady).toHaveBeenCalledOnce();
      expect(bridge.outputAudioMode).toBe("continuous");
      expect(bridge.pacesInputAudio).toBe(true);
    } finally {
      await bridge.close({ disposition: "detach" });
    }
  });

  it.each([
    { model: "gpt-realtime-2.1", agentId: "coach-a", runAgentConsult: true },
    { model: "gpt-live-1-codex", agentId: "coach-a", runAgentConsult: true },
    { model: "gpt-live-1", agentId: undefined, runAgentConsult: true },
    { model: "gpt-live-1", agentId: "coach-a", runAgentConsult: false },
  ])("refuses incompatible broker launch before credentials or wire I/O: %j", (input) => {
    const gatewayRelayTransport = vi.fn(async () => brokerConnection());
    const source = request();
    expect(() =>
      buildOpenAIRealtimeVoiceProvider().createBridge({
        ...source,
        providerConfig: { model: input.model },
        agentId: input.agentId,
        runAgentConsult: input.runAgentConsult ? source.runAgentConsult : undefined,
        gatewayRelayTransport,
      }),
    ).toThrow("broker transport requires an agent-owned GPT-Live API relay");
    expect(gatewayRelayTransport).not.toHaveBeenCalled();
    expect(transport.resolveAuth).not.toHaveBeenCalled();
    expect(transport.requests).toEqual([]);
  });

  it("does not adopt a broker connection resolved after native close", async () => {
    const pending = Promise.withResolvers<ReturnType<typeof brokerConnection>>();
    const admitted = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
      ...request(),
      gatewayRelayTransport: async (input) => {
        signal = input.signal;
        admitted.resolve();
        return pending.promise;
      },
    });
    const connecting = bridge.connect();
    const rejected = expect(connecting).rejects.toThrow();
    await admitted.promise;
    await bridge.close();
    pending.resolve(brokerConnection());
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(transport.requests).toEqual([]);
    expect(transport.resolveAuth).not.toHaveBeenCalled();
  });
});
