import { resolveActiveEmbeddedRunOwnerByRunId } from "../../agents/embedded-agent-runner/runs.js";
import { getCommandSenderAuthority } from "../../auto-reply/command-sender-authority.js";
import { registerChannelConsultIngress } from "../../channels/consult-ingress.js";
import type { RealtimeVoiceProviderPlugin } from "../../plugins/types.js";
import type { consultRealtimeVoiceAgent } from "../../talk/agent-consult-runtime.js";
import type { TalkAgentConsultAuthority } from "./client-gateway-control.js";

export async function runChannelAgentConsult(
  params: {
    createAdapter: NonNullable<RealtimeVoiceProviderPlugin["createAgentConsultAdapter"]>;
    agentId: string;
    sessionKey: string;
    voiceSessionId: string;
    getVoiceSessionId: () => string | undefined;
    authority: TalkAgentConsultAuthority;
    signal?: AbortSignal;
    prompt: string;
    adoptCompletion?: () => boolean;
  },
  consult: Parameters<typeof consultRealtimeVoiceAgent>[0],
): Promise<{ text: string }> {
  const readUser = () =>
    params.authority.replyCaller
      ? getCommandSenderAuthority(params.authority.replyCaller)?.()?.userId
      : undefined;
  const authenticatedUserId = readUser();
  if (!authenticatedUserId) {
    throw new Error("Channel voice consult requires an authenticated user");
  }
  const isCurrent = () =>
    !params.signal?.aborted &&
    params.getVoiceSessionId() === params.voiceSessionId &&
    readUser() === authenticatedUserId;
  const getAuthenticatedUserId = () => {
    params.signal?.throwIfAborted();
    if (
      params.getVoiceSessionId() !== params.voiceSessionId ||
      readUser() !== authenticatedUserId
    ) {
      throw new Error("Channel voice caller is no longer current");
    }
    return authenticatedUserId;
  };
  const adapter = params.createAdapter({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    getAuthenticatedUserId,
    getAuthenticatedVoiceSessionId: () => {
      getAuthenticatedUserId();
      return params.voiceSessionId;
    },
    attachChannelIngress: (identity, callbacks) => {
      getAuthenticatedUserId();
      return registerChannelConsultIngress({
        identity: { ...identity, agentId: params.agentId, sessionKey: params.sessionKey },
        gatewayUiCommandTarget: params.authority.gatewayUiCommandTarget,
        gatewayClientCaps: params.authority.replyCaller?.GatewayClientCaps,
        signal: params.signal,
        isCurrent,
        callbacks: {
          onAgentRunStart: (runId) => {
            getAuthenticatedUserId();
            callbacks.onRunStarted(runId);
          },
          onFinalReply: (payload) => {
            if (isCurrent() && payload.text) {
              callbacks.onReply(payload.text);
            }
          },
          onComplete: callbacks.onComplete,
          onError: callbacks.onError,
        },
      });
    },
  });
  let bound = false;
  let abortBoundRun: (() => void) | undefined;
  let cleanup: (() => void) | undefined;
  try {
    const result = await adapter.run({
      prompt: params.prompt,
      signal: params.signal,
      bindRun: (runId) => {
        if (bound) {
          throw new Error("Channel voice consult already bound a native run");
        }
        const nativeRun = resolveActiveEmbeddedRunOwnerByRunId(runId);
        if (!nativeRun || nativeRun.sessionKey !== params.sessionKey) {
          throw new Error("Channel voice consult native run does not match its session");
        }
        abortBoundRun = () => nativeRun.abort();
        if (params.signal?.aborted || params.getVoiceSessionId() !== params.voiceSessionId) {
          nativeRun.abort();
          throw new Error("Channel voice consult was interrupted before its run started");
        }
        getAuthenticatedUserId();
        const registration = consult.onRunStarted?.({
          runId,
          sessionId: nativeRun.sessionId,
          timeoutMs: consult.timeoutMs ?? 180_000,
        });
        if (params.adoptCompletion && !params.adoptCompletion()) {
          nativeRun.abort();
          registration?.cleanup?.();
          throw new Error("Channel voice consult could not adopt native completion ownership");
        }
        const abort = abortBoundRun;
        registration?.abortSignal?.addEventListener("abort", abort, { once: true });
        params.signal?.addEventListener("abort", abort, { once: true });
        cleanup = () => {
          registration?.abortSignal?.removeEventListener("abort", abort);
          params.signal?.removeEventListener("abort", abort);
          registration?.cleanup?.();
        };
        if (registration?.abortSignal?.aborted || params.signal?.aborted) {
          abort();
          throw new Error("Channel voice consult was interrupted during run binding");
        }
        bound = true;
      },
    });
    if (!bound) {
      throw new Error("Channel voice consult did not bind a native run");
    }
    getAuthenticatedUserId();
    return result;
  } catch (error) {
    abortBoundRun?.();
    throw error;
  } finally {
    cleanup?.();
  }
}
