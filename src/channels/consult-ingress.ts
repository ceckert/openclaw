import { createHash, randomUUID } from "node:crypto";
import type { ReplyObserverCallbacks } from "../auto-reply/reply-observer.types.js";
import type { GatewayUiCommandTarget } from "../gateway/ui-command-target.types.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import type { ReplyPayload } from "../shared/reply-payload.types.js";

export type ChannelConsultIngressIdentity = {
  channel: string;
  accountId: string;
  channelId: string;
  senderId: string;
  agentId: string;
  sessionKey: string;
  text: string;
};
export type ChannelConsultIngressCallbacks = ReplyObserverCallbacks & {
  onFinalReply?: (payload: ReplyPayload) => void;
  onComplete?: () => void;
  onError?: (error: unknown) => void;
};
export type ChannelConsultIngressBinding = {
  context: { GatewayUiCommandTarget?: GatewayUiCommandTarget; GatewayClientCaps?: string[] };
  callbacks: ChannelConsultIngressCallbacks;
};
type Entry = {
  identity: Omit<ChannelConsultIngressIdentity, "text">;
  textHash: string;
  binding: ChannelConsultIngressBinding;
  isCurrent: () => boolean;
  expiresAt: number;
  dispose: () => void;
};
const attachments = resolveGlobalMap<string, Entry>(
  Symbol.for("openclaw.channelConsultIngress"),
  (entries) => {
    for (const entry of entries.values()) {
      entry.dispose();
    }
  },
  "close-and-restart",
);
const hashText = (text: string) => createHash("sha256").update(text).digest("hex");

export function registerChannelConsultIngress(params: {
  identity: ChannelConsultIngressIdentity;
  gatewayUiCommandTarget?: GatewayUiCommandTarget;
  gatewayClientCaps?: readonly string[];
  isCurrent: () => boolean;
  signal?: AbortSignal;
  callbacks: ChannelConsultIngressCallbacks;
}): { token: string; dispose: () => void } {
  params.signal?.throwIfAborted();
  if (!params.isCurrent()) {
    throw new Error("Channel consult requester is no longer active");
  }
  if (attachments.size >= 1024) {
    throw new Error("Too many pending channel consults");
  }
  const token = randomUUID();
  const { text, ...identity } = params.identity;
  const dispose = () => {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", dispose);
    attachments.delete(token);
  };
  const timer = setTimeout(() => {
    dispose();
    params.callbacks.onError?.(new Error("Channel consult admission expired"));
  }, 30_000);
  timer.unref();
  attachments.set(token, {
    identity: { ...identity },
    textHash: hashText(text),
    binding: {
      context: {
        ...(params.gatewayUiCommandTarget
          ? { GatewayUiCommandTarget: Object.freeze({ ...params.gatewayUiCommandTarget }) }
          : {}),
        ...(params.gatewayClientCaps ? { GatewayClientCaps: [...params.gatewayClientCaps] } : {}),
      },
      callbacks: { ...params.callbacks },
    },
    isCurrent: () => !params.signal?.aborted && params.isCurrent(),
    expiresAt: Date.now() + 30_000,
    dispose,
  });
  params.signal?.addEventListener("abort", dispose, { once: true });
  return { token, dispose };
}

export function consumeChannelConsultIngress(params: {
  token: unknown;
  identity: ChannelConsultIngressIdentity;
}): ChannelConsultIngressBinding | undefined {
  if (typeof params.token !== "string") {
    return undefined;
  }
  const entry = attachments.get(params.token);
  if (!entry) {
    return undefined;
  }
  if (Date.now() >= entry.expiresAt || !entry.isCurrent()) {
    entry.dispose();
    return undefined;
  }
  const { text, ...identity } = params.identity;
  if (
    Object.entries(entry.identity).some(
      // SAFETY: Keys come from the same identity projection retained at registration.
      ([key, value]) => identity[key as keyof typeof identity] !== value,
    ) ||
    hashText(text) !== entry.textHash
  ) {
    return undefined;
  }
  entry.dispose();
  return entry.binding;
}
