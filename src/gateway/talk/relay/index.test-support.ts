// Shared relay test doubles for the talk realtime gateway relay suites.
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import * as clientVoiceSession from "../../../talk/client-voice-session.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../../../talk/provider-types.js";
import {
  cancelTalkRealtimeRelayTurn,
  registerTalkRealtimeRelayAgentRun,
  stopTalkRealtimeRelaySession,
} from "./operations.js";
import { drainingRelaySessions, relaySessions } from "./state.js";

export function createRelayAgentConfig(agentId: "main" | "ops"): OpenClawConfig {
  return {
    agents: { entries: { main: {}, ops: {} } },
    talk: { agentId },
  };
}

export function makeRelayTransport<Overrides extends Partial<RealtimeVoiceBridge> = object>(
  overrides: Overrides = {} as Overrides,
) {
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

export function ensureActiveRelayTurnId(relaySessionId: string): string {
  const relay = relaySessions.get(relaySessionId);
  if (!relay) {
    throw new Error(`Missing relay test session ${relaySessionId}`);
  }
  if (!relay.harness.talk.activeTurnId) {
    relay.harness.talk.startTurn({ turnId: "turn-1" });
  }
  return relay.harness.talk.activeTurnId ?? "turn-1";
}

export function observeRelayTranscriptFailures() {
  const failures = [createDeferred(), createDeferred()] as const;
  const append = clientVoiceSession.appendRelayVoiceTranscript;
  let attempt = 0;
  const observer = vi
    .spyOn(clientVoiceSession, "appendRelayVoiceTranscript")
    .mockImplementation((...args) => {
      const failure = failures[attempt++];
      const pending = append(...args);
      if (failure) {
        void pending.then(
          () => failure.reject(new Error("Expected relay transcript append failure")),
          () => failure.resolve(),
        );
      }
      return pending;
    });
  return {
    afterAttempt: (index: 0 | 1) => failures[index].promise,
    restore: () => observer.mockRestore(),
  };
}

export function registerRelayCancellationTests(
  createAbortableRelayRunFixture: (
    provider?: RealtimeVoiceProviderPlugin,
    options?: { register: boolean },
  ) => Promise<{
    session: { relaySessionId: string };
    abortController: AbortController;
    broadcast: ReturnType<typeof vi.fn>;
  }>,
) {
  it.each([
    { label: "provider", source: "provider", accepted: true },
    { label: "turn with an accepted result", source: "turn", accepted: true },
    { label: "turn with a pending result", source: "turn", accepted: false },
  ])("aborts a consult that registers after $label cancellation", async ({ source, accepted }) => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const cancellationAccepted = createDeferred();
    const provider = createIdleRelayProvider((request) => {
      bridgeRequest = request;
      return makeRelayTransport({
        submitToolResult: vi.fn(() => cancellationAccepted.promise),
      });
    });
    const fixture = await createAbortableRelayRunFixture(provider, { register: false });
    await Promise.resolve();
    bridgeRequest?.onToolCall?.({
      itemId: "call-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "status?" },
    });
    try {
      if (source === "provider") {
        bridgeRequest?.onEvent?.({
          direction: "server",
          type: "tool.call.cancelled",
          itemId: "call-1",
        });
      } else {
        const cancelled = cancelTalkRealtimeRelayTurn({
          relaySessionId: fixture.session.relaySessionId,
          connId: "conn-1",
          reason: "user",
        });
        bridgeRequest?.onEvent?.({ direction: "server", type: "response.cancelled" });
        await cancelled;
        expect(relaySessions.has(fixture.session.relaySessionId)).toBe(true);
        if (accepted) {
          cancellationAccepted.resolve();
          await nextEventLoopTurn();
        }
      }

      await expect(
        registerTalkRealtimeRelayAgentRun({
          relaySessionId: fixture.session.relaySessionId,
          connId: "conn-1",
          sessionKey: "main",
          runId: "run-1",
          callId: "call-1",
        }),
      ).rejects.toThrow("Realtime provider cancelled the tool call before run registration");
      expect(fixture.abortController.signal.aborted).toBe(true);
      const relay = relaySessions.get(fixture.session.relaySessionId);
      expect(relay?.activeAgentRuns.size).toBe(0);
      expect(relay?.activeAgentToolCalls.size).toBe(0);
      if (source === "provider") {
        expect(relay?.providerToolCallIds.size).toBe(0);
        expect(relay?.relayToolCallIdsByProviderId.size).toBe(0);
      }
    } finally {
      cancellationAccepted.resolve();
      await nextEventLoopTurn();
    }
  });

  it.each([undefined, "   "])(
    "preserves legacy current-turn cancellation for turn id %j",
    async (turnId) => {
      const { abortController, broadcast, session } = await createAbortableRelayRunFixture();
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
