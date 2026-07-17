// Mattermost plugin module owns draft-preview final delivery.
import {
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  isReasoningReplyPayload,
  isReplyPayloadNonTerminalToolErrorWarning,
} from "openclaw/plugin-sdk/reply-payload";
import {
  mergeVerifiedMattermostAgentRunProps,
  type MattermostAgentRunRefV3,
} from "./agent-run-ref.js";
import { fetchMattermostPost, updateMattermostPost, type MattermostClient } from "./client.js";
import { createMattermostDraftStream } from "./draft-stream.js";
import { canFinalizeMattermostPreviewInPlace } from "./monitor-context.js";
import type { ChatType, ReplyPayload } from "./runtime-api.js";

export type MattermostDraftPreviewState = {
  finalizedViaPreviewPost: boolean;
};

type MattermostDraftPreviewDeliverParams = {
  payload: ReplyPayload;
  info: { kind: "tool" | "block" | "final" };
  kind: ChatType;
  client: MattermostClient;
  draftStream: Pick<
    ReturnType<typeof createMattermostDraftStream>,
    "flush" | "postId" | "clear" | "discardPending" | "seal"
  >;
  effectiveReplyToId?: string;
  props?: Record<string, unknown>;
  resolvePreviewFinalText: (text?: string) => string | undefined;
  previewState: MattermostDraftPreviewState;
  logVerboseMessage: (message: string) => void;
  deliverPayload: (payload: ReplyPayload) => Promise<string | undefined | void>;
  // Visible same-thread finals can be delivered by editing the draft preview in
  // place (onPreviewFinalized) without ever calling deliverPayload; this lets the
  // caller record thread participation on that path too.
  recordThreadParticipation?: () => void;
};

// Octogee fork: replace a failed run's sole raw tool-error reply with warm
// coach copy and finalize the existing draft instead of deleting it.
export const MATTERMOST_TERMINAL_TOOL_ERROR_FALLBACK_TEXT =
  "⚠️ I hit a snag finishing that — the details are in the activity log.";

async function mergeCurrentMattermostRunProps(params: {
  client: MattermostClient;
  postId: string;
  expectedChannelId: string;
  expectedRootId?: string;
  nextProps: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const post = await fetchMattermostPost(params.client, params.postId);
  if (!post) {
    throw new Error("Mattermost run post is unavailable");
  }
  return mergeVerifiedMattermostAgentRunProps({
    post,
    expectedPostId: params.postId,
    expectedChannelId: params.expectedChannelId,
    expectedRootId: params.expectedRootId,
    nextProps: params.nextProps,
  });
}

export async function deliverMattermostReplyWithDraftPreview(
  params: MattermostDraftPreviewDeliverParams,
): Promise<{ primaryPostId?: string }> {
  if (isReasoningReplyPayload(params.payload)) {
    return {};
  }

  const terminalToolErrorOnlyReply =
    params.info.kind === "final" &&
    params.payload.isError === true &&
    !isReplyPayloadNonTerminalToolErrorWarning(params.payload);
  const deliveryPayload = terminalToolErrorOnlyReply
    ? { ...params.payload, text: MATTERMOST_TERMINAL_TOOL_ERROR_FALLBACK_TEXT }
    : params.payload;

  let deliveredPrimaryPostId: string | undefined;
  const result = await deliverWithFinalizableLivePreviewAdapter({
    kind: params.info.kind,
    payload: deliveryPayload,
    adapter: defineFinalizableLivePreviewAdapter<
      ReplyPayload,
      string,
      { message: string; props?: Record<string, unknown> }
    >({
      draft: {
        flush: params.draftStream.flush,
        clear: params.draftStream.clear,
        discardPending: params.draftStream.discardPending,
        seal: params.draftStream.seal,
        id: params.draftStream.postId,
      },
      buildFinalEdit: (payload) => {
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        const ttsSupplement = getReplyPayloadTtsSupplement(payload);
        const previewFinalText = params.resolvePreviewFinalText(
          payload.text ?? ttsSupplement?.spokenText,
        );

        if (
          (hasMedia && !ttsSupplement) ||
          typeof previewFinalText !== "string" ||
          (payload.isError && !terminalToolErrorOnlyReply) ||
          !canFinalizeMattermostPreviewInPlace({
            kind: params.kind,
            previewRootId: params.effectiveReplyToId,
            threadRootId: params.effectiveReplyToId,
            replyToId: payload.replyToId,
          })
        ) {
          return undefined;
        }
        return {
          message: previewFinalText,
          ...(params.props ? { props: params.props } : {}),
        };
      },
      editFinal: async (previewPostId, edit) => {
        const nextRef = edit.props?.octogee as MattermostAgentRunRefV3 | undefined;
        const props = nextRef
          ? await mergeCurrentMattermostRunProps({
              client: params.client,
              postId: previewPostId,
              expectedChannelId: nextRef.mainChannelId,
              expectedRootId: params.effectiveReplyToId,
              nextProps: edit.props!,
            })
          : edit.props;
        await updateMattermostPost(params.client, previewPostId, {
          message: edit.message,
          ...(props ? { props } : {}),
        });
      },
      onPreviewFinalized: () => {
        params.previewState.finalizedViaPreviewPost = true;
        // The visible final reply landed by editing the preview post, so the normal
        // deliverPayload record path is skipped; record participation explicitly here.
        params.recordThreadParticipation?.();
      },
      buildSupplementalPayload: (payload) =>
        getReplyPayloadTtsSupplement(payload) ? buildTtsSupplementMediaPayload(payload) : undefined,
      deliverSupplemental: async (payload) => {
        await params.deliverPayload(payload);
      },
      logPreviewEditFailure: (err) => {
        params.logVerboseMessage(
          `mattermost preview final edit failed; falling back to normal send (${String(err)})`,
        );
      },
    }),
    deliverNormally: async (payload) => {
      const supplement = getReplyPayloadTtsSupplement(payload);
      const postId = await params.deliverPayload(
        supplement && !payload.text?.trim() && supplement.visibleTextAlreadyDelivered !== true
          ? { ...payload, text: supplement.spokenText }
          : payload,
      );
      deliveredPrimaryPostId = typeof postId === "string" ? postId : undefined;
    },
  });
  return result.kind === "normal-delivered" && deliveredPrimaryPostId
    ? { primaryPostId: deliveredPrimaryPostId }
    : {};
}
