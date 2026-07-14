// Mattermost plugin module implements reply delivery behavior.
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import {
  deliverTextOrMediaReply,
  isReasoningReplyPayload,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type {
  ReplyDispatchKind,
  ReplyFollowupAdmissionBarrierTimeoutPolicy,
  ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
import {
  resolveMattermostReplyDeliveryBarrierTimeoutMs,
  type CreateDmChannelRetryOptions,
} from "./client.js";

type MarkdownTableMode = Parameters<PluginRuntime["channel"]["text"]["convertMarkdownTables"]>[1];

type SendMattermostMessage = (
  to: string,
  text: string,
  opts: {
    cfg: OpenClawConfig;
    accountId?: string;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    replyToId?: string;
    props?: Record<string, unknown>;
    onDmChannelResolution?: (resolution: PromiseLike<unknown>) => void;
  },
) => Promise<unknown>;

function primaryPostIdFromSendResult(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result = value as {
    messageId?: unknown;
    receipt?: { primaryPlatformMessageId?: unknown };
  };
  const receiptId = result.receipt?.primaryPlatformMessageId;
  if (typeof receiptId === "string" && receiptId.trim()) {
    return receiptId.trim();
  }
  return typeof result.messageId === "string" && result.messageId.trim()
    ? result.messageId.trim()
    : undefined;
}

export function createMattermostReplyDeliveryBarrier(params: {
  isDirect: boolean;
  dmRetryOptions?: CreateDmChannelRetryOptions;
}) {
  let activeDmChannelResolutions = 0;
  let queuedDeliveryCount = 0;
  let settledDeliveryCount = 0;
  const trackDmChannelResolution = (resolution: PromiseLike<unknown>) => {
    activeDmChannelResolutions += 1;
    void Promise.resolve(resolution).then(
      () => {
        activeDmChannelResolutions -= 1;
      },
      () => {
        activeDmChannelResolutions -= 1;
      },
    );
  };
  const markDeliverySettled = () => {
    settledDeliveryCount += 1;
  };
  const resolveTimeoutPolicy = (context: {
    queuedCounts: Readonly<Record<ReplyDispatchKind, number>>;
    humanDelayBudgetMs: number;
  }): ReplyFollowupAdmissionBarrierTimeoutPolicy | undefined => {
    const { queuedCounts } = context;
    queuedDeliveryCount = Object.values(queuedCounts).reduce((sum, count) => sum + count, 0);
    const maxTimeoutMs = resolveMattermostReplyDeliveryBarrierTimeoutMs({
      isDirect: params.isDirect,
      dmRetryOptions: params.dmRetryOptions,
      queuedCounts,
      humanDelayBudgetMs: context.humanDelayBudgetMs,
    });
    if (maxTimeoutMs === undefined) {
      return undefined;
    }
    return {
      maxTimeoutMs,
      shouldExtend: () =>
        activeDmChannelResolutions > 0 || settledDeliveryCount < queuedDeliveryCount,
    };
  };
  return {
    trackDmChannelResolution,
    markDeliverySettled,
    resolveTimeoutPolicy,
  };
}

/**
 * Result of `deliverMattermostReplyPayload`. Callers in `monitor.ts` use this
 * to distinguish a successful visible send from an intentionally suppressed
 * reasoning payload from a substantive payload that ended up sending nothing
 * (the silent-completion symptom in #80501).
 */
export type MattermostReplyDeliveryOutcome = "reasoning_skipped" | "empty" | "text" | "media";

export async function deliverMattermostReplyPayload(params: {
  core: PluginRuntime;
  cfg: OpenClawConfig;
  payload: ReplyPayload;
  to: string;
  accountId: string;
  agentId?: string;
  replyToId?: string;
  props?: Record<string, unknown>;
  textLimit: number;
  tableMode: MarkdownTableMode;
  sendMessage: SendMattermostMessage;
  onPrimaryPostId?: (postId: string) => Promise<void> | void;
  onDmChannelResolution?: (resolution: PromiseLike<unknown>) => void;
}): Promise<MattermostReplyDeliveryOutcome> {
  if (isReasoningReplyPayload(params.payload)) {
    return "reasoning_skipped";
  }
  const reply = resolveSendableOutboundReplyParts(params.payload, {
    text: params.core.channel.text.convertMarkdownTables(
      params.payload.text ?? "",
      params.tableMode,
    ),
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId);
  const chunkMode = params.core.channel.text.resolveChunkMode(
    params.cfg,
    "mattermost",
    params.accountId,
  );
  let primaryPostId: string | undefined;
  const capturePrimaryPostId = async (result: unknown): Promise<void> => {
    if (primaryPostId || !params.onPrimaryPostId) {
      return;
    }
    const postId = primaryPostIdFromSendResult(result);
    if (!postId) {
      throw new Error("Mattermost visible send returned no primary post receipt");
    }
    primaryPostId = postId;
    await params.onPrimaryPostId(postId);
  };
  return await deliverTextOrMediaReply({
    payload: params.payload,
    text: reply.text,
    chunkText: (value) =>
      params.core.channel.text.chunkMarkdownTextWithMode(value, params.textLimit, chunkMode),
    sendText: async (chunk) => {
      const result = await params.sendMessage(params.to, chunk, {
        cfg: params.cfg,
        accountId: params.accountId,
        replyToId: params.replyToId,
        ...(params.props ? { props: params.props } : {}),
        ...(params.onDmChannelResolution
          ? { onDmChannelResolution: params.onDmChannelResolution }
          : {}),
      });
      await capturePrimaryPostId(result);
    },
    sendMedia: async ({ mediaUrl, caption }) => {
      const result = await params.sendMessage(params.to, caption ?? "", {
        cfg: params.cfg,
        accountId: params.accountId,
        mediaUrl,
        mediaLocalRoots,
        replyToId: params.replyToId,
        ...(params.props ? { props: params.props } : {}),
        ...(params.onDmChannelResolution
          ? { onDmChannelResolution: params.onDmChannelResolution }
          : {}),
      });
      await capturePrimaryPostId(result);
    },
  });
}
