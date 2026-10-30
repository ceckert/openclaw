import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createLazyRealtimeVoiceBridgeLifecycle } from "../plugin-sdk/realtime-voice-provider.js";
import type {
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceGatewayRelayConnection,
  RealtimeVoiceGatewayRelayTransport,
} from "./provider-types.js";
import { createRealtimeVoiceBridgeSession } from "./session-runtime.js";
import { makeBridge, makeVoiceProvider } from "./session-runtime.test-support.js";

async function bindTransport(
  owner: "session" | "lazy",
  transport: RealtimeVoiceGatewayRelayTransport,
) {
  let captured: RealtimeVoiceBridgeCreateRequest | undefined;
  const bridge = makeBridge();
  const capture = (request: RealtimeVoiceBridgeCreateRequest) => {
    captured = request;
    return bridge;
  };
  const runtime =
    owner === "session"
      ? createRealtimeVoiceBridgeSession({
          provider: makeVoiceProvider(capture),
          providerConfig: {},
          gatewayRelayTransport: transport,
          audioSink: { sendAudio: vi.fn() },
        })
      : createLazyRealtimeVoiceBridgeLifecycle({
          label: "Fixture",
          request: {
            providerConfig: {},
            gatewayRelayTransport: transport,
            onAudio: vi.fn(),
            onClearAudio: vi.fn(),
          },
          load: async (request) => capture(request),
          clearPending: vi.fn(),
        });
  await runtime.connect();
  const prepare = captured?.gatewayRelayTransport;
  if (!prepare) {
    throw new Error("Native host did not bind the gateway transport");
  }
  return { runtime, prepare };
}

function input(signal = new AbortController().signal) {
  return {
    providerId: "fixture",
    agentId: "main",
    model: "fixture-live",
    url: "wss://provider.example.test/live",
    signal,
  };
}

const connection: RealtimeVoiceGatewayRelayConnection = {
  url: "wss://broker.example.test/live",
  headers: { "x-fixture-token": "synthetic" },
};

it.each(["session", "lazy"] as const)(
  "%s owns transport preparation and refuses a retained callback after close",
  async (owner) => {
    const transport = vi.fn<RealtimeVoiceGatewayRelayTransport>(() => connection);
    const { runtime, prepare } = await bindTransport(owner, transport);
    const request = input();
    try {
      expect(await prepare(request)).toBe(connection);
      expect(transport).toHaveBeenCalledExactlyOnceWith(request);
      await runtime.close({ disposition: "detach" });
      await expect(prepare(request)).rejects.toThrow(/session (?:is )?closed/);
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
  },
);

it.each(["session", "lazy"] as const)(
  "%s refuses prepared credentials when closed during transport preparation",
  async (owner) => {
    const pending = createDeferred<RealtimeVoiceGatewayRelayConnection>();
    const transport = vi.fn<RealtimeVoiceGatewayRelayTransport>(() => pending.promise);
    const { runtime, prepare } = await bindTransport(owner, transport);
    const prepared = prepare(input());
    const refusal = expect(prepared).rejects.toThrow(/session (?:is )?closed/);
    try {
      expect(transport).toHaveBeenCalledOnce();
      await runtime.close({ disposition: "detach" });
      pending.resolve(connection);
      await refusal;
    } finally {
      pending.resolve(connection);
      await runtime.close();
    }
  },
);

it.each(["session", "lazy"] as const)(
  "%s refuses aborted connection preparation before credentials are read and after awaiting",
  async (owner) => {
    const pending = createDeferred<RealtimeVoiceGatewayRelayConnection>();
    const transport = vi.fn<RealtimeVoiceGatewayRelayTransport>(() => pending.promise);
    const { runtime, prepare } = await bindTransport(owner, transport);
    try {
      await expect(
        prepare(input(AbortSignal.abort(new Error("Already cancelled")))),
      ).rejects.toThrow("Already cancelled");
      expect(transport).not.toHaveBeenCalled();
      const controller = new AbortController();
      const prepared = prepare(input(controller.signal));
      const refusal = expect(prepared).rejects.toThrow("Connection cancelled");
      controller.abort(new Error("Connection cancelled"));
      pending.resolve(connection);
      await refusal;
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      pending.resolve(connection);
      await runtime.close();
    }
  },
);
