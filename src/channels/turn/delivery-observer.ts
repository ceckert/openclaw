import {
  isReplyPayloadTerminalContent,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isPlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import type { MessageSentEvent } from "../../infra/outbound/message-sent-hook.js";
import {
  isChannelPartialDeliveryError,
  resolveChannelDeliveryMessageId,
} from "./delivery-result.js";
import type { ChannelDeliveryInfo } from "./types.js";

export function emitChannelDeliveryFailure(
  payload: ReplyPayload,
  info: ChannelDeliveryInfo,
  error: unknown,
  emitMessageSent: ((event: MessageSentEvent) => void) | undefined,
): void {
  const partial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
  if (!isPlatformMessageNotDispatchedError(error)) {
    emitMessageSent?.({
      success: false,
      isFinalReply: info.kind === "final" && isReplyPayloadTerminalContent(payload),
      content: partial?.content ?? payload.text ?? "",
      error: formatErrorMessage(error),
      messageId: resolveChannelDeliveryMessageId(partial),
    });
  }
}
