import { clearAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import { onDiagnosticEvent } from "../infra/diagnostic-events.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type {
  ChatRunState,
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
  ToolEventRecipientRegistry,
} from "./server-chat-state.js";

// ── octogee fork: diagnostic-event broadcast allowlist ──────────────────────
// The session-attention + recovery + loop family — all carry sessionKey?, so
// they run-correlate on the wire symmetrically with `sessions.changed`. The
// rest of the diagnostic firehose (memory/webhook/usage/heartbeat) stays
// in-process. Static type set, not logic. See ACTIVITY-HARNESS-SIGNAL-SPEC §1.
const OCTOGEE_DIAGNOSTIC_BROADCAST_TYPES = new Set<string>([
  "session.long_running",
  "session.stalled",
  "session.stuck",
  "session.recovery.requested",
  "session.recovery.completed",
  "tool.loop",
  "session.execution_phase",
]);

export function startGatewayEventSubscriptions(params: {
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
}) {
  let agentEventHandlerPromise: Promise<
    ReturnType<typeof import("./server-chat.js").createAgentEventHandler>
  > | null = null;
  const getAgentEventHandler = () => {
    agentEventHandlerPromise ??= Promise.all([
      import("./server-chat.js"),
      import("./server-session-key.js"),
    ]).then(([{ createAgentEventHandler }, { resolveSessionKeyForRun }]) =>
      createAgentEventHandler({
        broadcast: params.broadcast,
        broadcastToConnIds: params.broadcastToConnIds,
        nodeSendToSession: params.nodeSendToSession,
        agentRunSeq: params.agentRunSeq,
        chatRunState: params.chatRunState,
        resolveSessionKeyForRun,
        clearAgentRunContext,
        toolEventRecipients: params.toolEventRecipients,
        sessionEventSubscribers: params.sessionEventSubscribers,
        sessionMessageSubscribers: params.sessionMessageSubscribers,
        isChatSendRunActive: (runId) => {
          const entry = params.chatAbortControllers.get(runId);
          return entry !== undefined && entry.kind !== "agent";
        },
      }),
    );
    return agentEventHandlerPromise;
  };

  let transcriptUpdateHandlerPromise: Promise<
    ReturnType<typeof import("./server-session-events.js").createTranscriptUpdateBroadcastHandler>
  > | null = null;
  const getTranscriptUpdateHandler = () => {
    transcriptUpdateHandlerPromise ??= import("./server-session-events.js").then(
      ({ createTranscriptUpdateBroadcastHandler }) =>
        createTranscriptUpdateBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
          sessionMessageSubscribers: params.sessionMessageSubscribers,
        }),
    );
    return transcriptUpdateHandlerPromise;
  };

  let lifecycleEventHandlerPromise: Promise<
    ReturnType<typeof import("./server-session-events.js").createLifecycleEventBroadcastHandler>
  > | null = null;
  const getLifecycleEventHandler = () => {
    lifecycleEventHandlerPromise ??= import("./server-session-events.js").then(
      ({ createLifecycleEventBroadcastHandler }) =>
        createLifecycleEventBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
        }),
    );
    return lifecycleEventHandlerPromise;
  };

  const agentUnsub = onAgentEvent((evt) => {
    void getAgentEventHandler().then((handler) => handler(evt));
  });

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    params.broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  // ── octogee fork: env-gated diagnostic-event broadcast ────────────────────
  // OC emits the rich in-flight harness taxonomy (session attention / recovery
  // / tool-loop) on an in-process emitter with no WS surface. The sidecar IS
  // the intended consumer; opt in via a default-off env gate — the exact
  // OPENCLAW_BROADCAST_ALL_AGENT_RUNS precedent (Appendix A.5 / DECISIONS A10
  // amendment). Default-off → no listener registered → vanilla byte-identical.
  // onDiagnosticEvent already suppresses trusted + log.record events.
  const diagnosticUnsub =
    process.env.OPENCLAW_BROADCAST_DIAGNOSTIC_EVENTS === "1"
      ? onDiagnosticEvent((evt) => {
          if (!OCTOGEE_DIAGNOSTIC_BROADCAST_TYPES.has(evt.type)) {
            return;
          }
          params.broadcast(
            "diagnostic",
            {
              sessionKey: (evt as { sessionKey?: string }).sessionKey,
              type: evt.type,
              ts: evt.ts,
              data: evt,
            },
            { dropIfSlow: true },
          );
        })
      : () => {};

  const transcriptUnsub = onSessionTranscriptUpdate((evt) => {
    void getTranscriptUpdateHandler().then((handler) => handler(evt));
  });

  const lifecycleUnsub = onSessionLifecycleEvent((evt) => {
    void getLifecycleEventHandler().then((handler) => handler(evt));
  });

  return {
    agentUnsub,
    heartbeatUnsub,
    diagnosticUnsub,
    transcriptUnsub,
    lifecycleUnsub,
  };
}
