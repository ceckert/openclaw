// octogee fork patch test — env-gated diagnostic-event broadcast.
// Mirrors the precedent (isControlUiVisible / agent-events.test.ts): assert
// vanilla byte-identical when the gate is unset, and correct allowlist
// behaviour when set. Only `broadcast` is exercised; the agent/heartbeat/
// transcript/lifecycle handlers are lazy and never fire here (we emit only
// diagnostic events), so the registry params are minimal casts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import type {
  ChatRunState,
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
  ToolEventRecipientRegistry,
} from "./server-chat-state.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";

function startSubs(broadcast: ReturnType<typeof vi.fn>) {
  return startGatewayEventSubscriptions({
    broadcast: broadcast as unknown as (
      event: string,
      payload: unknown,
      opts?: { dropIfSlow?: boolean },
    ) => void,
    broadcastToConnIds: vi.fn() as unknown as (
      event: string,
      payload: unknown,
      connIds: ReadonlySet<string>,
      opts?: { dropIfSlow?: boolean },
    ) => void,
    nodeSendToSession: vi.fn() as unknown as (
      sessionKey: string,
      event: string,
      payload: unknown,
    ) => void,
    agentRunSeq: new Map<string, number>(),
    chatRunState: {} as unknown as ChatRunState,
    toolEventRecipients: {} as unknown as ToolEventRecipientRegistry,
    sessionEventSubscribers: {} as unknown as SessionEventSubscriberRegistry,
    sessionMessageSubscribers: {} as unknown as SessionMessageSubscriberRegistry,
    chatAbortControllers: new Map(),
  });
}

const ALLOWLISTED_TOOL_LOOP = {
  type: "tool.loop" as const,
  sessionKey: "sk-octogee-1",
  sessionId: "session-1",
  toolName: "poll",
  level: "warning" as const,
  action: "warn" as const,
  detector: "known_poll_no_progress" as const,
  count: 3,
  message: "poll loop detected",
};

function diagnosticCalls(broadcast: ReturnType<typeof vi.fn>) {
  return broadcast.mock.calls.filter((c) => c[0] === "diagnostic");
}

describe("octogee fork: env-gated diagnostic-event broadcast", () => {
  let unsub: (() => void) | undefined;

  afterEach(() => {
    unsub?.();
    unsub = undefined;
    delete process.env.OPENCLAW_BROADCAST_DIAGNOSTIC_EVENTS;
    vi.restoreAllMocks();
  });

  it("env unset → no diagnostic broadcast (vanilla byte-identical)", () => {
    delete process.env.OPENCLAW_BROADCAST_DIAGNOSTIC_EVENTS;
    const broadcast = vi.fn();
    const subs = startSubs(broadcast);
    unsub = subs.diagnosticUnsub;
    emitDiagnosticEvent({ ...ALLOWLISTED_TOOL_LOOP });
    expect(diagnosticCalls(broadcast)).toHaveLength(0);
  });

  it("env set → allowlisted event broadcasts as { sessionKey, type, ts, data }", () => {
    process.env.OPENCLAW_BROADCAST_DIAGNOSTIC_EVENTS = "1";
    const broadcast = vi.fn();
    const subs = startSubs(broadcast);
    unsub = subs.diagnosticUnsub;
    emitDiagnosticEvent({ ...ALLOWLISTED_TOOL_LOOP });
    const calls = diagnosticCalls(broadcast);
    expect(calls).toHaveLength(1);
    const [, payload, opts] = calls[0];
    expect(payload).toMatchObject({
      sessionKey: "sk-octogee-1",
      type: "tool.loop",
    });
    expect(typeof (payload as { ts: unknown }).ts).toBe("number");
    expect((payload as { data: { type: string } }).data.type).toBe("tool.loop");
    expect(opts).toEqual({ dropIfSlow: true });
  });

  it("env set → non-allowlisted event does NOT broadcast", () => {
    process.env.OPENCLAW_BROADCAST_DIAGNOSTIC_EVENTS = "1";
    const broadcast = vi.fn();
    const subs = startSubs(broadcast);
    unsub = subs.diagnosticUnsub;
    emitDiagnosticEvent({ type: "model.usage", usage: { total: 1 } });
    expect(diagnosticCalls(broadcast)).toHaveLength(0);
  });

  it("env set → Hunk B session.execution_phase broadcasts (allowlisted)", () => {
    process.env.OPENCLAW_BROADCAST_DIAGNOSTIC_EVENTS = "1";
    const broadcast = vi.fn();
    const subs = startSubs(broadcast);
    unsub = subs.diagnosticUnsub;
    emitDiagnosticEvent({
      type: "session.execution_phase",
      sessionKey: "sk-octogee-1",
      phase: "model_call",
      provider: "anthropic",
      firstModelCallStarted: true,
    });
    const calls = diagnosticCalls(broadcast);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      sessionKey: "sk-octogee-1",
      type: "session.execution_phase",
    });
    expect((calls[0][1] as { data: { phase: string } }).data.phase).toBe("model_call");
  });

  it("env unset → Hunk B session.execution_phase does NOT broadcast", () => {
    delete process.env.OPENCLAW_BROADCAST_DIAGNOSTIC_EVENTS;
    const broadcast = vi.fn();
    const subs = startSubs(broadcast);
    unsub = subs.diagnosticUnsub;
    emitDiagnosticEvent({
      type: "session.execution_phase",
      sessionKey: "sk-octogee-1",
      phase: "model_call",
    });
    expect(diagnosticCalls(broadcast)).toHaveLength(0);
  });
});
