// Gateway event subscription wiring for agent, heartbeat, transcript, and lifecycle broadcasts.
import { clearAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import { onDiagnosticEvent } from "../infra/diagnostic-events.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import type { ChatAbortControllerEntry, RestartRecoveryCandidate } from "./chat-abort.js";
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
]);

/** Register gateway runtime event subscriptions and return unsubscribe handles. */
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
  restartRecoveryCandidates: Map<string, RestartRecoveryCandidate>;
}) {
  let agentEventHandlerPromise: Promise<
    ReturnType<typeof import("./server-chat.js").createAgentEventHandler>
  > | null = null;
  const getAgentEventHandler = () => {
    // Lazy-load heavy chat modules only after the first agent event reaches the gateway.
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
        clearTrackedActiveRun: ({ runId, clientRunId }) => {
          const candidateRunIds = runId === clientRunId ? [runId] : [runId, clientRunId];
          for (const candidateRunId of candidateRunIds) {
            const entry = params.chatAbortControllers.get(candidateRunId);
            // Chat abort entries can hold the requested key while chat run
            // state holds the canonical key; the run ids are the scoped match.
            if (entry) {
              entry.projectSessionActive = false;
              entry.projectSessionTerminalPending = false;
              entry.projectSessionTerminalPersisted = false;
              queueMicrotask(() => {
                const current = params.chatAbortControllers.get(candidateRunId);
                if (
                  current === entry &&
                  entry.registrationCleanupRequested === true &&
                  !entry.projectSessionTerminalPersistence
                ) {
                  params.chatAbortControllers.delete(candidateRunId);
                }
              });
            }
          }
        },
        markTrackedRunTerminalPersisted: ({ runId, clientRunId }) => {
          const candidateRunIds = runId === clientRunId ? [runId] : [runId, clientRunId];
          for (const candidateRunId of candidateRunIds) {
            params.restartRecoveryCandidates.delete(candidateRunId);
            const entry = params.chatAbortControllers.get(candidateRunId);
            if (entry) {
              entry.projectSessionTerminalPending = false;
              entry.projectSessionTerminalPersisted = true;
              entry.projectSessionTerminalPersistence = undefined;
            }
          }
        },
        trackTrackedRunTerminalPersistence: ({
          runId,
          clientRunId,
          sessionId: terminalSessionId,
          observedAt,
          persistence,
        }) => {
          const candidateRunIds = runId === clientRunId ? [runId] : [runId, clientRunId];
          for (const candidateRunId of candidateRunIds) {
            const entry = params.chatAbortControllers.get(candidateRunId);
            if (entry) {
              entry.projectSessionTerminalPending = false;
              entry.projectSessionTerminalPersistence = persistence;
              if (entry.registrationCleanupRequested === true) {
                void persistence
                  .catch(() => undefined)
                  .then(() => {
                    if (params.chatAbortControllers.get(candidateRunId) === entry) {
                      params.chatAbortControllers.delete(candidateRunId);
                    }
                  });
              }
              const lifecycleGeneration = entry.lifecycleGeneration?.trim();
              const sessionKey = entry.sessionKey.trim();
              const sessionId = terminalSessionId?.trim() || entry.sessionId.trim();
              if (
                entry.controlUiVisible !== false &&
                lifecycleGeneration &&
                sessionKey &&
                sessionId
              ) {
                void persistence.catch(() => {
                  params.restartRecoveryCandidates.set(candidateRunId, {
                    runId: candidateRunId,
                    lifecycleGeneration,
                    sessionKey,
                    sessionId,
                    observedAt,
                  });
                });
              }
            }
          }
        },
        isChatSendRunActive: (runId) => {
          const entry = params.chatAbortControllers.get(runId);
          return entry !== undefined && entry.kind !== "agent";
        },
        resolveActiveLifecycleGenerationForRun: (runId) =>
          params.chatAbortControllers.get(runId)?.lifecycleGeneration,
      }),
    );
    return agentEventHandlerPromise;
  };

  let sessionEventsModulePromise: Promise<typeof import("./server-session-events.js")> | null =
    null;
  const getSessionEventsModule = () => {
    sessionEventsModulePromise ??= import("./server-session-events.js");
    return sessionEventsModulePromise;
  };

  let transcriptUpdateHandlerPromise: Promise<
    ReturnType<typeof import("./server-session-events.js").createTranscriptUpdateBroadcastHandler>
  > | null = null;
  const getTranscriptUpdateHandler = () => {
    transcriptUpdateHandlerPromise ??= getSessionEventsModule().then(
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
    lifecycleEventHandlerPromise ??= getSessionEventsModule().then(
      ({ createLifecycleEventBroadcastHandler }) =>
        createLifecycleEventBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
        }),
    );
    return lifecycleEventHandlerPromise;
  };

  const agentUnsub = onAgentEvent((evt) => {
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string"
        ? evt.data.phase
        : undefined;
    if (lifecyclePhase === "end" || lifecyclePhase === "error") {
      const chatLink = params.chatRunState.registry.peek(evt.runId);
      const clientRunId = chatLink?.clientRunId ?? evt.runId;
      const candidateRunIds = evt.runId === clientRunId ? [evt.runId] : [evt.runId, clientRunId];
      for (const candidateRunId of candidateRunIds) {
        const entry = params.chatAbortControllers.get(candidateRunId);
        const eventLifecycleGeneration = evt.lifecycleGeneration?.trim();
        if (
          entry &&
          (!eventLifecycleGeneration ||
            !entry.lifecycleGeneration ||
            entry.lifecycleGeneration === eventLifecycleGeneration)
        ) {
          entry.projectSessionTerminalPending = true;
          entry.projectSessionTerminalObservedAt =
            typeof evt.data.endedAt === "number" && Number.isFinite(evt.data.endedAt)
              ? evt.data.endedAt
              : evt.ts;
        }
      }
    } else if (lifecyclePhase === "start") {
      const chatLink = params.chatRunState.registry.peek(evt.runId);
      const clientRunId = chatLink?.clientRunId ?? evt.runId;
      const candidateRunIds = evt.runId === clientRunId ? [evt.runId] : [evt.runId, clientRunId];
      const eventLifecycleGeneration = evt.lifecycleGeneration?.trim();
      for (const candidateRunId of candidateRunIds) {
        const entry = params.chatAbortControllers.get(candidateRunId);
        if (
          entry &&
          (!eventLifecycleGeneration ||
            !entry.lifecycleGeneration ||
            entry.lifecycleGeneration === eventLifecycleGeneration)
        ) {
          entry.projectSessionTerminalPending = false;
          entry.projectSessionTerminalObservedAt = undefined;
        }
      }
    }
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
