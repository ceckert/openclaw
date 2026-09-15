import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionParticipant } from "../../../../packages/gateway-protocol/src/schema/session-participant.js";
import { readTranscriptSenderIdentity } from "../../../../src/chat/sender-identity.js";
import { resolveMessageRole } from "../../lib/chat/message-normalizer.ts";
import { normalizeSenderIdentity, senderIdentityKey } from "../../lib/chat/sender-label.ts";

export function resolveChatParticipantLabels(
  participants: SessionParticipant[] | undefined,
  messages: readonly unknown[],
): SessionParticipant[] | undefined {
  const missing = new Set(
    (participants ?? []).flatMap(({ identity, label }) =>
      identity.type === "observation" && !label ? [senderIdentityKey({ identity })!] : [],
    ),
  );
  if (missing.size === 0) {
    return participants;
  }
  const labels = new Map<string, string>();
  for (let index = messages.length - 1; index >= 0 && missing.size > 0; index -= 1) {
    const message = messages[index];
    if (resolveMessageRole(message) !== "user") {
      continue;
    }
    const metadata = asOptionalRecord(asOptionalRecord(message)?.__openclaw);
    const sender = normalizeSenderIdentity({
      identity: metadata?.senderIdentity,
      id: metadata?.senderId,
      name: metadata?.senderName,
      username: metadata?.senderUsername,
    });
    if (!sender?.identity || sender.id !== sender.identity.id) {
      continue;
    }
    const observation =
      sender.identity.type === "profile"
        ? readTranscriptSenderIdentity(metadata?.senderObservation)
        : sender.identity;
    if (observation?.type !== "observation") {
      continue;
    }
    const key = senderIdentityKey({ identity: observation })!;
    const label = sender.name ?? sender.username;
    if (label && missing.delete(key)) {
      labels.set(key, label);
    }
  }
  return labels.size === 0
    ? participants
    : participants?.map((participant) => {
        const label = labels.get(senderIdentityKey({ identity: participant.identity })!);
        return !participant.label && label ? { ...participant, label } : participant;
      });
}
