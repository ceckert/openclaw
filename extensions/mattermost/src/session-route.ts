// Mattermost plugin module implements session route behavior.
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  resolveThreadSessionKeys,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMattermostAccount } from "./mattermost/accounts.js";

export type MattermostThreadSessionScope = "thread" | "channel";

export function resolveMattermostEffectiveReplyToId(params: {
  kind: "direct" | "group" | "channel";
  postId?: string | null;
  replyToMode: "off" | "first" | "all" | "batched";
  threadRootId?: string | null;
}): string | undefined {
  if (params.kind === "direct") {
    return undefined;
  }
  const threadRootId = params.threadRootId?.trim();
  if (threadRootId) {
    return threadRootId;
  }
  const postId = params.postId?.trim();
  if (!postId) {
    return undefined;
  }
  return params.replyToMode === "all" ||
    params.replyToMode === "first" ||
    params.replyToMode === "batched"
    ? postId
    : undefined;
}

export function resolveMattermostThreadSessionContext(params: {
  baseSessionKey: string;
  kind: "direct" | "group" | "channel";
  postId?: string | null;
  replyToMode: "off" | "first" | "all" | "batched";
  threadRootId?: string | null;
  threadSessionScope?: MattermostThreadSessionScope;
}): { effectiveReplyToId?: string; sessionKey: string; parentSessionKey?: string } {
  const effectiveReplyToId = resolveMattermostEffectiveReplyToId(params);
  if (effectiveReplyToId && params.threadSessionScope === "channel") {
    return { effectiveReplyToId, sessionKey: params.baseSessionKey };
  }
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: params.baseSessionKey,
    threadId: effectiveReplyToId,
    parentSessionKey: effectiveReplyToId ? params.baseSessionKey : undefined,
  });
  return {
    effectiveReplyToId,
    sessionKey: threadKeys.sessionKey,
    parentSessionKey: threadKeys.parentSessionKey,
  };
}

export function resolveMattermostOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  let trimmed = stripChannelTargetPrefix(params.target, "mattermost");
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const resolvedKind = params.resolvedTarget?.kind;
  const isUser =
    resolvedKind === "user" ||
    (resolvedKind !== "channel" &&
      resolvedKind !== "group" &&
      (lower.startsWith("user:") || trimmed.startsWith("@")));
  if (trimmed.startsWith("@")) {
    trimmed = trimmed.slice(1).trim();
  }
  const rawId = stripTargetKindPrefix(trimmed);
  if (!rawId) {
    return null;
  }
  const baseRoute = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "mattermost",
    accountId: params.accountId,
    peer: {
      kind: isUser ? "direct" : "channel",
      id: rawId,
    },
    chatType: isUser ? "direct" : "channel",
    from: isUser ? `mattermost:${rawId}` : `mattermost:channel:${rawId}`,
    to: isUser ? `user:${rawId}` : `channel:${rawId}`,
  });
  const threadedRoute = buildThreadAwareOutboundSessionRoute({
    route: baseRoute,
    replyToId: params.replyToId,
    threadId: params.threadId,
    currentSessionKey: params.currentSessionKey,
    canRecoverCurrentThread: ({ route }) =>
      route.chatType !== "direct" || (params.cfg.session?.dmScope ?? "main") !== "main",
  });
  const threadSessionScope = resolveMattermostAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    allowUnresolvedSecretRef: true,
  }).config.threadSessionScope;
  if (
    threadSessionScope === "channel" &&
    threadedRoute.chatType !== "direct" &&
    threadedRoute.threadId
  ) {
    return {
      ...threadedRoute,
      sessionKey: threadedRoute.baseSessionKey,
      parentSessionKey: undefined,
    };
  }
  return threadedRoute;
}
