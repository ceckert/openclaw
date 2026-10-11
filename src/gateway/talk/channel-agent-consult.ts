import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
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
    assertCurrent?: () => void;
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
  const isCurrent = () => {
    try {
      params.assertCurrent?.();
      return (
        !params.signal?.aborted &&
        params.getVoiceSessionId() === params.voiceSessionId &&
        readUser() === authenticatedUserId
      );
    } catch {
      return false;
    }
  };
  const getAuthenticatedUserId = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
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
  let binding: Promise<void> | undefined;
  let bindingStarted = false;
  let bound = false;
  let closed = false;
  let failed = false;
  let abortBoundRun: (() => void) | undefined;
  let cleanup: (() => void) | undefined;
  try {
    const result = await adapter.run({
      prompt: params.prompt,
      signal: params.signal,
      bindRun: (runId) => {
        if (bindingStarted || closed) {
          throw new Error("Channel voice consult already bound a native run");
        }
        bindingStarted = true;
        const nativeRun = resolveActiveEmbeddedRunOwnerByRunId(runId);
        if (!nativeRun || nativeRun.sessionKey !== params.sessionKey) {
          throw new Error("Channel voice consult native run does not match its session");
        }
        let aborted = false;
        const abort = () => {
          if (!aborted) {
            aborted = true;
            nativeRun.abort();
          }
        };
        abortBoundRun = abort;
        params.signal?.addEventListener("abort", abort, { once: true });
        cleanup = () => params.signal?.removeEventListener("abort", abort);
        binding = (async () => {
          getAuthenticatedUserId();
          const pendingRegistration = consult.onRunStarted?.({
            runId,
            sessionId: nativeRun.sessionId,
            timeoutMs: consult.timeoutMs ?? 180_000,
          });
          let adopted = false;
          let adoptionError: unknown;
          try {
            adopted = params.adoptCompletion?.() ?? true;
          } catch (error) {
            adoptionError = error;
          }
          if (!adopted) {
            abort();
          }
          const registration = await pendingRegistration;
          cleanup = () => {
            registration?.abortSignal?.removeEventListener("abort", abort);
            params.signal?.removeEventListener("abort", abort);
            try {
              if (failed) {
                registration?.cleanupBeforeRun?.();
              }
            } finally {
              registration?.cleanup?.();
            }
          };
          if (!adopted) {
            if (adoptionError !== undefined) {
              throw toErrorObject(
                adoptionError,
                "Channel voice consult could not adopt native completion ownership",
              );
            }
            throw new Error("Channel voice consult could not adopt native completion ownership");
          }
          registration?.abortSignal?.addEventListener("abort", abort, { once: true });
          if (registration?.abortSignal?.aborted || params.signal?.aborted) {
            abort();
            throw new Error("Channel voice consult was interrupted during run binding");
          }
          getAuthenticatedUserId();
          bound = true;
        })();
        void binding.catch(() => undefined);
        return binding;
      },
    });
    await binding;
    if (!bound) {
      throw new Error("Channel voice consult did not bind a native run");
    }
    getAuthenticatedUserId();
    return result;
  } catch (error) {
    failed = true;
    abortBoundRun?.();
    await binding?.catch(() => undefined);
    throw error;
  } finally {
    closed = true;
    cleanup?.();
  }
}
