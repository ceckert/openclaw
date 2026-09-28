// Shared relay test doubles for the talk realtime gateway relay suites.
import { expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import type { RealtimeVoiceBridge } from "../../../talk/provider-types.js";
import { cancelTalkRealtimeRelayTurn } from "./index.js";
import { stopTalkRealtimeRelaySession } from "./operations.js";
import { drainingRelaySessions, relaySessions } from "./state.js";

export function makeRelayTransport<
  Overrides extends Partial<RealtimeVoiceBridge> = Record<never, never>,
>(overrides: Overrides = {} as Overrides) {
  return {
    connect: vi.fn(async () => undefined),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    handleBargeIn: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
    ...overrides,
  };
}

export function createIdleRelayProvider(
  createBridge: RealtimeVoiceProviderPlugin["createBridge"] = () => makeRelayTransport(),
): RealtimeVoiceProviderPlugin {
  return {
    id: "relay-test",
    label: "Relay Test",
    isConfigured: () => true,
    createBridge,
  };
}

export async function drainRelayTestSessions(activeRelaySessions: Map<string, string>) {
  for (const [relaySessionId, connId] of activeRelaySessions) {
    try {
      await stopTalkRealtimeRelaySession({ relaySessionId, connId });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Unknown realtime relay session")) {
        throw error;
      }
    }
  }
  await Promise.all(
    [...drainingRelaySessions].map(
      (session) => session.closing?.completion ?? session.voiceSessionClose ?? Promise.resolve(),
    ),
  );
  activeRelaySessions.clear();
}

export function registerRelayCancellationTests(
  createAbortableRelayRunFixture: (provider?: RealtimeVoiceProviderPlugin) => {
    session: { relaySessionId: string };
    abortController: AbortController;
    broadcast: ReturnType<typeof vi.fn>;
  },
) {
  it("stops speech without aborting the native agent consult", async () => {
    const stopSpeaking = vi.fn();
    const fixture = createAbortableRelayRunFixture(
      createIdleRelayProvider(() => makeRelayTransport({ stopSpeaking })),
    );
    await expect(
      cancelTalkRealtimeRelayTurn({
        relaySessionId: fixture.session.relaySessionId,
        connId: "conn-1",
        reason: "speech-only",
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(stopSpeaking).toHaveBeenCalledOnce();
    expect(fixture.abortController.signal.aborted).toBe(false);
    expect(relaySessions.get(fixture.session.relaySessionId)?.activeAgentRuns.size).toBe(1);
  });

  it.each([undefined, "   "])(
    "preserves legacy current-turn cancellation for turn id %j",
    async (turnId) => {
      const { abortController, broadcast, session } = createAbortableRelayRunFixture();
      const relay = relaySessions.get(session.relaySessionId);
      expect(relay).toBeDefined();
      relay?.harness.talk.startTurn({ turnId: "turn-b" });
      expect(
        await cancelTalkRealtimeRelayTurn({
          relaySessionId: session.relaySessionId,
          connId: "conn-1",
          reason: "barge-in",
          turnId,
        }),
      ).toEqual({ status: "applied", turnId: "turn-b" });

      expect(relay?.harness.talk.activeTurnId).toBeUndefined();
      expect(abortController.signal.aborted).toBe(true);
      expect(broadcast).toHaveBeenCalled();
    },
  );
}
