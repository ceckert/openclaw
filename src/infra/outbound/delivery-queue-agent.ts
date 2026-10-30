import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { QueuedDeliveryPayload } from "./delivery-queue-types.js";

/** Explicit completion, execution and mirror dependencies all retain their agent. */
export function outboundDeliveryAgentIds(entry: QueuedDeliveryPayload): string[] {
  const completion = entry.deliveryCompletion;
  const ids = [completion?.agentId, entry.session?.agentId, entry.mirror?.agentId];
  if (completion?.kind === "pending-final" && !completion.agentId?.trim()) {
    ids.push(parseAgentSessionKey(completion.sessionKey)?.agentId);
  }
  return [...new Set(ids.flatMap((id) => (id?.trim() ? [normalizeAgentId(id)] : [])))];
}
